import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PgFactoryStorage } from '@mastra/pg';
import type { FactoryStorageOps } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';

import { FactoryExecutionEpochStorage, FACTORY_EXECUTION_EPOCHS_SCHEMA } from './base.js';
import { FactoryManagedCoreEffectStorage } from './managed-effect.js';
import { FactoryGpPgB1V3NativeStorageOps } from './gp-pg-b1-v3-native-storageops.js';
import { FACTORY_GP_PG_REBIND_V3_FIELDS, inspectFactoryGpPgPostTombstoneV3 } from './gp-pg-post-tombstone-v3.js';
import type { FactoryGpPgRebindV3Expected } from './gp-pg-post-tombstone-v3.js';
import type { VerifiedPrivateGpRevoke } from './gp-pg-lease-issuer.js';

// Source-only, uninstalled, synthetic PRIVATE TEST SEAM (no GP/PM session
// fabricated; this tests native PG StorageOps atomicity, not authentication).
// The Python harness creates a unique UID995 rootless PG18 DB and supplies
// both variables; arbitrary Factory PostgreSQL URLs fail this explicit gate.
const url = process.env.FACTORY_GP_B1_V3_NATIVE_PG_TEST_URL;
const marker = process.env.FACTORY_GP_B1_V3_NATIVE_EPHEMERAL_MARKER;
const admitted =
  marker?.startsWith('factory_b1_v3_') &&
  url?.startsWith('postgresql://postgres:') &&
  url.includes('@127.0.0.1:') &&
  url.endsWith('/' + marker);
const describePg = admitted ? describe : describe.skip;

const identities = new WeakMap<object, VerifiedPrivateGpRevoke>();
const challenges = new WeakMap<object, { factoryOrgId: string; projectId: string; leaseIntentId: string }>();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const v = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map(key => JSON.stringify(key) + ':' + canonical(v[key]))
      .join(',') +
    '}'
  );
}
function challengeContext(s: { orgId: string; projectId: string; leaseId: string }) {
  const ctx = Object.freeze({ privateChallengeOnly: Symbol('test-only') });
  challenges.set(ctx, { factoryOrgId: s.orgId, projectId: s.projectId, leaseIntentId: s.leaseId });
  return ctx;
}
function worker(input: Record<string, unknown>) {
  const source = fileURLToPath(new URL('./gp-pg-b1-v3-native-pg18.worker.mts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', source], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FACTORY_GP_B1_V3_NATIVE_WORKER_INPUT: JSON.stringify(input) },
  });
  let output = '',
    errors = '',
    resolvedReady = false;
  let resolveReady!: () => void, rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (!resolvedReady && output.includes('READY\n')) {
      resolvedReady = true;
      resolveReady();
    }
  });
  child.stderr.on('data', chunk => {
    errors += String(chunk);
  });
  const complete = new Promise<{ status: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (!resolvedReady) rejectReady(new Error('worker missing READY: ' + errors.slice(-500)));
      const line = output.split('\n').find(row => row.startsWith('RESULT:'));
      if (code !== 0 || !line) reject(new Error('worker exit ' + code + ': ' + errors.slice(-700)));
      else resolve(JSON.parse(line.slice('RESULT:'.length)) as { status: string });
    });
  });
  return {
    ready,
    complete,
    start: (payload: Record<string, unknown>) => child.stdin.end(JSON.stringify(payload) + '\n'),
    stop: () => child.kill(),
  };
}

