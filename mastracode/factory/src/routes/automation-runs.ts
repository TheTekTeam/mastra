/**
 * Mastra `apiRoutes` for trusted external orchestrators to enqueue an
 * idempotent, deferred skill dispatch against a Factory work item.
 *
 * The endpoint is a constrained ingress in front of
 * `WorkItemsStorage.commitRuleEvaluation()`: it commits exactly one
 * `invokeSkill` decision, stamps a non-human system actor, and leaves
 * execution (session creation, auto-run/approval policy, retry, restart
 * recovery) to the `FactoryDecisionDispatcher`.
 *
 * Idempotency: the `requestId` becomes the ingress identity, so replaying the
 * same request returns the prior result without inserting a second decision.
 * Tenant-mode enqueue callers must administer the organization; read-only
 * receipt lookups follow the existing signed-in, org-scoped project GET policy.
 * Local (no-auth) deployments use the shared `local` storage scope without
 * inventing a tenant user.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { AuditAction } from '../storage/domains/audit/actions.js';
import type { AuditTarget } from '../storage/domains/audit/base.js';
import type { AuditEmitter, AuditRecorder } from '../storage/domains/audit/domain.js';
import { auditRequestContext } from '../storage/domains/audit/domain.js';
import type { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';
import type { IssueCompletionReceipt } from '../storage/domains/work-items/completion-evidence.js';
import { FACTORY_ROUTE_CONTRACTS } from './contracts.js';
import { Route } from './route.js';
import type { RouteDependencies } from './route.js';

function loose(c: unknown): Context {
  return c as Context;
}

/** The invokeSkill payload this route commits, matched against a prior replay. */
interface AutomationInvokeSkillDecision {
  type: 'invokeSkill';
  idempotencyKey: string;
  role: string;
  skillName: string;
  arguments?: string;
}

/**
 * Whether a replayed rule-evaluation record describes the SAME operation as the
 * current request. `commitRuleEvaluation` keys idempotency on `(org, project,
 * ingress identity)` alone, so a reused `requestId` replays regardless of the
 * work item or decision payload. We reconstruct the prior `invokeSkill`
 * decision from the stored result and compare the item id, role, skill, and
 * arguments; any divergence is a collision, not a legitimate retry.
 */
function replayMatchesRequest(
  result: { itemId?: string | null; decisions?: unknown[] },
  itemId: string,
  request: AutomationInvokeSkillDecision,
): boolean {
  if (result.itemId != null && result.itemId !== itemId) return false;
  const decisions = Array.isArray(result.decisions) ? result.decisions : [];
  const prior = decisions.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as Record<string, unknown>).type === 'invokeSkill' &&
      (candidate as Record<string, unknown>).idempotencyKey === request.idempotencyKey,
  );
  if (!prior) return false;
  return (
    prior.role === request.role &&
    prior.skillName === request.skillName &&
    (prior.arguments ?? undefined) === (request.arguments ?? undefined)
  );
}

export interface AutomationRunRoutesDeps extends RouteDependencies {
  audit: AuditEmitter & AuditRecorder;
  /** Factory projects domain — validates the `:id` project belongs to the caller's org. */
  projects: FactoryProjectsStorage;
  /** Work-items domain backing `commitRuleEvaluation`. */
  workItems: WorkItemsStorage;
  /** Config version stamped on the committed rule evaluation. */
  configVersion: string;
  /**
   * Optional, independently authorized GitHub App/HP6 exact-head verifier.
   * No caller-provided 'verified' flag may ever satisfy this contract.
   * Default missing = fail closed, even if Factory storage has a candidate.
   * Must verify live issue/repo/PR/CI/review/merge/source snapshot, not stage.
   */
  verifyIssueCompletionEvidence?: (
    receipt: IssueCompletionReceipt,
    scope: { orgId: string; factoryProjectId: string; repositoryId: string },
  ) => Promise<boolean>;
}

/** Resolved ingress scope for an automation-run request. */
interface AutomationRunScope {
  orgId: string;
  userId: string;
  factoryProjectId: string;
}

