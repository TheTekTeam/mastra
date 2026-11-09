import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';
import { PgFactoryStorage } from '@mastra/pg';

import { FACTORY_EXECUTION_EPOCHS_SCHEMA } from './base.js';
import { FACTORY_CORE_MANAGER_LEASES_SCHEMA } from './managed-effect.js';
import { FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA } from './gp-pg-lease-issuer.js';
import type { ResolvePrivateGpRevoke, ResolvePrivateGpRevokeIdentity } from './gp-pg-lease-issuer.js';
import { canonicalV3AuthenticatedTombstoneDigest, canonicalV3RebindNonceKey } from './gp-pg-b1-rebind-v3-protocol.js';
import { inspectFactoryGpPgPostTombstoneV3 } from './gp-pg-post-tombstone-v3.js';
import type { FactoryGpPgRebindV3Expected } from './gp-pg-post-tombstone-v3.js';

/**
 * Actual FactoryStorageOps source prototype; no import/registration anywhere
 * in a Factory runtime. Only explicit test registration and test credentials
 * can create schema or call these transactions. No live GP/PM signer exists.
 */
export const FACTORY_GP_PG_B1_V3_NATIVE_CAPABILITY = Object.freeze({
  installed: false,
  enabledByDefault: false,
  productionReady: false,
  liveSchemaMigrationInstalled: false,
  liveGpMtlsReceiverInstalled: false,
  livePmSignerInstalled: false,
  authorizesFactoryWrites: false,
});

export const FACTORY_GP_PG_B1_V3_TOMBSTONES_SCHEMA: CollectionSchema = {
  name: 'factory_gp_pg_b1_v3_tombstones',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    lease_intent_id: { type: 'text' },
    old_writer_owner_id: { type: 'text' },
    owner_epoch: { type: 'text' },
    original_revocation_row_id: { type: 'text' },
    revoke_request_id: { type: 'text' },
    pg_epoch_revision: { type: 'integer' },
    pg_committed_at_ms: { type: 'bigint' },
    tombstone_sha256: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'gp_b1_v3_tombstone_original_once', columns: ['original_revocation_row_id'] },
    { name: 'gp_b1_v3_tombstone_revoke_once', columns: ['revoke_request_id'] },
    { name: 'gp_b1_v3_tombstone_lease_once', columns: ['lease_intent_id'] },
    { name: 'gp_b1_v3_tombstone_hash_once', columns: ['tombstone_sha256'] },
  ],
};

export const FACTORY_GP_PG_B1_V3_CHALLENGES_SCHEMA: CollectionSchema = {
  name: 'factory_gp_pg_b1_v3_challenges',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    lease_intent_id: { type: 'text' },
    challenge_id: { type: 'text' },
    factory_challenge_sha256: { type: 'text' },
    tombstone_sha256: { type: 'text' },
    issued_at_ms: { type: 'bigint' },
    expires_at_ms: { type: 'bigint' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'gp_b1_v3_challenge_id_once', columns: ['challenge_id'] },
    { name: 'gp_b1_v3_challenge_hash_once', columns: ['factory_challenge_sha256'] },
  ],
};

export const FACTORY_GP_PG_B1_V3_NONCES_SCHEMA: CollectionSchema = {
  name: 'factory_gp_pg_b1_v3_consumed_nonces',
  columns: {
    id: { type: 'uuid-pk' },
    challenge_id: { type: 'text' },
    revoke_request_id: { type: 'text' },
    rebind_nonce_sha256: { type: 'text' },
    nonce_scope_sha256: { type: 'text' },
    signed_packet_digest: { type: 'text' },
    org_id: { type: 'text' },
    factory_project_id: { type: 'text' },
    lease_intent_id: { type: 'text' },
    old_writer_owner_id: { type: 'text' },
    old_writer_epoch: { type: 'integer' },
    new_writer_owner_id: { type: 'text' },
    new_writer_epoch: { type: 'integer' },
    transition_chain_sha256: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    { name: 'gp_b1_v3_nonce_challenge_once', columns: ['challenge_id'] },
    { name: 'gp_b1_v3_nonce_revoke_once', columns: ['revoke_request_id'] },
    { name: 'gp_b1_v3_nonce_digest_once', columns: ['rebind_nonce_sha256'] },
    { name: 'gp_b1_v3_nonce_scope_once', columns: ['nonce_scope_sha256'] },
    { name: 'gp_b1_v3_nonce_packet_once', columns: ['signed_packet_digest'] },
  ],
};

