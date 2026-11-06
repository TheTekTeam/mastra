import { AsyncLocalStorage } from 'node:async_hooks';

import type { PgThreadPersistenceGuardV1 } from '@mastra/pg';

import type { FactoryExecutionOriginStorage, OriginCandidateResult } from './base.js';

/**
 * B2b: inert server-only bridge between B2a issuance and an A0 PostgreSQL
 * thread INSERT. This is NOT registered by Factory and cannot authorize a
 * model/tool run, resume, management handover, or positive B1 scope.
 *
 * The opaque issuance context lives only in AsyncLocalStorage around the
 * server's memory write. No caller-supplied metadata, token, or thread claim is
 * accepted by the PG transaction callback.
 */
type PrivateIssue = {
  anchor: string;
  threadId: string;
  resourceId: string;
  consumed: boolean;
};

export class FactoryOriginMemoryReconciler {
  readonly #context = new AsyncLocalStorage<PrivateIssue>();
  readonly #issuer: FactoryExecutionOriginStorage;

  constructor(issuer: FactoryExecutionOriginStorage) {
    this.#issuer = issuer;
  }

  /**
   * A future trusted server integration must keep the callback and returned
   * candidate PRIVATE. Never echo the anchor/thread to an HTTP client before
   * the native PG memory write. A failed/ambiguous callback is never replayed.
   *
   * Even a returned callback result is EFFECT_UNVERIFIED until independently
   * read back from the same authoritative PG database after commit.
   */
  async issueAndWrite(
    input: Parameters<FactoryExecutionOriginStorage['issueNewSourceThread']>[0],
    writeNativeMemory: (thread: { id: string; resourceId: string }) => Promise<void>,
  ): Promise<Exclude<OriginCandidateResult, { status: 'pending_memory_effect' }> | { status: 'effect_unverified' }> {
    const issued = await this.#issuer.issueNewSourceThread(input);
    if (issued.status !== 'pending_memory_effect') return issued;

    const privateIssue: PrivateIssue = {
      anchor: issued.anchor,
      threadId: issued.threadId,
      resourceId: issued.resourceId,
      consumed: false,
    };
    // Do not retry an uncertain native write, including a timeout or rejection.
    await this.#context.run(privateIssue, () =>
      writeNativeMemory({ id: issued.threadId, resourceId: issued.resourceId }));
    return { status: 'effect_unverified' };
  }

  /**
   * Only for an isolated PG18 A0 callback. Without an in-process private
   * issuance context ALL operations fail. Installing this globally would
   * reject existing/nonselected traffic: adoptionReady remains false.
   *
   * The candidate transition and native thread INSERT share the exact PG
   * transaction. If INSERT or callback fails, both roll back. A response lost
   * after commit remains uncertain to the caller and must be reconciled, not
   * replayed. This proves memory-row provenance ONLY, not run execution safety.
   */
  readonly guard: PgThreadPersistenceGuardV1 = {
    version: 1,
    beforeMutation: async ({ operation, previous, proposed, transaction }) => {
      const issue = this.#context.getStore();
      if (!issue || issue.consumed || operation !== 'save' || previous ||
          !proposed || proposed.id !== issue.threadId || proposed.resourceId !== issue.resourceId) {
        throw new Error('Factory memory origin admission denied: no exact private pending issue');
      }
      issue.consumed = true;

      const candidate = await transaction.oneOrNone<{
        id: string; org_id: string; user_id: string; factory_project_id: string;
        session_id: string; source_row_id: string; resource_id: string; thread_id: string;
        state: string;
      }>(
        'SELECT id, org_id, user_id, factory_project_id, session_id, source_row_id, ' +
        'resource_id, thread_id, state FROM factory_execution_origin_candidates ' +
        'WHERE anchor = $1 FOR UPDATE', [issue.anchor]);
      if (!candidate || candidate.state !== 'pending_memory_effect' ||
          candidate.thread_id !== issue.threadId || candidate.resource_id !== issue.resourceId) {
        throw new Error('Factory memory origin admission denied: missing or consumed candidate');
      }

      // Re-read authoritative BetterAuth-owned source scope in the SAME write
      // transaction. An owner/project/visibility change between issue and
      // memory persist must not mint a verified origin. Source ownership is
      // locked for the duration of the native memory write.
      const source = await transaction.oneOrNone<{
        id: string; session_id: string; org_id: string; user_id: string;
        factory_project_id: string | null; visibility: string | null;
        origin_session_id: string | null; branch: string;
      }>(
        'SELECT id, session_id, org_id, user_id, factory_project_id, visibility, ' +
        'origin_session_id, branch FROM source_control_sessions WHERE id = $1 FOR SHARE',
        [candidate.source_row_id]);
      if (!source || source.session_id !== candidate.session_id ||
          source.org_id !== candidate.org_id || source.user_id !== candidate.user_id ||
          source.factory_project_id !== candidate.factory_project_id ||
          source.origin_session_id !== null || source.branch.startsWith('slack/') ||
          (source.visibility !== 'org' && source.visibility !== 'private') ||
          (source.visibility === 'org' ? source.factory_project_id : source.user_id) !== issue.resourceId) {
        throw new Error('Factory memory origin admission denied: source scope changed or unsupported');
      }
      const project = await transaction.oneOrNone<{ id: string }>(
        'SELECT id FROM factory_projects WHERE id = $1 AND org_id = $2 FOR SHARE',
        [candidate.factory_project_id, candidate.org_id]);
      const quarantined = await transaction.oneOrNone<{ id: string }>(
        'SELECT id FROM factory_execution_unknown_origins WHERE org_id = $1 AND session_id = $2',
        [candidate.org_id, candidate.session_id]);
      if (!project || quarantined) {
        throw new Error('Factory memory origin admission denied: project missing or origin quarantined');
      }

      const changed = await transaction.oneOrNone<{ id: string }>(
        'UPDATE factory_execution_origin_candidates SET state = $1, updated_at = clock_timestamp() ' +
        'WHERE id = $2 AND state = $3 RETURNING id',
        ['verified', candidate.id, 'pending_memory_effect']);
      if (!changed) throw new Error('Factory memory origin admission denied: stale candidate');
    },
  };
}
