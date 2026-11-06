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

import { createHash } from 'node:crypto';

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { AuditAction } from '../storage/domains/audit/actions.js';
import type { AuditTarget } from '../storage/domains/audit/base.js';
import type { AuditEmitter, AuditRecorder } from '../storage/domains/audit/domain.js';
import { auditRequestContext } from '../storage/domains/audit/domain.js';
import type { ServiceCapabilityAdmission, ServiceCapabilityAuthority } from '../service-capabilities/authority.js';
import type { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import type { WorkItemsStorage } from '../storage/domains/work-items/base.js';
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
  /** Opt-in, project-scoped service grant; never authorizes ordinary Factory routes. */
  serviceCapabilities?: ServiceCapabilityAuthority;
  audit: AuditEmitter & AuditRecorder;
  /** Factory projects domain — validates the `:id` project belongs to the caller's org. */
  projects: FactoryProjectsStorage;
  /** Work-items domain backing `commitRuleEvaluation`. */
  workItems: WorkItemsStorage;
  /** Config version stamped on the committed rule evaluation. */
  configVersion: string;
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

    return [
      registerApiRoute(contract.path, {
        method: contract.method,
        handler: async c => {
          const context = loose(c);
          const capabilities = this.deps.serviceCapabilities;
          const serviceCredential = capabilities?.hasServiceCredential(context.req.header('authorization')) ?? false;
          // Service tokens cannot enter the ordinary organization-admin route.
          const humanScope = serviceCredential ? undefined : await this.#resolveProject(context, 'enqueue');
          if (humanScope && 'response' in humanScope) return humanScope.response;

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

          let serviceAdmission: ServiceCapabilityAdmission | undefined;
          let resolved: AutomationRunScope;
          if (serviceCredential && capabilities) {
            try {
              const admitted = await capabilities.admit({
                authorization: context.req.header('authorization') ?? '',
                action: 'workItem.enqueue',
                projectId: parsedPath.data.id,
                workItemId: parsedPath.data.workItemId,
                requestId: request.requestId,
                bodyFingerprint: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
                role: request.role,
                skillName: request.skillName,
                argumentsDigest: createHash('sha256')
                  .update(JSON.stringify([request.arguments !== undefined, request.arguments ?? null]))
                  .digest('hex'),
              });
              if (admitted.status !== 'admitted') return c.json({ error: 'service_capability_denied' }, 403);
              serviceAdmission = admitted.admission;
              resolved = {
                orgId: serviceAdmission.orgId,
                userId: serviceAdmission.principalId,
                factoryProjectId: serviceAdmission.projectId,
              };
            } catch {
              return c.json({ error: 'service_admission_unavailable' }, 503);
            }
          } else if (humanScope && !('response' in humanScope)) {
            resolved = humanScope;
          } else {
            return c.json({ error: 'forbidden' }, 403);
          }
          const finishService = async (status: 'succeeded' | 'rejected', reason: string | null = null) => {
            if (!serviceAdmission || !capabilities) return true;
            try {
              await capabilities.finish(serviceAdmission, status, reason);
              return true;
            } catch {
              return false;
            }
          };
          const serviceOutcomeUnavailable = () => c.json({ status: 'EFFECT_UNVERIFIED', requestId: request.requestId }, 503);

          const item = await workItems.getForProject(
            resolved.orgId,
            resolved.factoryProjectId,
            (parsedPath.data as { workItemId: string }).workItemId,
          );
          if (!item) {
            if (!(await finishService('rejected', 'work_item_not_found'))) return serviceOutcomeUnavailable();
            return c.json({ error: 'Work item not found' }, 404);
          }

          const idempotencyKey = `external-orchestrator:${request.requestId}`;
          const decision = {
            type: 'invokeSkill' as const,
            idempotencyKey,
            role: request.role,
            skillName: request.skillName,
            ...(request.arguments !== undefined ? { arguments: request.arguments } : {}),
          };

          if (serviceAdmission && capabilities) {
            try {
              const started = await capabilities.beginEffect(serviceAdmission);
              if (!started) {
                if (!(await finishService('rejected', 'revoked_or_lease_expired_before_native_start'))) {
                  return serviceOutcomeUnavailable();
                }
                return c.json({ error: 'service_capability_revoked_or_expired' }, 403);
              }
            } catch {
              return serviceOutcomeUnavailable();
            }
          }
          const now = new Date();
          let commit: Awaited<ReturnType<WorkItemsStorage['commitRuleEvaluation']>>;
          try {
            commit = await workItems.commitRuleEvaluation({
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
          } catch (cause) {
            if (serviceAdmission && capabilities) {
              try { await capabilities.finish(serviceAdmission, 'effect_unverified', 'native_commit_exception'); } catch {}
              return serviceOutcomeUnavailable();
            }
            throw cause;
          }

          if (commit.status === 'missing') {
            if (!(await finishService('rejected', 'work_item_not_found'))) return serviceOutcomeUnavailable();
            return c.json({ error: 'Work item not found' }, 404);
          }

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
            if (serviceAdmission) {
              if (!(await finishService('rejected', 'request_id_conflict'))) return serviceOutcomeUnavailable();
            } else {
              await this.#writeAudit(context, resolved, 'factory.run.rejected', request.requestId, targets, {
                ...auditMetadata,
                resultStatus: 'rejected',
                code: 'request_id_conflict',
              });
            }
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
            if (serviceAdmission) {
              if (!(await finishService('succeeded', commit.status === 'replayed' ? 'verified_replay' : null))) {
                return serviceOutcomeUnavailable();
              }
            } else {
              await this.#writeAudit(context, resolved, 'factory.run.queued', request.requestId, targets, auditMetadata);
            }
            return c.json(
              { status: commit.status === 'replayed' ? 'replayed' : 'committed', requestId: request.requestId },
              commit.status === 'replayed' ? 200 : 202,
            );
          }

          if (serviceAdmission) {
            if (!(await finishService('rejected', code ?? resultStatus))) return serviceOutcomeUnavailable();
          } else {
            await this.#writeAudit(context, resolved, 'factory.run.rejected', request.requestId, targets, auditMetadata);
          }
          return c.json(
            { status: 'rejected', ...(code ? { code } : {}), requestId: request.requestId },
            code === 'stale' ? 409 : 422,
          );
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