export const FACTORY_GP_PG_B1_V3_TEST_SCHEMAS = Object.freeze([
  FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA,
  FACTORY_GP_PG_B1_V3_TOMBSTONES_SCHEMA,
  FACTORY_GP_PG_B1_V3_CHALLENGES_SCHEMA,
  FACTORY_GP_PG_B1_V3_NONCES_SCHEMA,
]);

/** Fingerprint of the exact schema declarations, not an installed migration. */
export function factoryGpB1V3SourceSchemaSha256(): string {
  return createHash('sha256').update(JSON.stringify(FACTORY_GP_PG_B1_V3_TEST_SCHEMAS)).digest('hex');
}

interface EpochRow extends Record<string, unknown> {
  revision: number;
  owner_epoch: string | null;
}
interface LeaseRow extends Record<string, unknown> {
  lease_id: string;
  manager_writer_id: string;
  state: string;
}
interface B1RevocationRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  lease_intent_id: string;
  writer_owner_id: string;
  owner_epoch: string;
}
interface TombstoneRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  lease_intent_id: string;
  old_writer_owner_id: string;
  owner_epoch: string;
  original_revocation_row_id: string;
  revoke_request_id: string;
  tombstone_sha256: string;
  pg_epoch_revision: number;
  pg_committed_at_ms: number;
}
interface ChallengeRow extends Record<string, unknown> {
  challenge_id: string;
  factory_challenge_sha256: string;
  tombstone_sha256: string;
  issued_at_ms: number;
  expires_at_ms: number;
}
const EPOCHS = FACTORY_EXECUTION_EPOCHS_SCHEMA.name;
const LEASES = FACTORY_CORE_MANAGER_LEASES_SCHEMA.name;
const REVOKED = FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA.name;
const TOMBS = FACTORY_GP_PG_B1_V3_TOMBSTONES_SCHEMA.name;
const CHALLENGES = FACTORY_GP_PG_B1_V3_CHALLENGES_SCHEMA.name;
const NONCES = FACTORY_GP_PG_B1_V3_NONCES_SCHEMA.name;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const safePos = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
function committedNativeV3TombstoneMatches(original: B1RevocationRow, tomb: TombstoneRow): boolean {
  return (
    original.id === tomb.original_revocation_row_id &&
    original.org_id === tomb.org_id &&
    original.factory_project_id === tomb.factory_project_id &&
    original.lease_intent_id === tomb.lease_intent_id &&
    original.writer_owner_id === tomb.old_writer_owner_id &&
    original.owner_epoch === tomb.owner_epoch &&
    canonicalV3AuthenticatedTombstoneDigest({
      version: 'factory_gp_pg_b1_authenticated_revoke_v3',
      orgId: tomb.org_id,
      projectId: tomb.factory_project_id,
      leaseIntentId: tomb.lease_intent_id,
      oldWriterOwnerId: tomb.old_writer_owner_id,
      ownerEpoch: tomb.owner_epoch,
      originalRevocationRowId: tomb.original_revocation_row_id,
      revokeRequestId: tomb.revoke_request_id,
      pgCommittedAtMs: tomb.pg_committed_at_ms,
      pgEpochRevision: tomb.pg_epoch_revision,
    }) === tomb.tombstone_sha256
  );
}

/** Only an independently authenticated PM V11 read may supply this; there is no live provider. */
export interface TrustedPrivateV3PmPacket {
  source: 'independent_live_pm_v11_epoch_transition_v3';
  packet: unknown;
  expected: FactoryGpPgRebindV3Expected;
  verifiedAtMs: number;
}
export type ReadTrustedPrivateV3PmPacket = (
  ops: FactoryStorageOps,
  privateInvocation: object,
) => Promise<TrustedPrivateV3PmPacket | null>;
export type ResolvePrivateV3ChallengeIdentity = (
  privateInvocation: object,
) => { factoryOrgId: string; projectId: string; leaseIntentId: string; challengeId?: string } | null;

export class FactoryGpPgB1V3NativeStorageOps extends FactoryStorageDomain {
  readonly #enabled: boolean;
  readonly #resolveIdentity?: ResolvePrivateGpRevokeIdentity;
  readonly #resolveRevoke?: ResolvePrivateGpRevoke;
  readonly #resolveChallengeIdentity?: ResolvePrivateV3ChallengeIdentity;
  readonly #readPrivatePm?: ReadTrustedPrivateV3PmPacket;
  readonly #pinnedKey?: { keyId: string; publicKey: KeyObject };

