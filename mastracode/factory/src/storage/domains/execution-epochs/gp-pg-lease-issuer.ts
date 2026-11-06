import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';
import { PgFactoryStorage } from '@mastra/pg';

import { FACTORY_EXECUTION_EPOCHS_SCHEMA, FACTORY_EXECUTION_RESERVATIONS_SCHEMA } from './base.js';
import { FACTORY_CORE_MANAGER_LEASES_SCHEMA } from './managed-effect.js';
import { verifyFactoryGpSignedPacket, gpV9ScopeTupleDigest } from './gp-pg-handover-crypto.js';
import type { GpHandoverScope, GpSignedHandoverPacket } from './gp-pg-handover-crypto.js';
import type { KeyObject } from 'node:crypto';

/**
 * An unregistered, default-OFF PostgreSQL GP handover issuer. This class
 * carries out real atomic PostgreSQL effects if explicitly constructed with
 * trusted providers and enabled. NOTHING in Factory installs or invokes it.
 * No authenticated HTTPS/private PM bridge, live GP verifier or service key
 * is supplied by this source slice.
 */
export const FACTORY_GP_PG_HANDOVER_ISSUER_CAPABILITY = Object.freeze({
  version: 1, backend: 'postgres',
  runtimeInstalled: false, adoptionReady: false, enabledByDefault: false,
  remoteExecutionSupported: false, providerEagerSupported: false,
  synchronousCloneSupported: false,
});

export const FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA: CollectionSchema = {
  name: 'factory_gp_pg_handover_consumptions',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    consent_request_id: { type: 'text' },
    manifest_id: { type: 'text' },
    nonce_sha256: { type: 'text' },
    bridge_challenge_id: { type: 'text' },
    lease_intent_id: { type: 'text' },
    scope_tuple_sha256: { type: 'text' },
    signed_packet_digest: { type: 'text' },
    writer_owner_id: { type: 'text' },
    writer_epoch: { type: 'integer' },
    owner_epoch: { type: 'text' },
    authority_revision: { type: 'integer' },
    policy_digest: { type: 'text' },
    mapping_digest: { type: 'text' },
    automation_revision: { type: 'integer' },
    coverage_version: { type: 'integer' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_gp_pg_request_once', columns: ['consent_request_id'] },
    { name: 'factory_gp_pg_manifest_once', columns: ['manifest_id'] },
    { name: 'factory_gp_pg_nonce_once', columns: ['nonce_sha256'] },
    { name: 'factory_gp_pg_challenge_once', columns: ['bridge_challenge_id'] },
    { name: 'factory_gp_pg_lease_intent_once', columns: ['lease_intent_id'] },
    { name: 'factory_gp_pg_scope_tuple_once', columns: ['scope_tuple_sha256'] },
    { name: 'factory_gp_pg_epoch_aba_once', columns: [
      'org_id', 'factory_project_id', 'writer_epoch', 'owner_epoch', 'authority_revision',
    ] },
  ],
};
export const FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA: CollectionSchema = {
  name: 'factory_gp_pg_handover_revocations',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    lease_intent_id: { type: 'text' },
    writer_owner_id: { type: 'text' },
    owner_epoch: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'factory_gp_pg_revoked_lease_once', columns: ['lease_intent_id'] },
  ],
};

interface EpochRow extends Record<string, unknown> {
  revision: number; state: string; fence_armed: boolean;
  coverage_version: number; mapping_digest: string | null; owner_epoch: string | null;
}
interface ProjectRow extends Record<string, unknown> {
  auto_run_enabled: boolean; auto_approve_plans: boolean; automation_revision: number;
}
interface ReservationRow extends Record<string, unknown> { state: string }
interface LeaseRow extends Record<string, unknown> {
  lease_id: string; manager_writer_id: string; state: string;
}
export interface VerifiedPrivateGpIssuerRequest {
  // Generated from a server-private invocation map, never a caller JSON body.
  packet: GpSignedHandoverPacket;
  scope: GpHandoverScope;
  ttlSeconds: number;
}
export type ResolvePrivateGpIssuerRequest = (
  invocation: object,
) => Promise<VerifiedPrivateGpIssuerRequest | null>;
export type ResolvePrivateGpReceipt = (invocation: object) => {
  scope: GpHandoverScope; leaseIntentId: string; scopeTupleSha256: string;
} | null;


