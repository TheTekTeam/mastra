import { randomBytes } from 'node:crypto';

import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';

/**
 * PM #36: default-inert authenticated thread-origin candidate issuer.
 *
 * This domain is NOT registered by the Factory runtime. A candidate is never
 * an execution authorization: only a future Core thread-persistence callback
 * can independently reconcile it after writing an authoritative memory row.
 * Historical sessions have no such proof and remain UNKNOWN.
 */
export const FACTORY_EXECUTION_ORIGINS_SCHEMA: CollectionSchema = {
  name: 'factory_execution_origin_candidates',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    user_id: { type: 'text' },
    session_id: { type: 'text' },
    source_row_id: { type: 'text' },
    resource_id: { type: 'text' },
    thread_id: { type: 'text' },
    anchor: { type: 'text' },
    request_id: { type: 'text' },
    kind_at_issue: { type: 'text' },
    state: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_execution_origin_thread_unique', columns: ['resource_id', 'thread_id'] },
    { name: 'factory_execution_origin_request_unique', columns: ['org_id', 'session_id', 'request_id'] },
    { name: 'factory_execution_origin_anchor_unique', columns: ['anchor'] },
  ],
  indexes: [
    { name: 'factory_execution_origin_project_idx', columns: ['org_id', 'factory_project_id', 'state'] },
  ],
};

export const FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA: CollectionSchema = {
  name: 'factory_execution_unknown_origins',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    user_id: { type: 'text' },
    session_id: { type: 'text' },
    reason: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_execution_unknown_session_unique', columns: ['org_id', 'session_id'] },
  ],
};

// No positive managed/unmanaged/personal classification is issued by this inert slice.
export type FactoryExecutionOriginKind = 'unverified';
type OriginState = 'pending_memory_effect' | 'effect_unverified' | 'verified';
type UnknownOriginReason = 'legacy_missing_server_anchor' | 'nullable_project' | 'untrusted_scope';

interface SourceSessionRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  org_id: string;
  user_id: string;
  factory_project_id: string | null;
  visibility: string | null;
  branch: string;
  origin_session_id: string | null;
}

interface OriginRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  user_id: string;
  session_id: string;
  source_row_id: string;
  resource_id: string;
  thread_id: string;
  anchor: string;
  request_id: string;
  kind_at_issue: FactoryExecutionOriginKind;
  state: OriginState;
  created_at: Date;
  updated_at: Date;
}

interface UnknownRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  user_id: string;
  session_id: string;
  reason: UnknownOriginReason;
  created_at: Date;
}

/**
 * The verified BetterAuth resolver is supplied by a future authenticated
 * server-only integration, never inferred from a request body or thread
 * metadata. Returning null must fail closed. This slice exposes no route.
 */
export type ResolveVerifiedFactoryPrincipal = (privateServerContext: unknown) =>
  Promise<{ orgId: string; userId: string } | null>;

export type OriginCandidateResult =
  | { status: 'pending_memory_effect'; threadId: string; resourceId: string; anchor: string }
  | { status: 'denied' | 'unknown_source' | 'effect_unverified' | 'parent_unverified' };

function canonical(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= 256;
}

function newOpaqueAnchor(): string {
  return randomBytes(32).toString('hex');
}

export class FactoryExecutionOriginStorage extends FactoryStorageDomain {
  readonly #resolvePrincipal: ResolveVerifiedFactoryPrincipal;

  constructor(resolvePrincipal: ResolveVerifiedFactoryPrincipal) {
    super('execution-origin');
    this.#resolvePrincipal = resolvePrincipal;
  }