  constructor(
    options: {
      enabled?: boolean;
      resolvePrivateRevokeIdentity?: ResolvePrivateGpRevokeIdentity;
      resolvePrivateRevoke?: ResolvePrivateGpRevoke;
      resolvePrivateChallengeIdentity?: ResolvePrivateV3ChallengeIdentity;
      readPrivatePmV11?: ReadTrustedPrivateV3PmPacket;
      pinnedPmKey?: { keyId: string; publicKey: KeyObject };
    } = {},
  ) {
    super('gp-pg-b1-v3-native-unmounted');
    this.#enabled = options.enabled === true;
    this.#resolveIdentity = options.resolvePrivateRevokeIdentity;
    this.#resolveRevoke = options.resolvePrivateRevoke;
    this.#resolveChallengeIdentity = options.resolvePrivateChallengeIdentity;
    this.#readPrivatePm = options.readPrivatePmV11;
    this.#pinnedKey = options.pinnedPmKey;
    if (
      this.#enabled &&
      (!this.#resolveIdentity ||
        !this.#resolveRevoke ||
        !this.#resolveChallengeIdentity ||
        !this.#readPrivatePm ||
        !this.#pinnedKey)
    )
      throw new Error('B1 V3 requires independently enrolled private GP and PM providers');
  }

  async init(): Promise<void> {
    // No migration even when accidentally registered in default-off mode.
    // Enabled path is for isolated explicit test registration ONLY.
    if (this.#enabled) await this.ensureCollections([...FACTORY_GP_PG_B1_V3_TEST_SCHEMAS]);
  }

  async dangerouslyClearAll(): Promise<void> {
    throw new Error('B1 V3 immutable ledger must not be bulk-cleared');
  }

  /**
   * Native PG-only B1 authenticated revoke and V3 tombstone mint in ONE
   * withTransaction + epoch updateAtomic lock. Existing legacy tombstones may
   * not be upgraded/retrofitted after the authenticated revocation.
   */
  async revokeWithTombstone(invocation: object): Promise<'revoked' | 'denied' | 'not_ready'> {
    if (!this.#enabled || !(this.storage instanceof PgFactoryStorage)) return 'not_ready';
    const identity = this.#resolveIdentity!(invocation);
    if (!identity?.factoryOrgId || !identity.projectId) return 'denied';
    try {
      return await this.storage.withTransaction(async ops => {
        if (!ops.databaseNow) return 'not_ready';
        const where = { org_id: identity.factoryOrgId, factory_project_id: identity.projectId };
        let committed = false;
        await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
          const revision = epoch.revision + 1;
          if (!Number.isSafeInteger(revision) || !safePos(revision)) return null;
          const gp = await this.#resolveRevoke!(ops, invocation);
          if (
            !gp ||
            gp.source !== 'authenticated_live_gp_revocation_v1' ||
            gp.actor !== 'gp' ||
            gp.gpSessionVerified !== true ||
            gp.originVerified !== true ||
            gp.csrfVerified !== true ||
            gp.factoryOrgId !== identity.factoryOrgId ||
            gp.projectId !== identity.projectId ||
            !uuid(gp.leaseId) ||
            !uuid(gp.writerOwnerId) ||
            !gp.ownerEpoch ||
            gp.ownerEpoch !== epoch.owner_epoch
          )
            return null;
          const now = await ops.databaseNow!();
          const at = now.getTime();
          if (!safePos(gp.verifiedAtMs) || gp.verifiedAtMs > at || at - gp.verifiedAtMs > 30000) return null;
          const lease = await ops.findOne<LeaseRow>(LEASES, where);
          if (lease && (lease.lease_id !== gp.leaseId || lease.manager_writer_id !== gp.writerOwnerId)) return null;
          if (await ops.findOne(REVOKED, { lease_intent_id: gp.leaseId })) return null;
          const original = await ops.insertOne<B1RevocationRow>(REVOKED, {
            ...where,
            lease_intent_id: gp.leaseId,
            writer_owner_id: gp.writerOwnerId,
            owner_epoch: gp.ownerEpoch,
            created_at: now,
          });
          if (!uuid(original.id)) throw new Error('B1_V3_NATIVE_ORIGINAL_ID_INVALID');
          // Fresh PG clock and native revision under the SAME row lock. The
          // digest is not a substitute for this physical native row.
          const recorded = await ops.databaseNow!();
          const revokeRequestId = randomUUID();
          const digest = canonicalV3AuthenticatedTombstoneDigest({
            version: 'factory_gp_pg_b1_authenticated_revoke_v3',
            orgId: identity.factoryOrgId,
            projectId: identity.projectId,
            leaseIntentId: gp.leaseId,
            oldWriterOwnerId: gp.writerOwnerId,
            ownerEpoch: gp.ownerEpoch,
            revokeRequestId,
            originalRevocationRowId: original.id,
            pgCommittedAtMs: recorded.getTime(),
            pgEpochRevision: revision,
          });
          if (!digest) throw new Error('B1_V3_NATIVE_TOMBSTONE_HASH_INVALID');
          await ops.insertOne(TOMBS, {
            ...where,
            lease_intent_id: gp.leaseId,
            old_writer_owner_id: gp.writerOwnerId,
            owner_epoch: gp.ownerEpoch,
            original_revocation_row_id: original.id,
            revoke_request_id: revokeRequestId,
            pg_committed_at_ms: recorded.getTime(),
            pg_epoch_revision: revision,
            tombstone_sha256: digest,
            created_at: recorded,
          });
          if (lease?.state === 'active') {
            await ops.updateMany(LEASES, where, { state: 'revoked', updated_at: recorded });
          }
          committed = true;
          return { revision, updated_at: recorded };
        });
        return committed ? 'revoked' : 'denied';
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) return 'denied';
      throw error;
    }
  }

  /**
   * Mint challenge only for an existing native original+V3 tombstone. Returns
   * private challenge bytes to the server-private caller; there is NO route.
   */
  async mintOneUseChallenge(invocation: object): Promise<{
    challengeId: string;
    challengeNonce: string;
    factoryChallengeSha256: string;
    expiresAtMs: number;
  } | null> {
    if (!this.#enabled || !(this.storage instanceof PgFactoryStorage)) return null;
    const identity = this.#resolveChallengeIdentity!(invocation);
    if (!identity?.factoryOrgId || !identity.projectId || !uuid(identity.leaseIntentId)) return null;
    return this.storage.withTransaction(async ops => {
      if (!ops.databaseNow) return null;
      const where = { org_id: identity.factoryOrgId, factory_project_id: identity.projectId };
      let issued: Awaited<ReturnType<FactoryGpPgB1V3NativeStorageOps['mintOneUseChallenge']>> = null;
      await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
        if (!epoch.owner_epoch) return null;
        const original = await ops.findOne<B1RevocationRow>(REVOKED, {
          ...where,
          lease_intent_id: identity.leaseIntentId,
          owner_epoch: epoch.owner_epoch,
        });
        const tomb = await ops.findOne<TombstoneRow>(TOMBS, {
          ...where,
          lease_intent_id: identity.leaseIntentId,
          owner_epoch: epoch.owner_epoch,
        });
        if (!original || !tomb || !committedNativeV3TombstoneMatches(original, tomb)) return null;
        const now = await ops.databaseNow!();
        const challengeId = randomUUID();
        const challengeNonce = randomBytes(32).toString('base64url');
        const challengeHash = createHash('sha256').update(challengeNonce).digest('hex');
        const expiry = now.getTime() + 5000;
        await ops.insertOne(CHALLENGES, {
          ...where,
          lease_intent_id: identity.leaseIntentId,
          challenge_id: challengeId,
          factory_challenge_sha256: challengeHash,
          tombstone_sha256: tomb.tombstone_sha256,
          issued_at_ms: now.getTime(),
          expires_at_ms: expiry,
          created_at: now,
        });
        issued = { challengeId, challengeNonce, factoryChallengeSha256: challengeHash, expiresAtMs: expiry };
        return { revision: epoch.revision };
      });
      return issued;
    });
  }

  /**
   * Audit-only one-use nonce CAS; verifies pinned PM V3 signature and exact
   * native old writer/tombstone/challenge while holding the same PG epoch row.
   * A committed nonce never grants a lease, rebind, or production write.
   */
  async consumePrivateV3Nonce(invocation: object): Promise<'consumed_audit_only' | 'denied' | 'not_ready'> {
    if (!this.#enabled || !(this.storage instanceof PgFactoryStorage)) return 'not_ready';
    const identity = this.#resolveChallengeIdentity!(invocation);
    if (!identity?.factoryOrgId || !identity.projectId || !uuid(identity.leaseIntentId) || !uuid(identity.challengeId))
      return 'denied';
    try {
      return await this.storage.withTransaction(async ops => {
        if (!ops.databaseNow) return 'not_ready';
        const where = { org_id: identity.factoryOrgId, factory_project_id: identity.projectId };
        let consumed = false;
        await ops.updateAtomic<EpochRow>(EPOCHS, where, async epoch => {
          if (!epoch.owner_epoch) return null;
          const original = await ops.findOne<B1RevocationRow>(REVOKED, {
            ...where,
            lease_intent_id: identity.leaseIntentId,
            owner_epoch: epoch.owner_epoch,
          });
          const tomb = await ops.findOne<TombstoneRow>(TOMBS, {
            ...where,
            lease_intent_id: identity.leaseIntentId,
            owner_epoch: epoch.owner_epoch,
          });
          if (!original || !tomb || !committedNativeV3TombstoneMatches(original, tomb)) return null;
          const challenge = await ops.findOne<ChallengeRow>(CHALLENGES, {
            ...where,
            lease_intent_id: identity.leaseIntentId,
            challenge_id: identity.challengeId,
            tombstone_sha256: tomb.tombstone_sha256,
          });
          if (!challenge) return null;
          const now = await ops.databaseNow!();
          const at = now.getTime();
          if (
            !safePos(challenge.issued_at_ms) ||
            !safePos(challenge.expires_at_ms) ||
            challenge.expires_at_ms > challenge.issued_at_ms + 5000 ||
            at >= challenge.expires_at_ms
          )
            return null;
          const pm = await this.#readPrivatePm!(ops, invocation);
          if (
            !pm ||
            pm.source !== 'independent_live_pm_v11_epoch_transition_v3' ||
            !safePos(pm.verifiedAtMs) ||
            pm.verifiedAtMs > at ||
            at - pm.verifiedAtMs > 5000
          )
            return null;
          const expected = pm.expected;
          if (
            expected.factoryOrgId !== identity.factoryOrgId ||
            expected.projectId !== identity.projectId ||
            expected.leaseIntentId !== identity.leaseIntentId ||
            expected.oldWriterOwnerId !== original.writer_owner_id ||
            expected.ownerEpoch !== original.owner_epoch ||
            expected.revokeRequestId !== tomb.revoke_request_id ||
            expected.factoryTombstoneSha256 !== tomb.tombstone_sha256 ||
            expected.challengeId !== challenge.challenge_id ||
            expected.factoryChallengeSha256 !== challenge.factory_challenge_sha256
          )
            return null;
          if (
            !inspectFactoryGpPgPostTombstoneV3({
              enabled: true,
              packet: pm.packet,
              pinnedKeyId: this.#pinnedKey!.keyId,
              pinnedPublicKey: this.#pinnedKey!.publicKey,
              expected,
              factoryDbNowMs: at,
            })
          )
            return null;
          const nonceScope = canonicalV3RebindNonceKey({
            version: 'factory_gp_pg_b1_rebind_nonce_v3',
            orgId: identity.factoryOrgId,
            projectId: identity.projectId,
            leaseIntentId: identity.leaseIntentId,
            challengeId: challenge.challenge_id,
            factoryChallengeSha256: challenge.factory_challenge_sha256,
            rebindNonceSha256: expected.rebindNonceSha256,
            factoryTombstoneSha256: tomb.tombstone_sha256,
            oldWriterOwnerId: original.writer_owner_id,
            oldWriterEpoch: expected.oldWriterEpoch,
            newWriterOwnerId: expected.newWriterOwnerId,
            newWriterEpoch: expected.newWriterEpoch,
            transitionChainSha256: expected.transitionChainSha256,
          });
          if (!nonceScope || typeof expected.rebindNonceSha256 !== 'string' || !HEX.test(expected.rebindNonceSha256))
            return null;
          // Recheck database clock immediately before unique insert. One-use
          // constraints survive concurrent transactions and server restart.
          if ((await ops.databaseNow!()).getTime() >= challenge.expires_at_ms) return null;
          const signature = (pm.packet as { signature: string }).signature;
          const packetDigest = createHash('sha256').update(signature).digest('hex');
          await ops.insertOne(NONCES, {
            ...where,
            lease_intent_id: identity.leaseIntentId,
            challenge_id: challenge.challenge_id,
            revoke_request_id: tomb.revoke_request_id,
            rebind_nonce_sha256: expected.rebindNonceSha256,
            nonce_scope_sha256: nonceScope,
            signed_packet_digest: packetDigest,
            old_writer_owner_id: original.writer_owner_id,
            old_writer_epoch: expected.oldWriterEpoch,
            new_writer_owner_id: expected.newWriterOwnerId,
            new_writer_epoch: expected.newWriterEpoch,
            transition_chain_sha256: expected.transitionChainSha256,
            created_at: now,
          });
          consumed = true;
          return { revision: epoch.revision };
        });
        return consumed ? 'consumed_audit_only' : 'denied';
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) return 'denied';
      throw error;
    }
  }
}
