import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';
import { FACTORY_EXECUTION_ORIGINS_SCHEMA } from '../execution-origin/base.js';
import { FACTORY_EXECUTION_EPOCHS_SCHEMA } from './base.js';

type CoreEffectBoundary =
  | 'model-provider-request'
  | 'shared-native-tool-execute'
  | 'legacy-model-provider-request'
  | 'legacy-native-tool-execute'
  | 'agent-preparation'
  | 'dynamic-model-resolution'
  | 'dynamic-tool-resolution'
  | 'durable-recovery'
  | 'synchronous-clone-construction'
  | 'synchronous-thread-signal';

/**
 * PM #36 A2d: PG-only, default-INERT managed-effect begin transaction.
 *
 * This is NOT registered by Factory or wired to Core. The trusted resolver
 * must be a private, DB-only, server-origin resolver; the client may supply
 * neither the run scope nor manager lease. No writer provisions lease rows.
 * There is deliberately NO activation/arming method or production callback.
 */
export const FACTORY_CORE_MANAGED_EFFECT_CAPABILITY = Object.freeze({
  version: 1,
  backend: 'postgres' as const,
  requiresDatabaseClockInEpochTransaction: true,
  requiresTrustedCoreOrigin: true,
  requiresGpLeaseIssuer: true,
  requiresVerifiedSettlementProducer: true,
  unsupported: [
    'remote-gateway',
    'provider-eager-network',
    'synchronous-clone-construction',
    'synchronous-thread-signal',
  ] as const,
  adoptionReady: false,
  runtimeMode: 'disabled' as const,
});

export const FACTORY_CORE_MANAGER_LEASES_SCHEMA: CollectionSchema = {
  name: 'factory_core_manager_leases',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    lease_id: { type: 'text' },
    manager_writer_id: { type: 'text' },
    owner_epoch: { type: 'text' },
    gp_consent_digest: { type: 'text' },
    policy_digest: { type: 'text' },
    mapping_digest: { type: 'text' },
    automation_revision: { type: 'integer' },
    coverage_version: { type: 'integer' },
    state: { type: 'text' },
    expires_at: { type: 'timestamp' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_core_manager_lease_project_unique', columns: ['org_id', 'factory_project_id'] },
    { name: 'factory_core_manager_lease_id_unique', columns: ['lease_id'] },
  ],
};

interface EpochRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  revision: number;
  state: string;
  fence_armed: boolean;
  coverage_version: number;
  mapping_digest: string | null;
  owner_epoch: string | null;
}
interface LeaseRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  lease_id: string;
  manager_writer_id: string;
  owner_epoch: string;
  gp_consent_digest: string;
  policy_digest: string;
  mapping_digest: string;
  automation_revision: number;
  coverage_version: number;
  state: string;
  expires_at: Date;
}
interface ScopeRow extends Record<string, unknown> {
  org_id: string;
  factory_project_id: string;
  session_id: string;
  resource_id: string;
  thread_id: string;
}
interface OriginRow extends Record<string, unknown> {
  org_id: string;
  factory_project_id: string;
  user_id: string;
  session_id: string;
  source_row_id: string;
  resource_id: string;
  thread_id: string;
  state: string;
}
interface SourceRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  user_id: string;
  session_id: string;
  factory_project_id: string | null;
  visibility: string;
  origin_session_id: string | null;
  branch: string;
}
interface ProjectRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  auto_run_enabled: boolean;
  auto_approve_plans: boolean;
  automation_revision: number;
}
interface ReservationRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  run_id: string;
  attempt_id: string;
  state: string;
}

/**
 * Constructed inside the trusted Core/Factory adapter, never from HTTP or
 * model/tool arguments. This source contract does not implement that adapter.
 */
export interface TrustedManagedCoreRun {
  orgId: string;
  projectId: string;
  userId: string;
  sessionId: string;
  sourceRowId: string;
  resourceId: string;
  threadId: string;
  runId: string;
  attemptId: string;
  phase: 'start' | 'resume';
  ownerEpoch: string;
  leaseId: string;
  managerWriterId: string;
}
export type ResolvePrivateCoreRun = (
  ops: FactoryStorageOps,
  privateInvocation: unknown,
) => Promise<TrustedManagedCoreRun | null>;

export type ManagedEffectBoundary = CoreEffectBoundary | 'remote-gateway' | 'provider-eager-network';

export type ManagedEffectAdmission =
  | { status: 'begun'; reservationId: string; epochRevision: number }
  | { status: 'denied' | 'not_ready' | 'duplicate' | 'unsupported' };

const EFFECT_BEGINS = new Set<ManagedEffectBoundary>([
  'model-provider-request',
  'shared-native-tool-execute',
  'legacy-model-provider-request',
  'legacy-native-tool-execute',
]);
const EPOCHS = FACTORY_EXECUTION_EPOCHS_SCHEMA.name;
const LEASES = FACTORY_CORE_MANAGER_LEASES_SCHEMA.name;
const SCOPES = 'factory_execution_scopes';
const RESERVATIONS = 'factory_execution_reservations';
const ORIGINS = FACTORY_EXECUTION_ORIGINS_SCHEMA.name;
const UNKNOWN = 'factory_execution_unknown_origins';

function canonical(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= 256;
}
function validRun(run: TrustedManagedCoreRun): boolean {
  return Object.values(run).every(canonical) && (run.phase === 'start' || run.phase === 'resume');
}
function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value + 1)) {
    throw new Error('Factory managed epoch revision exhausted');
  }
  return value + 1;
}