export class AutomationRunRoutes extends Route<AutomationRunRoutesDeps> {
  /**
   * Resolve the signed-in org for reads; require org-admin for enqueue writes.
   * This mirrors project GET's tenant boundary without granting work creation.
   * Local no-auth mode continues to use the shared `local` scope.
   */
  async #resolveScope(
    c: Context,
    access: 'enqueue' | 'read',
  ): Promise<{ orgId: string; userId: string } | { response: Response }> {
    const { auth } = this.deps;
    if (!auth.enabled()) {
      return { orgId: 'local', userId: 'local' };
    }
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) return { response: c.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) {
      return {
        response: c.json(
          { error: 'organization_required', message: 'The Factory board requires an organization.' },
          403,
        ),
      };
    }
    if (access === 'enqueue' && !(await auth.isOrganizationAdmin(c, tenant.orgId))) {
      return {
        response: c.json(
          { error: 'forbidden', message: 'Organization administrator access is required for automation ingress.' },
          403,
        ),
      };
    }
    return { orgId: tenant.orgId, userId: tenant.userId };
  }

  /** Resolve a caller's authorized org AND its org-owned project from `:id`. */
  async #resolveProject(
    c: Context,
    access: 'enqueue' | 'read',
  ): Promise<AutomationRunScope | { response: Response }> {
    const scope = await this.#resolveScope(c, access);
    if ('response' in scope) return scope;

    const parsedPath = FACTORY_ROUTE_CONTRACTS.projectGet.pathSchema.safeParse({ id: c.req.param('id') });
    if (!parsedPath.success) {
      return { response: c.json({ error: 'Project not found' }, 404) };
    }
    const { projects } = this.deps;
    await projects.ensureReady();
    const project = await projects.get({ orgId: scope.orgId, id: parsedPath.data.id });
    if (!project) {
      return { response: c.json({ error: 'Project not found' }, 404) };
    }
    return { ...scope, factoryProjectId: parsedPath.data.id };
  }

  /**
   * Persist an audit event under the ingress-resolved scope. This route can run
   * under the synthetic `local` no-auth scope, where the tenant-gated
   * `audit.emit()` derives no org from the request and drops the event; writing
   * through `record()` with the explicit org + system actor keeps traceability
   * in every deployment mode.
   *
   * The `idempotencyKey` (`<action>:<requestId>`) makes the audit write itself
   * idempotent: replaying the same request re-enters this path, but the trail
   * keeps a single event per requestId instead of one duplicate per retry.
   */
  async #writeAudit(
    c: Context,
    scope: AutomationRunScope,
    action: AuditAction,
    requestId: string,
    targets: AuditTarget[],
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      idempotencyKey: `${action}:${requestId}`,
      orgId: scope.orgId,
      actorId: 'factory-external-orchestrator',
      actorType: 'system',
      action,
      targets,
      metadata,
      factoryProjectId: scope.factoryProjectId,
      context: auditRequestContext(c),
    });
  }

  routes(): ApiRoute[] {
    const { workItems, configVersion } = this.deps;
    const contract = FACTORY_ROUTE_CONTRACTS.workItemAutomationRun;
    const receiptContract = FACTORY_ROUTE_CONTRACTS.automationRunReceipt;
    const completionContract = FACTORY_ROUTE_CONTRACTS.issueCompletionEvidence;

    return [
      registerApiRoute(contract.path, {
        method: contract.method,
        handler: async c => {
          const context = loose(c);
          const resolved = await this.#resolveProject(context, 'enqueue');
          if ('response' in resolved) return resolved.response;

          const parsedPath = contract.pathSchema.safeParse({
            id: c.req.param('id'),
            workItemId: c.req.param('workItemId'),
          });
          if (!parsedPath.success) return c.json({ error: 'Work item not found' }, 404);

          const body = await c.req.json().catch(() => undefined);
          if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
          const parsed = contract.bodySchema.safeParse(body);
          if (!parsed.success) return c.json({ error: 'invalid_automation_run_request' }, 400);
          const request = parsed.data as {
            requestId: string;
            expectedRevision: number;
            role: string;
            skillName: string;
            arguments?: string;
          };

          const item = await workItems.getForProject(
            resolved.orgId,
            resolved.factoryProjectId,
            (parsedPath.data as { workItemId: string }).workItemId,
          );
          if (!item) return c.json({ error: 'Work item not found' }, 404);

          const idempotencyKey = `external-orchestrator:${request.requestId}`;
          const decision = {
            type: 'invokeSkill' as const,
            idempotencyKey,
            role: request.role,
            skillName: request.skillName,
            ...(request.arguments !== undefined ? { arguments: request.arguments } : {}),
          };

          const now = new Date();
          const commit = await workItems.commitRuleEvaluation({
            orgId: resolved.orgId,
            factoryProjectId: resolved.factoryProjectId,
            workItemId: item.id,
            ingress: { identity: idempotencyKey, triggerType: 'external-orchestrator.invoke-skill' },
            configVersion,
            expectedRevision: request.expectedRevision,
            actor: { type: 'system', id: 'factory-external-orchestrator' },
            outcome: { status: 'accepted' },
            decisions: [decision],
            causalChain: [],
            now,
          });

          if (commit.status === 'missing') return c.json({ error: 'Work item not found' }, 404);

          // A stale commit persists nothing, so the caller can retry the same
          // requestId once it has re-read the work item's revision.
          const result = (commit.status === 'stale' ? { status: 'rejected', code: 'stale' } : commit.result) as {
            status?: string;
            code?: string;
            itemId?: string | null;
            decisions?: unknown[];
          };
          const resultStatus = result.status ?? 'accepted';
          const code = typeof result.code === 'string' ? result.code : undefined;
          const targets = [{ type: 'work_item' as const, id: item.id, name: item.title }];

          const auditMetadata = {
            requestId: request.requestId,
            role: request.role,
            skillName: request.skillName,
            commitStatus: commit.status,
            resultStatus,
            ...(code ? { code } : {}),
          };

          // A replay only means "this request was already committed" — it must
          // be the SAME operation. If the caller reused a requestId against a
          // different work item, role, skill, or arguments, returning
          // `replayed` would report durable success for work that was never
          // enqueued. Reject the collision instead of silently swallowing it.
          if (commit.status === 'replayed' && !replayMatchesRequest(result, item.id, decision)) {
            await this.#writeAudit(context, resolved, 'factory.run.rejected', request.requestId, targets, {
              ...auditMetadata,
              resultStatus: 'rejected',
              code: 'request_id_conflict',
            });
            return c.json(
              {
                status: 'rejected',
                code: 'request_id_conflict',
                requestId: request.requestId,
              },
              409,
            );
          }

          if (resultStatus === 'accepted') {
            await this.#writeAudit(context, resolved, 'factory.run.queued', request.requestId, targets, auditMetadata);
            return c.json(
              { status: commit.status === 'replayed' ? 'replayed' : 'committed', requestId: request.requestId },
              commit.status === 'replayed' ? 200 : 202,
            );
          }

          await this.#writeAudit(context, resolved, 'factory.run.rejected', request.requestId, targets, auditMetadata);
          return c.json(
            { status: 'rejected', ...(code ? { code } : {}), requestId: request.requestId },
            code === 'stale' ? 409 : 422,
          );
        },
      }),
      registerApiRoute(completionContract.path, {
        method: completionContract.method,
        handler: async c => {
          // Final completion evidence is never public, even in deployments
          // that deliberately allow local unauthenticated project GETs.
          if (!this.deps.auth.enabled()) return c.json({ error: 'unauthorized' }, 401);
          const context = loose(c);
          const resolved = await this.#resolveProject(context, 'read');
          if ('response' in resolved) return resolved.response;
          const parsedPath = completionContract.pathSchema.safeParse({
            id: c.req.param('id'),
            workItemId: c.req.param('workItemId'),
          });
          if (!parsedPath.success) return c.json({ error: 'Issue completion evidence not found' }, 404);
          const result = await workItems.getIssueCompletionEvidence(
            resolved.orgId,
            resolved.factoryProjectId,
            parsedPath.data.workItemId,
          );
          if (result.kind === 'missing') return c.json({ error: 'Issue completion evidence not found' }, 404);
          if (result.kind !== 'found') {
            return c.json({ error: 'Issue completion evidence not independently verifiable' }, 409);
          }
          // The MCP readback already fences future-dated acceptance. Apply the
          // same fail-closed rule at the authenticated Factory source boundary.
          const acceptedAtMs = Date.parse(result.receipt.acceptedAt);
          if (!Number.isFinite(acceptedAtMs) || acceptedAtMs > Date.now()) {
            return c.json({ error: 'Issue completion evidence not independently verifiable' }, 409);
          }
          // A receipt from the local DB is only a *candidate*. The independent
          // authenticated GitHub/HP6 verifier is mandatory before HTTP 200.
          const verify = this.deps.verifyIssueCompletionEvidence;
          if (!verify) return c.json({ error: 'Issue completion evidence verifier unavailable' }, 409);
          try {
            if (!(await verify(result.receipt, {
              orgId: resolved.orgId,
              factoryProjectId: resolved.factoryProjectId,
              repositoryId: result.repositoryId,
            }))) {
              return c.json({ error: 'Issue completion evidence not independently verifiable' }, 409);
            }
          } catch {
            return c.json({ error: 'Issue completion evidence not independently verifiable' }, 409);
          }
          const validated = completionContract.responseSchema.safeParse(result.receipt);
          if (!validated.success) return c.json({ error: 'Issue completion evidence not independently verifiable' }, 409);
          return c.json(validated.data, 200);
        },
      }),
      registerApiRoute(receiptContract.path, {
        method: receiptContract.method,
        handler: async c => {
          const context = loose(c);
          const resolved = await this.#resolveProject(context, 'read');
          if ('response' in resolved) return resolved.response;

          const parsedPath = receiptContract.pathSchema.safeParse({
            id: c.req.param('id'),
            requestId: c.req.param('requestId'),
          });
          if (!parsedPath.success) return c.json({ error: 'Enqueue receipt not found' }, 404);

          const result = await workItems.getEnqueueReceipt(
            resolved.orgId,
            resolved.factoryProjectId,
            parsedPath.data.requestId,
          );
          if (result.kind === 'found') {
            // Revalidate the persisted binding at the wire boundary. A damaged
            // but hash-consistent row must not become a successful receipt.
            const validated = receiptContract.responseSchema.safeParse(result.receipt);
            if (!validated.success || validated.data.skillName !== result.receipt.skillName) {
              return c.json({ error: 'Enqueue receipt not independently verifiable' }, 409);
            }
            return c.json(validated.data);
          }
          if (result.kind === 'missing') return c.json({ error: 'Enqueue receipt not found' }, 404);
          return c.json({ error: 'Enqueue receipt not independently verifiable' }, 409);
        },
      }),
    ];
  }
}

export function buildAutomationRunRoutes(deps: AutomationRunRoutesDeps): ApiRoute[] {
  return new AutomationRunRoutes(deps).routes();
}