async function open() {
  if (!admitted || !url) throw new Error('DENIED: isolated native PG18 harness required');
  const { publicKey } = generateKeyPairSync('ed25519');
  const storage = new PgFactoryStorage({ connectionString: url });
  storage.registerDomain(new FactoryExecutionEpochStorage());
  storage.registerDomain(new FactoryManagedCoreEffectStorage());
  const native = storage.registerDomain(
    new FactoryGpPgB1V3NativeStorageOps({
      enabled: true,
      resolvePrivateRevokeIdentity: ctx => {
        const s = identities.get(ctx);
        return s ? { factoryOrgId: s.factoryOrgId, projectId: s.projectId } : null;
      },
      resolvePrivateRevoke: async (_ops: FactoryStorageOps, ctx) => identities.get(ctx) ?? null,
      resolvePrivateChallengeIdentity: ctx => challenges.get(ctx) ?? null,
      readPrivatePmV11: async () => null,
      pinnedPmKey: { keyId: 'test-only-unenrolled-key', publicKey },
    }),
  );
  await storage.init();
  return { storage, native };
}
function context(scope: { orgId: string; projectId: string; leaseId: string; writerId: string; ownerEpoch: string }) {
  const ctx = Object.freeze({ privateTestOnly: Symbol('no-live-GP-signer') });
  identities.set(ctx, {
    source: 'authenticated_live_gp_revocation_v1',
    actor: 'gp',
    gpSessionVerified: true,
    originVerified: true,
    csrfVerified: true,
    factoryOrgId: scope.orgId,
    projectId: scope.projectId,
    leaseId: scope.leaseId,
    writerOwnerId: scope.writerId,
    ownerEpoch: scope.ownerEpoch,
    verifiedAtMs: Date.now(),
  });
  return ctx;
}

