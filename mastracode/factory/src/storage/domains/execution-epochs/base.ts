import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';

/**
 * Inert 0.25 foundation for the Factory-native execution fence (PM #36).
 *
 * Nothing registers this domain on a production Factory instance. Even if a
 * future caller registers it, newly provisioned project epochs are UNARMED.
 * Only the separately reviewed Core hook may eventually attest coverage and
 * arm an epoch. A database row or a caller's epoch string is not such proof.
 */
export const FACTORY_EXECUTION_EPOCHS_SCHEMA: CollectionSchema = {
  name: 'factory_execution_epochs',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    revision: { type: 'integer', default: 0 },
    state: { type: 'text', default: 'native' },
    fence_armed: { type: 'boolean', default: false },
    // Only a future native Core coverage verifier may populate these.
    coverage_version: { type: 'integer', default: 0 },
    mapping_revision: { type: 'integer', default: 0 },
    mapping_digest: { type: 'text', nullable: true },
    owner_epoch: { type: 'text', nullable: true },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_execution_epoch_project_unique', columns: ['org_id', 'factory_project_id'] },
  ],
};

export const FACTORY_EXECUTION_SCOPES_SCHEMA: CollectionSchema = {
  name: 'factory_execution_scopes',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    session_id: { type: 'text' },
    resource_id: { type: 'text' },
    thread_id: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    // A given source thread cannot be reclassified as another org/project/session.
    { name: 'factory_execution_scope_thread_unique', columns: ['resource_id', 'thread_id'] },
  ],
  indexes: [
    { name: 'factory_execution_scope_project_idx', columns: ['org_id', 'factory_project_id'] },
  ],
};

export const FACTORY_EXECUTION_RESERVATIONS_SCHEMA: CollectionSchema = {
  name: 'factory_execution_reservations',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    session_id: { type: 'text' },
    resource_id: { type: 'text' },
    thread_id: { type: 'text' },
    run_id: { type: 'text' },
    attempt_id: { type: 'text' },
    phase: { type: 'text' },
    epoch_revision: { type: 'integer' },
    state: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    // Replaying an admission attempt cannot start a second effect.
    { name: 'factory_execution_attempt_unique', columns: ['org_id', 'factory_project_id', 'attempt_id'] },
  ],
  indexes: [
    { name: 'factory_execution_reservation_project_idx', columns: ['org_id', 'factory_project_id', 'state'] },
    { name: 'factory_execution_reservation_run_idx', columns: ['org_id', 'factory_project_id', 'run_id'] },
  ],
};

export const FACTORY_EXECUTION_SETTLEMENTS_SCHEMA: CollectionSchema = {
  name: 'factory_execution_settlements',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    reservation_id: { type: 'text' },
    receipt_id: { type: 'text' },
    proof_digest: { type: 'text' },
    proof_kind: { type: 'text' },
    producer_id: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_execution_settlement_reservation_unique', columns: ['reservation_id'] },
    { name: 'factory_execution_settlement_receipt_unique', columns: ['receipt_id'] },
  ],
  indexes: [{ name: 'factory_execution_settlement_project_idx', columns: ['org_id', 'factory_project_id'] }],
};

/**
 * Independent, immutable evidence retrieved by an injected SERVER-ONLY
 * verifier, not a body supplied to settleWithProof. No production verifier is
 * installed by this inert slice.
 */
export interface TrustedEffectReceipt {
  receiptId: string;
  orgId: string; projectId: string; sessionId: string; resourceId: string; threadId: string;
  runId: string; attemptId: string; phase: 'start' | 'resume'; epochRevision: number;
  proofDigest: string; producerId: string;
  proofKind: 'definitive_no_effect' | 'terminal_effect';
  allExternalEffectsReconciled: boolean;
}
export type ResolveTrustedEffectReceipt = (ops: FactoryStorageOps, receiptId: string) =>
  Promise<TrustedEffectReceipt | null>;