  async init(): Promise<void> {
    await this.ensureCollections([FACTORY_EXECUTION_ORIGINS_SCHEMA, FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    throw new Error('Factory origin evidence requires reconciliation; bulk clearance is not permitted');
  }

  /**
   * The ONLY issuer in B2a. It accepts no caller-provided project, organization,
   * user, resource, thread ID, classification, metadata stamp or token. The
   * trusted source DB row and verified BetterAuth principal must agree.
   *
   * Future B2b Core owns the thread persistence. Until then this candidate
   * stays pending and MUST NOT populate a positive B1 execution scope.
   */
  async issueNewSourceThread(input: {
    privateServerContext: unknown;
    sessionId: string;
    requestId: string;
    /** Optional clone source; never trust it without a VERIFIED origin. */
    parentThreadId?: string;
  }): Promise<OriginCandidateResult> {
    // JavaScript callers cannot inject a forged thread/project/identity through
    // an excess property even if they bypass TypeScript's object checking.
    const claims = input as Record<string, unknown>;
    if (['orgId', 'projectId', 'userId', 'resourceId', 'threadId', 'factorySessionId',
      'metadata', 'kind', 'classification', 'anchor'].some(key => Object.hasOwn(claims, key))) {
      return { status: 'denied' };
    }
    if (!canonical(input.sessionId) || !canonical(input.requestId) ||
      (input.parentThreadId !== undefined && !canonical(input.parentThreadId))) return { status: 'denied' };
    const principal = await this.#resolvePrincipal(input.privateServerContext);
    if (!principal || !canonical(principal.orgId) || !canonical(principal.userId)) return { status: 'denied' };

    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      const source = await ops.findOne<SourceSessionRow>('source_control_sessions', { session_id: input.sessionId });
      if (!source || source.org_id !== principal.orgId || source.user_id !== principal.userId) {
        return { status: 'denied' as const };
      }
      const prior = await ops.findOne<OriginRow>(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {
        org_id: principal.orgId, session_id: input.sessionId, request_id: input.requestId,
      });
      if (prior) return { status: 'effect_unverified' as const }; // Never replay an uncertain memory creation.
      // A historical session explicitly quarantined before B2b activation
      // cannot be reclassified by submitting a new client request ID.
      if (await ops.findOne(FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA.name, {
        org_id: principal.orgId, session_id: input.sessionId,
      })) return { status: 'unknown_source' as const };
      const projectId = source.factory_project_id;
      if (!projectId || !(await ops.findOne('factory_projects', { org_id: principal.orgId, id: projectId }))) {
        await this.#recordUnknown(ops, source, projectId ? 'untrusted_scope' : 'nullable_project');
        return { status: 'unknown_source' as const };
      }
      // Legacy, side-session and Slack resource ownership is not sufficiently
      // proven by a client-writable factorySessionId or inferred branch.
      // B2b must provide server-owned origin for those alternate entrypoints.
      if (source.origin_session_id || source.branch?.startsWith('slack/') ||
        (source.visibility !== 'org' && source.visibility !== 'private')) {
        await this.#recordUnknown(ops, source, 'untrusted_scope');
        return { status: 'unknown_source' as const };
      }
      if (input.parentThreadId) {
        const parent = await ops.findOne<OriginRow>(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {
          org_id: principal.orgId, factory_project_id: projectId, session_id: input.sessionId,
          thread_id: input.parentThreadId,
        });
        if (!parent || parent.state !== 'verified') return { status: 'parent_unverified' as const };
      }
      // B1 never arms a project. Even once it does, management adoption is a
      // *live* epoch decision, not a bypass based on this immutable issue-kind.
      const threadId = newOpaqueAnchor();
      const anchor = newOpaqueAnchor();
      const resourceId = source.visibility === 'org' ? projectId : source.user_id;
      const now = new Date();
      await ops.insertOne<OriginRow>(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {
        org_id: principal.orgId, factory_project_id: projectId, user_id: source.user_id,
        session_id: input.sessionId, source_row_id: source.id, resource_id: resourceId,
        thread_id: threadId, anchor, request_id: input.requestId, kind_at_issue: 'unverified',
        state: 'pending_memory_effect', created_at: now, updated_at: now,
      });
      return { status: 'pending_memory_effect' as const, threadId, resourceId, anchor };
    });
  }

  async #recordUnknown(ops: FactoryStorageOps, source: SourceSessionRow, reason: UnknownOriginReason): Promise<void> {
    if (await ops.findOne(FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA.name, {
      org_id: source.org_id, session_id: source.session_id,
    })) return;
    await ops.insertOne<UnknownRow>(FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA.name, {
      org_id: source.org_id, user_id: source.user_id, session_id: source.session_id,
      reason, created_at: new Date(),
    });
  }

  /**
   * Explicit migration-only quarantine. Every pre-B2b source session is UNKNOWN
   * even when its org, owner and project are known: none proves that a Core
   * thread was minted through the future trusted creation hook. Do not infer
   * classification by scanning client-writable thread IDs or metadata stamps.
   *
   * Not registered or invoked by Factory in B2a. A future operator-gated
   * migration must run this BEFORE enabling any new thread issuer.
   */
  async quarantineHistoricalSourceSessions({ orgId }: { orgId: string }): Promise<number> {
    if (!canonical(orgId)) throw new Error('Invalid migration org ID');
    return this.storage.withTransaction(async ops => {
      const sources = await ops.findMany<SourceSessionRow>('source_control_sessions', { org_id: orgId });
      for (const source of sources) {
        await this.#recordUnknown(ops, source, 'legacy_missing_server_anchor');
      }
      return sources.length;
    });
  }

  /**
   * Read-only inventory for future migration checks; no absence is interpreted
   * as personal or unmanaged provenance. Historical rows cannot be upgraded
   * from thread ID / metadata stamps alone.
   */
  async countUnknown({ orgId }: { orgId: string }): Promise<number> {
    if (!canonical(orgId)) throw new Error('Invalid unknown-origin inventory org ID');
    const rows = await this.ops.findMany<UnknownRow>(FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA.name, {
      org_id: orgId,
    });
    return rows.length;
  }
}
