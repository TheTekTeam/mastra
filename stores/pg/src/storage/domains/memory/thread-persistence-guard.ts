import type { StorageThreadType } from '@mastra/core/memory';
import type { Queryable } from '../../db/run-fencing';

/**
 * Opt-in PostgreSQL thread writer capability. VERSION 1 is deliberately a
 * protocol only: no Factory policy or authenticated context provider is
 * installed by the PG package. A selected-project adopter MUST require a
 * positive capability from the exact memory backend and an external Core A2
 * pre-effect proof; merely registering this callback does not authorize work.
 */
export const PG_THREAD_PERSISTENCE_GUARD_VERSION = 1 as const;

export type PgThreadMutationOperation = 'save' | 'update' | 'copy' | 'move' | 'delete';

export interface PgThreadPersistenceMutation {
  operation: PgThreadMutationOperation;
  /** Authoritative DB thread state, never a request-supplied identity claim. */
  previous: StorageThreadType | null;
  /** Intended next state; null only for delete. Request metadata is untrusted. */
  proposed: StorageThreadType | null;
  /** Copy source must be read again inside the same transaction. */
  copySource?: StorageThreadType;
}

/**
 * The guard runs inside the very same PostgreSQL transaction as the native
 * thread write/clone/move. It may lock a project epoch row, verify a private
 * issuer token and assert immutable source-owner bindings with these queries.
 * Any throw rolls back the native write. The callback must fail closed when
 * server-private provenance is missing for a selected project, and must not
 * consult client stamps or assume unclassified means personal.
 *
 * A no-op callback is NOT safe for managed-project activation; the future
 * Factory adoption gate must independently attest its policy implementation.
 */
export interface PgThreadPersistenceGuardV1 {
  readonly version: typeof PG_THREAD_PERSISTENCE_GUARD_VERSION;
  beforeMutation(input: PgThreadPersistenceMutation & { transaction: Queryable }): Promise<void>;
}

export type PgThreadPersistenceGuardCapability =
  | { backend: 'postgres'; version: 1; installed: true; adoptionReady: false;
      operations: readonly PgThreadMutationOperation[] }
  | { backend: 'postgres'; version: 1; installed: false; adoptionReady: false;
      operations: readonly [] };

export const PG_THREAD_PERSISTENCE_GUARDED_OPERATIONS = [
  'save', 'update', 'copy', 'move', 'delete',
] as const satisfies readonly PgThreadMutationOperation[];