type EpochState = 'native' | 'quiescing';
type ReservationPhase = 'start' | 'resume';
type ReservationState = 'reserved' | 'running' | 'suspended' | 'unknown' | 'settled';

interface EpochRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  revision: number;
  state: EpochState;
  fence_armed: boolean;
  coverage_version: number;
  mapping_revision: number;
  mapping_digest: string | null;
  owner_epoch: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ScopeRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  session_id: string;
  resource_id: string;
  thread_id: string;
  created_at: Date;
}

interface SettlementRow extends Record<string, unknown> {
  id: string; org_id: string; factory_project_id: string;
  reservation_id: string; receipt_id: string; proof_digest: string;
  proof_kind: string; producer_id: string; created_at: Date;
}

interface ReservationRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  session_id: string;
  resource_id: string;
  thread_id: string;
  run_id: string;
  attempt_id: string;
  phase: ReservationPhase;
  epoch_revision: number;
  state: ReservationState;
  created_at: Date;
  updated_at: Date;
}

const EPOCHS = FACTORY_EXECUTION_EPOCHS_SCHEMA.name;
const SCOPES = FACTORY_EXECUTION_SCOPES_SCHEMA.name;
const RESERVATIONS = FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name;
const SETTLEMENTS = FACTORY_EXECUTION_SETTLEMENTS_SCHEMA.name;
const blocksHandover = (state: ReservationState): boolean => state !== 'settled';

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Factory execution epoch revision exhausted');
  return next;
}

function assertIdentity(values: Record<string, string>): void {
  if (Object.values(values).some(value => !value || value.trim() !== value)) {
    throw new Error('Factory execution identity must contain nonempty canonical strings');
  }
}

export class FactoryExecutionEpochStorage extends FactoryStorageDomain {
  readonly #resolveTrustedReceipt?: ResolveTrustedEffectReceipt;

  constructor(resolveTrustedReceipt?: ResolveTrustedEffectReceipt) {
    super('execution-epochs');
    this.#resolveTrustedReceipt = resolveTrustedReceipt;
  }

  async dangerouslyClearAll(): Promise<void> {
    // Unknown effects are durable evidence; clearing them can falsely prove
    // that a managed project is drained. No ordinary test or reset may erase.
    throw new Error('Factory native execution reservations require explicit reconciliation, not bulk deletion');
  }

  async init(): Promise<void> {
    await this.ensureCollections([
      FACTORY_EXECUTION_EPOCHS_SCHEMA,
      FACTORY_EXECUTION_SCOPES_SCHEMA,
      FACTORY_EXECUTION_RESERVATIONS_SCHEMA,
      FACTORY_EXECUTION_SETTLEMENTS_SCHEMA,
    ]);
  }