describePg('Factory native B1 V3 raw proposal + real PG18 StorageOps (never live)', () => {
  it('honours raw SQL FK and immutable triggers through ensureCollections', async () => {
    const a = await open();
    try {
      const rows = await a.storage.ops.findMany('factory_gp_pg_b1_v3_tombstones', {});
      expect(rows).toEqual([]);
      const wrongOriginal = await a.storage
        .withTransaction(ops =>
          ops.insertOne('factory_gp_pg_b1_v3_tombstones', {
            org_id: 'test',
            factory_project_id: randomUUID(),
            lease_intent_id: randomUUID(),
            old_writer_owner_id: randomUUID(),
            owner_epoch: 'test',
            original_revocation_row_id: randomUUID(),
            revoke_request_id: randomUUID(),
            pg_epoch_revision: 1,
            pg_committed_at_ms: Date.now(),
            tombstone_sha256: 'f'.repeat(64),
            created_at: new Date(),
          }),
        )
        .then(
          () => true,
          () => false,
        );
      expect(wrongOriginal).toBe(false);
    } finally {
      await a.storage.close();
    }
  });

  it('native PG transaction rolls back original B1 row when exact-scope tombstone FK rejects', async () => {
    const a = await open();
    try {
      const scope = {
        orgId: 'isolated-' + randomUUID(),
        projectId: randomUUID(),
        leaseId: randomUUID(),
        writerId: randomUUID(),
        ownerEpoch: 'isolated-epoch-' + randomUUID(),
      };
      await expect(
        a.storage.withTransaction(async ops => {
          const original = await ops.insertOne<{ id: string }>('factory_gp_pg_handover_revocations', {
            org_id: scope.orgId,
            factory_project_id: scope.projectId,
            lease_intent_id: scope.leaseId,
            writer_owner_id: scope.writerId,
            owner_epoch: scope.ownerEpoch,
            created_at: new Date(),
          });
          await ops.insertOne('factory_gp_pg_b1_v3_tombstones', {
            org_id: scope.orgId,
            factory_project_id: scope.projectId,
            lease_intent_id: randomUUID(), // deliberate mismatch after original insert
            old_writer_owner_id: scope.writerId,
            owner_epoch: scope.ownerEpoch,
            original_revocation_row_id: original.id,
            revoke_request_id: randomUUID(),
            pg_epoch_revision: 1,
            pg_committed_at_ms: Date.now(),
            tombstone_sha256: sha(randomUUID()),
            created_at: new Date(),
          });
        }),
      ).rejects.toThrow();
      expect(
        await a.storage.ops.count('factory_gp_pg_handover_revocations', {
          org_id: scope.orgId,
          factory_project_id: scope.projectId,
        }),
      ).toBe(0);
      expect(
        await a.storage.ops.count('factory_gp_pg_b1_v3_tombstones', {
          org_id: scope.orgId,
          factory_project_id: scope.projectId,
        }),
      ).toBe(0);
    } finally {
      await a.storage.close();
    }
  });

  it('two independent native StorageOps clients serialize authenticated revoke and persist one tombstone', async () => {
    const a = await open(),
      b = await open();
    try {
      const scope = {
        orgId: 'isolated-' + randomUUID(),
        projectId: randomUUID(),
        leaseId: randomUUID(),
        writerId: randomUUID(),
        ownerEpoch: 'isolated-epoch-' + randomUUID(),
      };
      await a.storage.ops.insertOne(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, {
        org_id: scope.orgId,
        factory_project_id: scope.projectId,
        revision: 1,
        state: 'quiescing',
        owner_epoch: scope.ownerEpoch,
        fence_armed: true,
        coverage_version: 1,
        mapping_revision: 0,
        mapping_digest: 'test-only',
        created_at: new Date(),
        updated_at: new Date(),
      });
      const results = await Promise.all([
        a.native.revokeWithTombstone(context(scope)),
        b.native.revokeWithTombstone(context(scope)),
      ]);
      expect(results.sort()).toEqual(['denied', 'revoked']);
      const original = await a.storage.ops.findMany('factory_gp_pg_handover_revocations', {
        org_id: scope.orgId,
        factory_project_id: scope.projectId,
      });
      const tomb = await a.storage.ops.findMany('factory_gp_pg_b1_v3_tombstones', {
        org_id: scope.orgId,
        factory_project_id: scope.projectId,
      });
      expect(original).toHaveLength(1);
      expect(tomb).toHaveLength(1);
      expect(tomb[0]).toMatchObject({
        original_revocation_row_id: original[0]?.id,
        revoke_request_id: expect.any(String),
        tombstone_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(await a.native.revokeWithTombstone(context(scope))).toBe('denied');
      const forbidden = await a.storage
        .withTransaction(ops =>
          ops.updateMany(
            'factory_gp_pg_b1_v3_tombstones',
            { org_id: scope.orgId },
            {
              owner_epoch: 'forged',
            },
          ),
        )
        .then(
          () => true,
          () => false,
        );
      expect(forbidden).toBe(false);
    } finally {
      await b.storage.close();
      await a.storage.close();
    }
  });

  it('two independent Node processes race signed nonce CAS; replay fails in a fresh client', async () => {
    const a = await open();
    const spawned: ReturnType<typeof worker>[] = [];
    try {
      const scope = {
        orgId: 'isolated-' + randomUUID(),
        projectId: randomUUID(),
        leaseId: randomUUID(),
        writerId: randomUUID(),
        ownerEpoch: 'isolated-epoch-' + randomUUID(),
      };
      await a.storage.ops.insertOne(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, {
        org_id: scope.orgId,
        factory_project_id: scope.projectId,
        revision: 1,
        state: 'quiescing',
        owner_epoch: scope.ownerEpoch,
        fence_armed: true,
        coverage_version: 1,
        mapping_revision: 0,
        mapping_digest: 'test-only',
        created_at: new Date(),
        updated_at: new Date(),
      });
      expect(await a.native.revokeWithTombstone(context(scope))).toBe('revoked');
      const tomb = await a.storage.ops.findOne<Record<string, string>>('factory_gp_pg_b1_v3_tombstones', {
        org_id: scope.orgId,
        factory_project_id: scope.projectId,
      });
      expect(tomb).not.toBeNull();
      if (!tomb) throw new Error('missing native B1 tombstone');
      // Import/start all three independent processes BEFORE the five-second
      // challenge begins; avoid a CI machine-speed race masking nonce CAS.
      const keys = generateKeyPairSync('ed25519');
      const workerInit = {
        pinnedKeyId: 'source-only-ephemeral-test-key',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      };
      const left = worker(workerInit),
        right = worker(workerInit),
        fresh = worker(workerInit);
      spawned.push(left, right, fresh);
      await Promise.all([left.ready, right.ready, fresh.ready]);
      const challenge = await a.native.mintOneUseChallenge(challengeContext(scope));
      expect(challenge?.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      if (!challenge) throw new Error('native one-use challenge missing');
      const issuedAt = Date.now();
      const payload = {
        version: 'pm_gp_pg_post_tombstone_rebind_v3',
        audience: 'factory_pg_epoch_locked_rebind',
        phase: 'post_tombstone_rebind',
        keyId: 'source-only-ephemeral-test-key',
        challengeId: challenge.challengeId,
        factoryChallengeSha256: challenge.factoryChallengeSha256,
        issuedAtMs: issuedAt,
        expiresAtMs: Math.min(issuedAt + 4500, challenge.expiresAtMs),
        consentRequestId: randomUUID(),
        manifestId: sha('manifest'),
        projectId: scope.projectId,
        factoryOrgId: scope.orgId,
        repositoryId: 234455,
        repositoryOwnerId: 98776,
        appInstallationId: 123457,
        policyDigest: sha('policy'),
        scopeDigest: sha('scope'),
        sourceProofDigest: sha('source'),
        authorityRevision: 3,
        ownerEpoch: scope.ownerEpoch,
        leaseIntentId: scope.leaseId,
        scopeTupleSha256: sha('old-scope'),
        oldWriterOwnerId: scope.writerId,
        oldWriterEpoch: 7,
        newWriterOwnerId: randomUUID(),
        newWriterEpoch: 8,
        transitionChainSha256: sha('test-only-writer-chain'),
        revokeRequestId: tomb.revoke_request_id,
        factoryTombstoneSha256: tomb.tombstone_sha256,
        rebindNonceSha256: sha('one-use-' + randomUUID()),
      };
      const signature = sign(
        null,
        Buffer.concat([Buffer.from('PM_TO_FACTORY_PRIVATE_GP_REBIND_V3\0'), Buffer.from(canonical(payload))]),
        keys.privateKey,
      ).toString('base64url');
      const packet = { alg: 'Ed25519', payload, signature };
      const expected = Object.fromEntries(
        FACTORY_GP_PG_REBIND_V3_FIELDS.filter(
          key => !['version', 'audience', 'phase', 'keyId', 'issuedAtMs', 'expiresAtMs'].includes(key),
        ).map(key => [key, payload[key as keyof typeof payload]]),
      ) as FactoryGpPgRebindV3Expected;
      expect(
        inspectFactoryGpPgPostTombstoneV3({
          enabled: true,
          packet,
          expected,
          pinnedKeyId: payload.keyId,
          pinnedPublicKey: keys.publicKey,
          factoryDbNowMs: Date.now(),
        }),
      ).toMatchObject({ cryptographicallyVerified: true, authorizesFactoryWrites: false });
      const workerPayload = {
        orgId: scope.orgId,
        projectId: scope.projectId,
        leaseId: scope.leaseId,
        challengeId: challenge.challengeId,
        expected,
        packet,
      };
      left.start(workerPayload);
      right.start(workerPayload);
      const results = await Promise.all([left.complete, right.complete]);
      expect(results.map(r => r.status).sort()).toEqual(['consumed_audit_only', 'denied']);
      const nonces = await a.storage.ops.findMany('factory_gp_pg_b1_v3_consumed_nonces', {
        org_id: scope.orgId,
        factory_project_id: scope.projectId,
      });
      expect(nonces).toHaveLength(1);
      expect(nonces[0]).toMatchObject({
        challenge_id: challenge.challengeId,
        revoke_request_id: tomb.revoke_request_id,
      });
      // Verify the retry happens before expiry; otherwise expiry could mask
      // a missing persistent unique-CAS replay rejection.
      expect((await a.storage.ops.databaseNow!()).getTime()).toBeLessThan(challenge.expiresAtMs);
      fresh.start(workerPayload);
      expect((await fresh.complete).status).toBe('denied');
    } finally {
      for (const w of spawned) w.stop();
      await a.storage.close();
    }
  });
});