/**
 * The same FactoryStorage instance must back memory, Factory app tables and
 * this domain. databaseNow() is a PG-only capability and must run on the
 * transaction client. Unsupported LibSQL/remote stores deny.
 *
 * Lock ordering: B1 epoch FOR UPDATE first, then lease/project/origin/source/
 * reservation. A future revoker MUST lock/write the same epoch row FIRST,
 * then revoke the lease; already-BEGIN effects may finish/reconcile after
 * revoke, never auto-replay. No revocation issuer exists in this slice.
 */
export class FactoryManagedCoreEffectStorage extends FactoryStorageDomain {
  readonly #resolveRun?: ResolvePrivateCoreRun;

  constructor(resolveRun?: ResolvePrivateCoreRun) {
    super('managed-core-effect');
    this.#resolveRun = resolveRun;
  }

  async init(): Promise<void> {
    await this.ensureCollections([FACTORY_CORE_MANAGER_LEASES_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    throw new Error('Managed Core effect admissions are append-only until independently reconciled');
  }

  async beginEffect(input: {
    boundary: ManagedEffectBoundary;
    privateCoreInvocation: unknown;
  }): Promise<ManagedEffectAdmission> {
    if (!EFFECT_BEGINS.has(input.boundary)) return { status: 'unsupported' };
    if (!this.#resolveRun) return { status: 'not_ready' };
    return this.storage.withTransaction(async ops => {
      // Resolve a server-private identity; no fields from privateCoreInvocation
      // are trusted without this independently supplied resolver.
      const run = await this.#resolveRun!(ops, input.privateCoreInvocation);
      if (!run || !validRun(run)) return { status: 'denied' as const };
      if (!ops.databaseNow) return { status: 'not_ready' as const };
      const where = { org_id: run.orgId, factory_project_id: run.projectId };
      let decision: ManagedEffectAdmission = { status: 'denied' };
      // The epoch lock and revision write serialize across PostgreSQL pools.
      // Do not lock a thread/memory row before this epoch in any future adapter.
      await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
        if (
          !epoch.fence_armed ||
          epoch.coverage_version !== 1 ||
          epoch.state !== 'quiescing' ||
          !epoch.mapping_digest ||
          epoch.owner_epoch !== run.ownerEpoch
        )
          return null;
        const now = await ops.databaseNow!();
        const lease = await ops.findOne<LeaseRow>(LEASES, where);
        if (
          !lease ||
          lease.state !== 'active' ||
          lease.lease_id !== run.leaseId ||
          lease.manager_writer_id !== run.managerWriterId ||
          lease.owner_epoch !== run.ownerEpoch ||
          lease.mapping_digest !== epoch.mapping_digest ||
          lease.coverage_version !== epoch.coverage_version ||
          !digest(lease.gp_consent_digest) ||
          !digest(lease.policy_digest) ||
          !(lease.expires_at instanceof Date) ||
          lease.expires_at.getTime() <= now.getTime()
        )
          return null;
        const project = await ops.findOne<ProjectRow>('factory_projects', {
          id: run.projectId,
          org_id: run.orgId,
        });
        if (
          !project ||
          project.auto_run_enabled ||
          project.auto_approve_plans ||
          project.automation_revision !== lease.automation_revision
        )
          return null;
        const scope = await ops.findOne<ScopeRow>(SCOPES, {
          resource_id: run.resourceId,
          thread_id: run.threadId,
        });
        if (
          !scope ||
          scope.org_id !== run.orgId ||
          scope.factory_project_id !== run.projectId ||
          scope.session_id !== run.sessionId
        )
          return null;
        const origin = await ops.findOne<OriginRow>(ORIGINS, {
          org_id: run.orgId,
          factory_project_id: run.projectId,
          session_id: run.sessionId,
          resource_id: run.resourceId,
          thread_id: run.threadId,
          state: 'verified',
        });
        if (!origin || origin.user_id !== run.userId || origin.source_row_id !== run.sourceRowId) return null;
        if (await ops.findOne(UNKNOWN, { org_id: run.orgId, session_id: run.sessionId })) return null;
        const source = await ops.findOne<SourceRow>('source_control_sessions', {
          id: run.sourceRowId,
        });
        if (
          !source ||
          source.org_id !== run.orgId ||
          source.user_id !== run.userId ||
          source.session_id !== run.sessionId ||
          source.factory_project_id !== run.projectId ||
          source.origin_session_id !== null ||
          source.branch.startsWith('slack/') ||
          (source.visibility !== 'org' && source.visibility !== 'private') ||
          (source.visibility === 'org' ? run.projectId : run.userId) !== run.resourceId
        )
          return null;

        if (
          await ops.findOne<ReservationRow>(RESERVATIONS, {
            org_id: run.orgId,
            factory_project_id: run.projectId,
            attempt_id: run.attemptId,
          })
        ) {
          decision = { status: 'duplicate' };
          return null;
        }
        const sameRun = await ops.findMany<ReservationRow>(RESERVATIONS, {
          ...where,
          run_id: run.runId,
        });
        if (sameRun.some(reservation => reservation.state !== 'settled')) {
          decision = { status: 'duplicate' };
          return null;
        }
        const revision = nextRevision(epoch.revision);
        const reservation = await ops.insertOne<ReservationRow>(RESERVATIONS, {
          ...where,
          session_id: run.sessionId,
          resource_id: run.resourceId,
          thread_id: run.threadId,
          run_id: run.runId,
          attempt_id: run.attemptId,
          phase: run.phase,
          epoch_revision: revision,
          state: 'reserved',
          created_at: now,
          updated_at: now,
        });
        decision = { status: 'begun', reservationId: reservation.id, epochRevision: revision };
        return { revision, updated_at: now };
      });
      return decision;
    });
  }
}