  /**
   * Creates an UNARMED epoch for one verified existing Factory project.
   * This does not adopt a project or authorize any execution/handover.
   */
  async provisionUnarmed({ orgId, projectId }: { orgId: string; projectId: string }): Promise<'created' | 'exists' | 'not_found'> {
    assertIdentity({ orgId, projectId });
    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      if (!(await ops.findOne('factory_projects', { org_id: orgId, id: projectId }))) return 'not_found';
      if (await ops.findOne<EpochRow>(EPOCHS, { org_id: orgId, factory_project_id: projectId })) return 'exists';
      const now = new Date();
      await ops.insertOne<EpochRow>(EPOCHS, {
        org_id: orgId, factory_project_id: projectId, revision: 0, state: 'native',
        fence_armed: false, coverage_version: 0, mapping_revision: 0, mapping_digest: null,
        owner_epoch: null, created_at: now, updated_at: now,
      });
      return 'created';
    });
  }

  /**
   * Immutable positive binding. Unbound is NOT evidence that an execution is
   * personal: future Core adapters must derive affiliation from authoritative
   * Factory rows and fail closed on ambiguous/unmapped project work.
   */
  async bindThread(input: {
    orgId: string; projectId: string; sessionId: string; resourceId: string; threadId: string;
  }): Promise<'bound' | 'existing' | 'conflict' | 'not_ready'> {
    assertIdentity(input);
    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      const epoch = await ops.findOne<EpochRow>(EPOCHS, {
        org_id: input.orgId, factory_project_id: input.projectId,
      });
      if (!epoch || epoch.state !== 'native') return 'not_ready';
      const bound = await ops.findOne<ScopeRow>(SCOPES, {
        resource_id: input.resourceId, thread_id: input.threadId,
      });
      if (bound) {
        return bound.org_id === input.orgId &&
          bound.factory_project_id === input.projectId &&
          bound.session_id === input.sessionId
          ? 'existing' : 'conflict';
      }
      await ops.insertOne<ScopeRow>(SCOPES, {
        org_id: input.orgId, factory_project_id: input.projectId,
        session_id: input.sessionId, resource_id: input.resourceId,
        thread_id: input.threadId, created_at: new Date(),
      });
      // A newly discovered thread invalidates any previously attested complete
      // mapping. Increment under the same transaction as the immutable insert.
      let mappingAdvanced = false;
      await ops.updateAtomic<EpochRow>(EPOCHS, {
        org_id: input.orgId, factory_project_id: input.projectId,
      }, row => {
        if (row.state !== 'native') return null;
        mappingAdvanced = true;
        return { mapping_revision: nextRevision(row.mapping_revision), fence_armed: false,
          coverage_version: 0, mapping_digest: null, updated_at: new Date() };
      });
      // updateAtomic(null) returns the original row on PostgreSQL; use an
      // explicit callback result, not row truthiness, to detect rejection.
      if (!mappingAdvanced) throw new Error('Factory execution epoch changed while binding a source thread');
      return 'bound';
    });
  }

  /**
   * Internal transaction boundary only. NOT WIRED to any Agent/route/scheduler.
   * A future Core hook must supply a stable independently verified thread/run.
   * Duplicate attempt IDs are denied, never transparently replayed.
   */
  async reserveNative(input: {
    orgId: string; projectId: string; sessionId: string; resourceId: string; threadId: string;
    runId: string; attemptId: string; phase: ReservationPhase;
  }): Promise<{ status: 'reserved'; reservationId: string; revision: number } | { status: 'denied' | 'not_ready' | 'duplicate' }> {
    assertIdentity({ ...input, phase: input.phase });
    if (input.phase !== 'start' && input.phase !== 'resume') throw new Error('Invalid execution phase');
    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      const epoch = await ops.findOne<EpochRow>(EPOCHS, {
        org_id: input.orgId, factory_project_id: input.projectId,
      });
      if (!epoch || !epoch.fence_armed || epoch.coverage_version !== 1 || !epoch.mapping_digest)
        return { status: 'not_ready' as const };
      const scope = await ops.findOne<ScopeRow>(SCOPES, {
        resource_id: input.resourceId, thread_id: input.threadId,
      });
      if (!scope || scope.org_id !== input.orgId ||
          scope.factory_project_id !== input.projectId || scope.session_id !== input.sessionId ||
          epoch.state !== 'native') return { status: 'denied' as const };
      const prior = await ops.findOne<ReservationRow>(RESERVATIONS, {
        org_id: input.orgId, factory_project_id: input.projectId, attempt_id: input.attemptId,
      });
      if (prior) return { status: 'duplicate' as const };
      // A fresh attempt ID on a still-running/UNKNOWN native run is NOT a
      // legitimate new effect; must reconcile the existing attempt first.
      // The shared epoch-row CAS serializes concurrent attempts that both
      // initially see no row under PostgreSQL READ COMMITTED.
      const sameRun = await ops.findMany<ReservationRow>(RESERVATIONS, {
        org_id: input.orgId, factory_project_id: input.projectId, run_id: input.runId,
      });
      if (sameRun.some(row => blocksHandover(row.state))) return { status: 'duplicate' as const };
      // PostgreSQL READ COMMITTED must not allow reservation INSERT and an
      // overlapping quiescence UPDATE to commit independently. Both paths
      // first CAS/write this *same* epoch row under their DB transaction.
      let epochAdvanced = false;
      const reservedEpoch = await ops.updateAtomic<EpochRow>(EPOCHS, {
        org_id: input.orgId, factory_project_id: input.projectId,
      }, row => {
        if (row.revision !== epoch.revision || row.state !== 'native' ||
          !row.fence_armed || row.coverage_version !== 1 || !row.mapping_digest) return null;
        epochAdvanced = true;
        return { revision: nextRevision(row.revision), updated_at: new Date() };
      });
      if (!epochAdvanced || !reservedEpoch) return { status: 'denied' as const };
      const now = new Date();
      const reservation = await ops.insertOne<ReservationRow>(RESERVATIONS, {
        org_id: input.orgId, factory_project_id: input.projectId,
        session_id: input.sessionId, resource_id: input.resourceId, thread_id: input.threadId,
        run_id: input.runId, attempt_id: input.attemptId, phase: input.phase,
        epoch_revision: reservedEpoch.revision, state: 'reserved', created_at: now, updated_at: now,
      });
      return { status: 'reserved' as const, reservationId: reservation.id, revision: reservedEpoch.revision };
    });
  }

  /**
   * Only a separately reviewed Core coverage attestor may arm an epoch.
   * B1 offers no arming method or live import. This operation cannot return
   * quiescing for newly provisioned epochs.
   */
  async tryQuiesce(input: { orgId: string; projectId: string; expectedRevision: number; ownerEpoch: string }):
    Promise<'quiescing' | 'not_ready' | 'conflict' | 'blocked'> {
    assertIdentity({ orgId: input.orgId, projectId: input.projectId, ownerEpoch: input.ownerEpoch });
    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      const where = { org_id: input.orgId, factory_project_id: input.projectId };
      const epoch = await ops.findOne<EpochRow>(EPOCHS, where);
      if (!epoch?.fence_armed || epoch.coverage_version !== 1 || !epoch.mapping_digest) return 'not_ready';
      const reservations = await ops.findMany<ReservationRow>(RESERVATIONS, where);
      if (reservations.some(row => blocksHandover(row.state))) return 'blocked';
      if (epoch.revision !== input.expectedRevision || epoch.state !== 'native') return 'conflict';
      let quiesced = false;
      await ops.updateAtomic<EpochRow>(EPOCHS, where, row => {
        if (!row.fence_armed || row.coverage_version !== 1 || !row.mapping_digest ||
          row.state !== 'native' || row.revision !== input.expectedRevision) return null;
        quiesced = true;
        return { revision: nextRevision(row.revision), state: 'quiescing', owner_epoch: input.ownerEpoch, updated_at: new Date() };
      });
      return quiesced ? 'quiescing' : 'conflict';
    });
  }

  /**
   * B1b inert verified-settlement CAS. The receipt ID only locates an
   * independently durable, immutable source proof through an injected
   * SERVER-ONLY resolver. Caller assertions, process exit, timers and the
   * in-memory LiveSessions map are never sufficient.
   *
   * Lock order is project epoch CAS BEFORE reservation update. Every change
   * and append-only receipt binding commits atomically. No source registers
   * this domain/verifier in the Factory runtime.
   */
  async settleWithProof(input: {
    orgId: string; projectId: string; reservationId: string; receiptId: string;
  }): Promise<'settled' | 'already_settled' | 'not_ready' | 'needs_reconciliation' | 'conflict'> {
    assertIdentity(input);
    if (!this.#resolveTrustedReceipt) return 'not_ready';
    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      const where = { org_id: input.orgId, factory_project_id: input.projectId };
      const epoch = await ops.findOne<EpochRow>(EPOCHS, where);
      if (!epoch) return 'not_ready';
      const reservation = await ops.findOne<ReservationRow>(RESERVATIONS, {
        ...where, id: input.reservationId,
      });
      if (!reservation) return 'conflict';
      const prior = await ops.findOne<SettlementRow>(SETTLEMENTS, { reservation_id: reservation.id });
      if (prior) return prior.receipt_id !== input.receiptId ? 'conflict' :
        reservation.state === 'settled' ? 'already_settled' : 'needs_reconciliation';
      if (reservation.state === 'settled') return 'needs_reconciliation';

      const proof = await this.#resolveTrustedReceipt!(ops, input.receiptId);
      if (!proof || proof.receiptId !== input.receiptId ||
          proof.orgId !== reservation.org_id || proof.projectId !== reservation.factory_project_id ||
          proof.sessionId !== reservation.session_id || proof.resourceId !== reservation.resource_id ||
          proof.threadId !== reservation.thread_id || proof.runId !== reservation.run_id ||
          proof.attemptId !== reservation.attempt_id || proof.phase !== reservation.phase ||
          proof.epochRevision !== reservation.epoch_revision ||
          !proof.proofDigest || !proof.producerId || !proof.allExternalEffectsReconciled ||
          (proof.proofKind !== 'definitive_no_effect' && proof.proofKind !== 'terminal_effect')) {
        return 'needs_reconciliation';
      }
      const reused = await ops.findOne<SettlementRow>(SETTLEMENTS, { receipt_id: proof.receiptId });
      if (reused) return 'conflict';

      // Row WRITE-CAS is mandatory. A plain initial read cannot serialize an
      // overlapping reserveNative or tryQuiesce under READ COMMITTED.
      let epochAdvanced = false;
      await ops.updateAtomic<EpochRow>(EPOCHS, where, row => {
        if (row.revision !== epoch.revision) return null;
        epochAdvanced = true;
        return { revision: nextRevision(row.revision), updated_at: new Date() };
      });
      if (!epochAdvanced) return 'conflict';

      let reservationSettled = false;
      await ops.updateAtomic<ReservationRow>(RESERVATIONS, {
        ...where, id: input.reservationId,
      }, row => {
        if (row.state !== reservation.state || row.run_id !== proof.runId ||
            row.attempt_id !== proof.attemptId || row.epoch_revision !== proof.epochRevision) return null;
        reservationSettled = true;
        return { state: 'settled', updated_at: new Date() };
      });
      if (!reservationSettled) {
        // Roll back the epoch increment too; never commit partial settlement.
        throw new Error('Factory settlement CAS changed concurrently; reconciliation required');
      }
      await ops.insertOne<SettlementRow>(SETTLEMENTS, {
        org_id: input.orgId, factory_project_id: input.projectId,
        reservation_id: input.reservationId, receipt_id: proof.receiptId,
        proof_digest: proof.proofDigest, proof_kind: proof.proofKind,
        producer_id: proof.producerId, created_at: new Date(),
      });
      return 'settled';
    });
  }

  /** A crash or timeout never settles a reservation or clears an UNKNOWN. */
  async markUncertain({ orgId, projectId, reservationId }: {
    orgId: string; projectId: string; reservationId: string;
  }): Promise<boolean> {
    assertIdentity({ orgId, projectId, reservationId });
    return this.storage.withTransaction(async (ops: FactoryStorageOps) => {
      let changed = false;
      await ops.updateAtomic<ReservationRow>(RESERVATIONS, {
        id: reservationId, org_id: orgId, factory_project_id: projectId,
      }, row => {
        if (row.state === 'settled') return null;
        changed = true;
        return { state: 'unknown', updated_at: new Date() };
      });
      return changed;
    });
  }

  async getEpoch({ orgId, projectId }: { orgId: string; projectId: string }):
    Promise<{ revision: number; state: EpochState; armed: boolean; mappingRevision: number;
      coverageVersion: number; mappingDigest: string | null; ownerEpoch: string | null } | null> {
    const row = await this.ops.findOne<EpochRow>(EPOCHS, { org_id: orgId, factory_project_id: projectId });
    return row ? { revision: row.revision, state: row.state, armed: row.fence_armed,
      mappingRevision: row.mapping_revision, coverageVersion: row.coverage_version,
      mappingDigest: row.mapping_digest, ownerEpoch: row.owner_epoch } : null;
  }
}