/**
 * The returned fields must come from an independently authenticated, fresh
 * PM v9 consent/writer/revocation readback. An echoed input JSON object or
 * claimed boolean is NOT a production trust provider.
 */
export interface LivePmHandoverAuthority {
  source: 'authenticated_live_pm_v9_authority_v1';
  actor: 'gp'; current: true; gpSessionVerified: true;
  consentUnrevoked: true; consentConsumedOnce: true;
  projectSelected: true; projectMembershipVerified: true;
  writerPaused: true; dispatchPending: 0;
  projectId: string; factoryOrgId: string;
  consentRequestId: string; manifestId: string; nonceSha256: string;
  writerOwnerId: string; writerEpoch: number; ownerEpoch: string;
  authorityRevision: number; policyDigest: string; mode: 'supervised' | 'autonomous';
  verifiedAtMs: number; heartbeatAtMs: number; writerLeaseExpiresAtMs: number;
}
export type ReadAuthenticatedPmAuthority = (
  ops: FactoryStorageOps, privateInvocation: object, scope: GpHandoverScope,
) => Promise<LivePmHandoverAuthority | null>;

export interface NativePgDrainReadback {
  source: 'factory_pg_same_transaction_drain_v1';
  projectId: string; factoryOrgId: string;
  coverageArmed: true; mappingDigest: string; coverageVersion: number;
  runningCount: 0; parkedCount: 0; pendingCount: 0; unknownCount: 0;
  unsettledEffectCount: 0; remoteExecutionSupported: false;
}
export type ReadNativeDrainInPgTransaction = (
  ops: FactoryStorageOps, scope: GpHandoverScope,
) => Promise<NativePgDrainReadback | null>;

export interface NativeProjectAppGrant {
  source: 'authenticated_github_app_grant_v1';
  grantActive: true;
  factoryOrgId: string; projectId: string;
  repositoryId: number; repositoryOwnerId: number; appInstallationId: number;
  projectRepositoryLinkId: string; connectionId: string;
  repositoryRecordId: string; installationRecordId: string;
  verifiedAtMs: number;
}
export type ReadLiveProjectAppGrant = (
  ops: FactoryStorageOps, scope: GpHandoverScope,
  binding: { projectRepositoryLinkId: string; connectionId: string;
    repositoryRecordId: string; installationRecordId: string },
) => Promise<NativeProjectAppGrant | null>;

interface ConnectionRow extends Record<string, unknown> {
  id: string; factory_project_id: string; integration_id: string; installation_id: string;
}
interface ProjectLinkRow extends Record<string, unknown> {
  id: string; connection_id: string; repository_id: string;
}
interface RepositoryRow extends Record<string, unknown> {
  id: string; installation_id: string; external_id: string;
}
interface InstallationRow extends Record<string, unknown> {
  id: string; org_id: string; integration_id: string; external_id: string;
}

export interface VerifiedPrivateGpRevoke {
  source: 'authenticated_live_gp_revocation_v1';
  actor: 'gp'; gpSessionVerified: true; originVerified: true; csrfVerified: true;
  factoryOrgId: string; projectId: string; leaseId: string;
  writerOwnerId: string; ownerEpoch: string;
  verifiedAtMs: number;
}
export type ResolvePrivateGpRevokeIdentity = (
  privateInvocation: object,
) => { factoryOrgId: string; projectId: string } | null;
export type ResolvePrivateGpRevoke = (
  ops: FactoryStorageOps, privateInvocation: object,
) => Promise<VerifiedPrivateGpRevoke | null>;

const EPOCHS = FACTORY_EXECUTION_EPOCHS_SCHEMA.name;
const LEASES = FACTORY_CORE_MANAGER_LEASES_SCHEMA.name;
const CONSUMED = FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA.name;
const REVOKED = FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA.name;
const RESERVATIONS = FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name;
const UNKNOWN = 'factory_execution_unknown_origins';
const bounded = (v: unknown, max: number): v is number =>
  Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
const safeRevision = (revision: number) => Number.isSafeInteger(revision + 1) ? revision + 1 : null;
function currentPmMatches(pm: LivePmHandoverAuthority | null,
  scope: GpHandoverScope, at: number): boolean {
  return !!pm && pm.source === 'authenticated_live_pm_v9_authority_v1' &&
    pm.actor === 'gp' && pm.current === true && pm.gpSessionVerified === true &&
    pm.consentUnrevoked === true && pm.consentConsumedOnce === true &&
    pm.projectSelected === true && pm.projectMembershipVerified === true &&
    pm.writerPaused === true && pm.dispatchPending === 0 &&
    pm.projectId === scope.projectId && pm.factoryOrgId === scope.factoryOrgId &&
    pm.consentRequestId === scope.consentRequestId && pm.manifestId === scope.manifestId &&
    pm.nonceSha256 === scope.nonceSha256 && pm.writerOwnerId === scope.writerOwnerId &&
    pm.writerEpoch === scope.writerEpoch && pm.ownerEpoch === scope.ownerEpoch &&
    pm.authorityRevision === scope.authorityRevision && pm.policyDigest === scope.policyDigest &&
    pm.mode === scope.mode && bounded(pm.verifiedAtMs, Number.MAX_SAFE_INTEGER) &&
    pm.verifiedAtMs <= at && at - pm.verifiedAtMs <= 30000 &&
    bounded(pm.heartbeatAtMs, Number.MAX_SAFE_INTEGER) &&
    pm.heartbeatAtMs <= at && at - pm.heartbeatAtMs <= 30000 &&
    bounded(pm.writerLeaseExpiresAtMs, Number.MAX_SAFE_INTEGER) &&
    pm.writerLeaseExpiresAtMs > at;
}

export class FactoryGpPgLeaseIssuerStorage extends FactoryStorageDomain {
  readonly #enabled: boolean;
  readonly #trustedKey?: { keyId: string; publicKey: KeyObject };
  readonly #resolveRequest?: ResolvePrivateGpIssuerRequest;
  readonly #resolveReceipt?: ResolvePrivateGpReceipt;
  readonly #readPm?: ReadAuthenticatedPmAuthority;
  readonly #readNativeDrain?: ReadNativeDrainInPgTransaction;
  readonly #readAppGrant?: ReadLiveProjectAppGrant;
  readonly #resolveRevokeIdentity?: ResolvePrivateGpRevokeIdentity;
  readonly #resolveRevoke?: ResolvePrivateGpRevoke;

  constructor(options: {
    enabled?: boolean;
    trustedKey?: { keyId: string; publicKey: KeyObject };
    resolvePrivateRequest?: ResolvePrivateGpIssuerRequest;
    resolvePrivateReceipt?: ResolvePrivateGpReceipt;
    readAuthenticatedPm?: ReadAuthenticatedPmAuthority;
    readNativeDrain?: ReadNativeDrainInPgTransaction;
    readLiveAppGrant?: ReadLiveProjectAppGrant;
    resolvePrivateRevokeIdentity?: ResolvePrivateGpRevokeIdentity;
    resolvePrivateRevoke?: ResolvePrivateGpRevoke;
  } = {}) {
    super('gp-pg-lease-issuer');
    this.#enabled = options.enabled === true;
    this.#trustedKey = options.trustedKey;
    this.#resolveRequest = options.resolvePrivateRequest;
    this.#resolveReceipt = options.resolvePrivateReceipt;
    this.#readPm = options.readAuthenticatedPm;
    this.#readNativeDrain = options.readNativeDrain;
    this.#readAppGrant = options.readLiveAppGrant;
    this.#resolveRevokeIdentity = options.resolvePrivateRevokeIdentity;
    this.#resolveRevoke = options.resolvePrivateRevoke;
    if (this.#enabled && (
      !this.#trustedKey || !this.#resolveRequest || !this.#readPm ||
      !this.#readNativeDrain || !this.#readAppGrant ||
      !this.#resolveRevokeIdentity || !this.#resolveRevoke
    )) throw new Error('GP PG issuer requires all owner-private trust providers');
  }

  async init(): Promise<void> {
    // Registration is deliberately absent in production; this schema exists
    // only on explicit test/next-generation isolated PostgreSQL storage.
    await this.ensureCollections([
      FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA,
      FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA,
    ]);
  }

  async dangerouslyClearAll(): Promise<void> {
    throw new Error('Immutable GP handover nonce/challenge consumption cannot be bulk-cleared');
  }

  async issue(privateInvocation: object): Promise<'issued' | 'denied' | 'not_ready'> {
    if (!this.#enabled || !(this.storage instanceof PgFactoryStorage)) return 'not_ready';
    if (!privateInvocation || typeof privateInvocation !== 'object') return 'denied';
    const privateRequest = await this.#resolveRequest!(privateInvocation);
    if (!privateRequest || !bounded(privateRequest.ttlSeconds, 300)) return 'denied';
    const scope = privateRequest.scope;
    // Do not expose a project-existence oracle; malformed private mappings
    // receive the same denial as a nonexistent/wrong-tenant project.
    if (!scope?.factoryOrgId || !scope.projectId) return 'denied';
    return this.storage.withTransaction(async ops => {
      if (!ops.databaseNow) return 'not_ready';
      const where = { org_id: scope.factoryOrgId, factory_project_id: scope.projectId };
      let issued = false;
      await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
        const revision = safeRevision(epoch.revision);
        if (!revision || epoch.state !== 'quiescing' || !epoch.fence_armed ||
          epoch.coverage_version !== scope.coverageVersion || epoch.coverage_version !== 1 ||
          epoch.mapping_digest !== scope.mappingDigest || epoch.owner_epoch !== scope.ownerEpoch) return null;
        // First acquired/wrote the same B1 row as beginEffect and revocation.
        const now = await ops.databaseNow!();
        const signed = verifyFactoryGpSignedPacket({
          packet: privateRequest.packet, expectedScope: scope,
          trustedKey: this.#trustedKey!, now,
        });
        if (!signed) return null;
        const pm = await this.#readPm!(ops, privateInvocation, scope);
        const dbNowMs = (await ops.databaseNow!()).getTime();
        if (!currentPmMatches(pm, scope, dbNowMs)) return null;

        // Acquire/write the native project row under the epoch lock, rather
        // than trusting an unlocked findOne that could race the native CAS
        // project-automation update before this lease transaction commits.
        let nativeCasHeld = false;
        await ops.updateAtomic<ProjectRow>('factory_projects', {
          id: scope.projectId, org_id: scope.factoryOrgId,
        }, project => {
          if (project.auto_run_enabled || project.auto_approve_plans ||
            project.automation_revision !== scope.nativeAutomationRevision) return null;
          nativeCasHeld = true;
          return { automation_revision: project.automation_revision };
        });
        if (!nativeCasHeld) return null;
        // Verify the actual Factory PG project→connection→repository→App
        // installation chain. A PM-supplied repository numeric ID does not
        // confer installation access. Public repos.get is insufficient.
        const connections = await ops.findMany<ConnectionRow>(
          'factory_project_source_control_connections',
          { factory_project_id: scope.projectId },
        );
        const githubConnections = connections.filter(c => c.integration_id === 'github');
        if (githubConnections.length !== 1) return null;
        const connection = githubConnections[0]!;
        const links = await ops.findMany<ProjectLinkRow>('factory_project_repositories',
          { connection_id: connection.id });
        if (links.length !== 1) return null;
        const link = links[0]!;
        const repo = await ops.findOne<RepositoryRow>('source_control_repositories',
          { id: link.repository_id, installation_id: connection.installation_id });
        const installation = await ops.findOne<InstallationRow>('source_control_installations',
          { id: connection.installation_id, org_id: scope.factoryOrgId, integration_id: 'github' });
        if (!repo || !installation || repo.external_id !== String(scope.repositoryId) ||
          installation.external_id !== String(scope.appInstallationId)) return null;
        const binding = {
          projectRepositoryLinkId: link.id, connectionId: connection.id,
          repositoryRecordId: repo.id, installationRecordId: installation.id,
        };
        const grant = await this.#readAppGrant!(ops, scope, binding);
        const grantNowMs = (await ops.databaseNow!()).getTime();
        if (!grant || grant.source !== 'authenticated_github_app_grant_v1' ||
          grant.grantActive !== true || grant.factoryOrgId !== scope.factoryOrgId ||
          grant.projectId !== scope.projectId ||
          grant.repositoryId !== scope.repositoryId ||
          grant.repositoryOwnerId !== scope.repositoryOwnerId ||
          grant.appInstallationId !== scope.appInstallationId ||
          grant.projectRepositoryLinkId !== link.id || grant.connectionId !== connection.id ||
          grant.repositoryRecordId !== repo.id ||
          grant.installationRecordId !== installation.id ||
          !bounded(grant.verifiedAtMs, Number.MAX_SAFE_INTEGER) ||
          grant.verifiedAtMs > grantNowMs ||
          grantNowMs - grant.verifiedAtMs > 30000) return null;
        const drain = await this.#readNativeDrain!(ops, scope);
        if (!drain || drain.source !== 'factory_pg_same_transaction_drain_v1' ||
          drain.projectId !== scope.projectId || drain.factoryOrgId !== scope.factoryOrgId ||
          drain.coverageArmed !== true || drain.mappingDigest !== scope.mappingDigest ||
          drain.coverageVersion !== scope.coverageVersion ||
          drain.runningCount !== 0 || drain.parkedCount !== 0 || drain.pendingCount !== 0 ||
          drain.unknownCount !== 0 || drain.unsettledEffectCount !== 0 ||
          drain.remoteExecutionSupported !== false) return null;
        // Independently query B1 durable receipts. UNKNOWN remains a blocker;
        // no TTL or process exit silently reclassifies an unsettled effect.
        const reservations = await ops.findMany<ReservationRow>(RESERVATIONS, where);
        if (reservations.some(row => row.state !== 'settled')) return null;
        if (await ops.findOne(UNKNOWN, { org_id: scope.factoryOrgId })) return null;
        if (await ops.findOne<LeaseRow>(LEASES, where)) return null;
        if (await ops.findOne(REVOKED, { lease_intent_id: scope.leaseIntentId })) return null;
        if (await ops.findOne(CONSUMED, { consent_request_id: scope.consentRequestId }) ||
          await ops.findOne(CONSUMED, { nonce_sha256: scope.nonceSha256 }) ||
          await ops.findOne(CONSUMED, { bridge_challenge_id: scope.bridgeChallengeId }) ||
          await ops.findOne(CONSUMED, { lease_intent_id: scope.leaseIntentId })) return null;
        // Long authenticated bridge/drain calls may consume the packet's
        // ten-second validity: use a FRESH PG clock_timestamp at commit, not
        // the transaction-start clock, and reject late GP/writer proof.
        // Repeat the native App grant and scope comparison after external
        // reads; revoked/relinked App access must not be silently retained.
        const finalGrant = await this.#readAppGrant!(ops, scope, binding);
        const finalPm = await this.#readPm!(ops, privateInvocation, scope);
        const commitNow = await ops.databaseNow!();
        const commitMs = commitNow.getTime();
        if (!verifyFactoryGpSignedPacket({ packet: privateRequest.packet,
          expectedScope: scope, trustedKey: this.#trustedKey!, now: commitNow }) ||
          !currentPmMatches(finalPm, scope, commitMs)) return null;
        if (!finalGrant || finalGrant.source !== 'authenticated_github_app_grant_v1' ||
          finalGrant.grantActive !== true || finalGrant.factoryOrgId !== grant.factoryOrgId ||
          finalGrant.projectId !== grant.projectId ||
          finalGrant.repositoryId !== grant.repositoryId ||
          finalGrant.repositoryOwnerId !== grant.repositoryOwnerId ||
          finalGrant.appInstallationId !== grant.appInstallationId ||
          finalGrant.projectRepositoryLinkId !== grant.projectRepositoryLinkId ||
          finalGrant.connectionId !== grant.connectionId ||
          finalGrant.repositoryRecordId !== grant.repositoryRecordId ||
          finalGrant.installationRecordId !== grant.installationRecordId ||
          !bounded(finalGrant.verifiedAtMs, Number.MAX_SAFE_INTEGER) ||
          finalGrant.verifiedAtMs > commitMs ||
          commitMs - finalGrant.verifiedAtMs > 30000) return null;
        // Both inserts and epoch-CAS are in the same PostgreSQL transaction.
        // The unique PG indexes are the cross-process replay/ABA backstop.
        await ops.insertOne(CONSUMED, {
          ...where,
          consent_request_id: scope.consentRequestId,
          manifest_id: scope.manifestId,
          nonce_sha256: scope.nonceSha256,
          bridge_challenge_id: scope.bridgeChallengeId,
          lease_intent_id: scope.leaseIntentId,
          scope_tuple_sha256: signed.scopeTupleSha256,
          signed_packet_digest: signed.packetDigest,
          writer_owner_id: scope.writerOwnerId,
          writer_epoch: scope.writerEpoch,
          owner_epoch: scope.ownerEpoch,
          authority_revision: scope.authorityRevision,
          policy_digest: scope.policyDigest,
          mapping_digest: scope.mappingDigest,
          automation_revision: scope.nativeAutomationRevision,
          coverage_version: scope.coverageVersion,
          created_at: commitNow,
        });
        await ops.insertOne(LEASES, {
          ...where,
          lease_id: scope.leaseIntentId,
          manager_writer_id: scope.writerOwnerId,
          owner_epoch: scope.ownerEpoch,
          gp_consent_digest: signed.scopeTupleSha256,
          policy_digest: scope.policyDigest,
          mapping_digest: scope.mappingDigest,
          automation_revision: scope.nativeAutomationRevision,
          coverage_version: scope.coverageVersion,
          state: 'active',
          expires_at: new Date(commitMs + privateRequest.ttlSeconds * 1000),
          created_at: commitNow,
          updated_at: commitNow,
        });
        issued = true;
        return { revision, updated_at: commitNow };
      });
      return issued ? 'issued' : 'denied';
    });
  }

  /**
   * Read-only recovery after an ambiguous HTTPS ACK. UNKNOWN proves nothing:
   * do not auto-replay a consumed GP challenge under any circumstances.
   */
  async receipt(privateInvocation: object):
    Promise<'issued' | 'revoked' | 'unknown' | 'not_ready'> {
    if (!this.#enabled || !(this.storage instanceof PgFactoryStorage) ||
      !this.#resolveReceipt) return 'not_ready';
    const proof = this.#resolveReceipt(privateInvocation);
    if (!proof || !proof.scope || proof.leaseIntentId !== proof.scope.leaseIntentId ||
      proof.scopeTupleSha256 !== gpV9ScopeTupleDigest(proof.scope)) return 'unknown';
    const scope = proof.scope;
    return this.storage.withTransaction(async ops => {
      let result: 'issued' | 'revoked' | 'unknown' = 'unknown';
      const where = { org_id: scope.factoryOrgId, factory_project_id: scope.projectId };
      // Same PG epoch row-lock order as issue, beginEffect, and revoke.
      await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
        if (epoch.owner_epoch !== scope.ownerEpoch) return null;
        const tomb = await ops.findOne(REVOKED, {
          ...where, lease_intent_id: scope.leaseIntentId,
          writer_owner_id: scope.writerOwnerId, owner_epoch: scope.ownerEpoch,
        });
        if (tomb) { result = 'revoked'; return null; }
        const consumed = await ops.findOne(CONSUMED, {
          ...where, lease_intent_id: scope.leaseIntentId,
          scope_tuple_sha256: proof.scopeTupleSha256,
          consent_request_id: scope.consentRequestId,
          owner_epoch: scope.ownerEpoch,
        });
        if (!consumed) return null;
        const lease = await ops.findOne<LeaseRow>(LEASES, where);
        if (!lease || lease.lease_id !== scope.leaseIntentId ||
          lease.manager_writer_id !== scope.writerOwnerId) return null;
        result = lease.state === 'revoked' ? 'revoked' : 'issued';
        return null;
      });
      return result;
    });
  }

  async revoke(privateInvocation: object): Promise<'revoked' | 'denied' | 'not_ready'> {
    if (!this.#enabled || !(this.storage instanceof PgFactoryStorage)) return 'not_ready';
    if (!privateInvocation || typeof privateInvocation !== 'object') return 'denied';
    const identity = this.#resolveRevokeIdentity!(privateInvocation);
    if (!identity?.factoryOrgId || !identity.projectId) return 'denied';
    return this.storage.withTransaction(async ops => {
      if (!ops.databaseNow) return 'not_ready';
      const where = { org_id: identity.factoryOrgId, factory_project_id: identity.projectId };
      let revoked = false;
      await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
        const revision = safeRevision(epoch.revision);
        if (!revision) return null;
        // First take/write epoch CAS, THEN resolve live GP session, CSRF and
        // current revocation. Never take a PM/Factory storage lock beforehand.
        const gp = await this.#resolveRevoke!(ops, privateInvocation);
        if (!gp || gp.source !== 'authenticated_live_gp_revocation_v1' ||
          gp.actor !== 'gp' || gp.gpSessionVerified !== true ||
          gp.originVerified !== true || gp.csrfVerified !== true ||
          gp.factoryOrgId !== identity.factoryOrgId || gp.projectId !== identity.projectId ||
          !gp.leaseId || !gp.ownerEpoch || epoch.owner_epoch !== gp.ownerEpoch) return null;
        const now = await ops.databaseNow!();
        const at = now.getTime();
        if (!bounded(gp.verifiedAtMs, Number.MAX_SAFE_INTEGER) ||
          gp.verifiedAtMs > at || at - gp.verifiedAtMs > 30000) return null;
        const lease = await ops.findOne<LeaseRow>(LEASES, where);
        if (lease && (lease.lease_id !== gp.leaseId ||
          lease.manager_writer_id !== gp.writerOwnerId)) return null;
        const prior = await ops.findOne(REVOKED, { lease_intent_id: gp.leaseId });
        if (!prior) {
          await ops.insertOne(REVOKED, {
            ...where, lease_intent_id: gp.leaseId,
            writer_owner_id: gp.writerOwnerId,
            owner_epoch: gp.ownerEpoch,
            created_at: now,
          });
        }
        // The durable tombstone is intentionally committed even if issue has
        // not happened yet; a concurrent later issue must see it and deny.
        if (lease?.state === 'active' && lease.lease_id === gp.leaseId &&
          lease.manager_writer_id === gp.writerOwnerId) {
          await ops.updateMany(LEASES, where, { state: 'revoked', updated_at: now });
        }
        revoked = true;
        return { revision, updated_at: now };
      });
      return revoked ? 'revoked' : 'denied';
    });
  }
}
