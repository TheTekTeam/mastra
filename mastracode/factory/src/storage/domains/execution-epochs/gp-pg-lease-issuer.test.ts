import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomInt, randomUUID, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PgFactoryStorage } from '@mastra/pg';
import type { FactoryStorageOps } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.js';
import { FactoryExecutionOriginStorage } from '../execution-origin/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import { FactoryExecutionEpochStorage, FACTORY_EXECUTION_EPOCHS_SCHEMA } from './base.js';
import { FACTORY_CORE_MANAGER_LEASES_SCHEMA, FactoryManagedCoreEffectStorage } from './managed-effect.js';
import { verifyFactoryGpSignedPacket, gpV9ScopeTupleDigest } from './gp-pg-handover-crypto.js';
import type { GpHandoverScope, GpSignedHandoverPacket } from './gp-pg-handover-crypto.js';
import {
  FactoryGpPgLeaseIssuerStorage,
  FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA,
  FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA,
  FACTORY_GP_PG_HANDOVER_ISSUER_CAPABILITY,
} from './gp-pg-lease-issuer.js';
import type { VerifiedPrivateGpIssuerRequest, VerifiedPrivateGpRevoke } from './gp-pg-lease-issuer.js';

const pgUrl = process.env.FACTORY_A2D_PG_TEST_URL;
const NOW_MS = () => Date.now();
const DOMAIN = Buffer.from('PM_TO_FACTORY_GP_PG_HANDOVER_V1\0', 'utf8');
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical = (x: unknown): string => {
  if (x === null || ['string', 'boolean', 'number'].includes(typeof x)) return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  const v = x as Record<string, unknown>;
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
};

function scope(projectId: string): GpHandoverScope {
  return {
    consentRequestId: randomUUID(), manifestId: sha(randomUUID()),
    nonceSha256: sha(randomUUID()), projectId, factoryOrgId: 'org-managed-opaque',
    repositoryId: randomInt(1_000_000, 1_000_000_000),
    repositoryOwnerId: 2002,
    appInstallationId: randomInt(1_000_000, 1_000_000_000),
    writerOwnerId: 'pm-writer-verified', writerEpoch: 7,
    ownerEpoch: 'gp-owner-epoch-native-string', authorityRevision: 4,
    policyDigest: sha('policy'), scopeDigest: sha('scope'),
    sourceProofDigest: sha('source'), mode: 'supervised',
    nativeAutomationRevision: 0, mappingDigest: sha('B1-B2-map'),
    coverageVersion: 1, bridgeChallengeId: randomUUID(), leaseIntentId: randomUUID(),
  };
}
function signedPacket(s: GpHandoverScope, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): GpSignedHandoverPacket {
  const at = NOW_MS();
  const payload = {
    version: 'pm_factory_pg_handover_v1' as const,
    audience: 'factory_pg_handover_issuer' as const,
    issuer: 'factory-project-manager', keyId: 'test-gp-2026-11',
    issuedAtMs: at, expiresAtMs: at + 10000,
    scopeTupleSha256: gpV9ScopeTupleDigest(s), scope: s,
  };
  const signature = sign(null, Buffer.concat([DOMAIN, Buffer.from(canonical(payload))]), privateKey)
    .toString('base64url');
  return { alg: 'Ed25519', signature, payload };
}

const issuerRequests = new WeakMap<object, VerifiedPrivateGpIssuerRequest>();
const revocations = new WeakMap<object, VerifiedPrivateGpRevoke>();

function issuerOptions(key: ReturnType<typeof generateKeyPairSync>['publicKey']) {
  return {
    enabled: true,
    trustedKey: { keyId: 'test-gp-2026-11', publicKey: key },
    resolvePrivateRequest: async (ctx: object) => issuerRequests.get(ctx) ?? null,
    readAuthenticatedPm: async (ops: FactoryStorageOps, _ctx: object, s: GpHandoverScope) => {
      const at = (await ops.databaseNow!()).getTime();
      return {
        source: 'authenticated_live_pm_v9_authority_v1' as const,
        actor: 'gp' as const, current: true as const,
        gpSessionVerified: true as const, consentUnrevoked: true as const,
        consentConsumedOnce: true as const, projectSelected: true as const,
        projectMembershipVerified: true as const, writerPaused: true as const,
        dispatchPending: 0 as const,
        projectId: s.projectId, factoryOrgId: s.factoryOrgId,
        consentRequestId: s.consentRequestId, manifestId: s.manifestId,
        nonceSha256: s.nonceSha256, writerOwnerId: s.writerOwnerId,
        writerEpoch: s.writerEpoch, ownerEpoch: s.ownerEpoch,
        authorityRevision: s.authorityRevision, policyDigest: s.policyDigest,
        mode: s.mode, verifiedAtMs: at, heartbeatAtMs: at,
        writerLeaseExpiresAtMs: at + 30000,
      };
    },
    readNativeDrain: async (_ops: unknown, s: GpHandoverScope) => ({
      source: 'factory_pg_same_transaction_drain_v1' as const,
      projectId: s.projectId, factoryOrgId: s.factoryOrgId,
      coverageArmed: true as const, mappingDigest: s.mappingDigest,
      coverageVersion: s.coverageVersion,
      runningCount: 0 as const, parkedCount: 0 as const,
      pendingCount: 0 as const, unknownCount: 0 as const,
      unsettledEffectCount: 0 as const, remoteExecutionSupported: false as const,
    }),
    readLiveAppGrant: async (ops: FactoryStorageOps, s: GpHandoverScope,
      binding: { projectRepositoryLinkId: string; connectionId: string;
        repositoryRecordId: string; installationRecordId: string }) => ({
      source: 'authenticated_github_app_grant_v1' as const,
      grantActive: true as const,
      factoryOrgId: s.factoryOrgId, projectId: s.projectId,
      repositoryId: s.repositoryId, repositoryOwnerId: s.repositoryOwnerId,
      appInstallationId: s.appInstallationId!,
      ...binding, verifiedAtMs: (await ops.databaseNow!()).getTime(),
    }),
    resolvePrivateRevokeIdentity: (ctx: object) => {
      const x = revocations.get(ctx);
      return x ? { factoryOrgId: x.factoryOrgId, projectId: x.projectId } : null;
    },
    resolvePrivateRevoke: async (_ops: unknown, ctx: object) => revocations.get(ctx) ?? null,
  };
}

async function fixture() {
  if (!pgUrl) throw new Error('FACTORY_A2D_PG_TEST_URL required');
  const keys = generateKeyPairSync('ed25519');
  const storage = new PgFactoryStorage({ connectionString: pgUrl });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const epochs = storage.registerDomain(new FactoryExecutionEpochStorage());
  storage.registerDomain(new SourceControlStorage());
  storage.registerDomain(new FactoryExecutionOriginStorage(async () => null));
  storage.registerDomain(new FactoryManagedCoreEffectStorage());
  const issuer = storage.registerDomain(new FactoryGpPgLeaseIssuerStorage(issuerOptions(keys.publicKey)));
  await storage.init();
  const project = await projects.create({
    orgId: 'org-managed-opaque', userId: 'gp-native-owner', input: { name: 'HTAI test ' + randomUUID() },
  });
  const s = scope(project.id);
  const now = new Date();
  const installation = await storage.ops.insertOne('source_control_installations', {
    org_id: s.factoryOrgId, integration_id: 'github',
    connected_by_user_id: 'gp-native-owner', external_id: String(s.appInstallationId),
    provider_metadata: {}, created_at: now,
  }) as { id: string };
  const repo = await storage.ops.insertOne('source_control_repositories', {
    installation_id: installation.id, external_id: String(s.repositoryId),
    slug: 'TheTekTeam/HTAI', default_branch: 'main', provider_metadata: {},
    created_at: now, updated_at: now,
  }) as { id: string };
  const connection = await storage.ops.insertOne('factory_project_source_control_connections', {
    factory_project_id: s.projectId, integration_id: 'github',
    installation_id: installation.id, created_by_user_id: 'gp-native-owner',
    created_at: now,
  }) as { id: string };
  await storage.ops.insertOne('factory_project_repositories', {
    connection_id: connection.id, repository_id: repo.id,
    created_by_user_id: 'gp-native-owner',
    sandbox_provider: 'local', sandbox_workdir: '/tmp',
    created_at: now, updated_at: now,
  });
  await epochs.provisionUnarmed({ orgId: s.factoryOrgId, projectId: s.projectId });
  await storage.withTransaction(async ops => {
    await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name,
      { org_id: s.factoryOrgId, factory_project_id: s.projectId },
      () => ({ fence_armed: true, coverage_version: 1, mapping_digest: s.mappingDigest }));
  });
  expect(await epochs.tryQuiesce({ orgId: s.factoryOrgId, projectId: s.projectId,
    expectedRevision: 0, ownerEpoch: s.ownerEpoch })).toBe('quiescing');
  const packet = signedPacket(s, keys.privateKey);
  const ctx = Object.freeze({ testPrivate: Symbol('gp-v9') });
  issuerRequests.set(ctx, { packet, scope: s, ttlSeconds: 60 });
  return { storage, issuer, s, packet, ctx, keys };
}
function revokeContext(s: GpHandoverScope) {
  const ctx = Object.freeze({ testPrivate: Symbol('gp-revoke') });
  revocations.set(ctx, {
    source: 'authenticated_live_gp_revocation_v1', actor: 'gp',
    gpSessionVerified: true, originVerified: true, csrfVerified: true,
    factoryOrgId: s.factoryOrgId, projectId: s.projectId,
    leaseId: s.leaseIntentId, writerOwnerId: s.writerOwnerId,
    ownerEpoch: s.ownerEpoch, verifiedAtMs: NOW_MS(),
  });
  return ctx;
}

function pgWorker(mode: 'issue' | 'revoke', f: Awaited<ReturnType<typeof fixture>>) {
  const source = fileURLToPath(new URL('./gp-pg-lease-issuer.worker.mts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', source], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACTORY_A2D_PG_TEST_URL: pgUrl!,
      FACTORY_GP_PG_WORKER_MODE: mode,
      FACTORY_GP_PG_WORKER_INPUT: JSON.stringify({
        scope: f.s, packet: f.packet,
        publicKeyPem: f.keys.publicKey.export({ type: 'spki', format: 'pem' }),
      }),
    },
  });
  let stdout = '', stderr = '', readyDone = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve; readyReject = reject;
  });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (!readyDone && stdout.includes('READY\n')) {
      readyDone = true; readyResolve();
    }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const completed = new Promise<{ status: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (!readyDone) readyReject(new Error('PG worker failed before barrier: ' + stderr.slice(-500)));
      const line = stdout.split('\n').find(x => x.startsWith('RESULT:'));
      if (code !== 0 || !line) reject(new Error('PG worker exited ' + code + ': ' + stderr.slice(-500)));
      else resolve(JSON.parse(line.slice('RESULT:'.length)) as { status: string });
    });
  });
  return { ready, completed, start: () => child.stdin.end('go\n'), stop: () => child.kill() };
}

describe('Factory GP PG issuer source admission', () => {
  it('has no production installer and cannot issue by default', () => {
    expect(FACTORY_GP_PG_HANDOVER_ISSUER_CAPABILITY).toMatchObject({
      adoptionReady: false, runtimeInstalled: false, enabledByDefault: false,
      remoteExecutionSupported: false, providerEagerSupported: false,
    });
    expect(new FactoryGpPgLeaseIssuerStorage()).toBeDefined();
    expect(() => new FactoryGpPgLeaseIssuerStorage({ enabled: true })).toThrow(
      /owner-private trust providers/);
  });
  it('verifies signed scopes using the actual Ed25519 packet, not boolean JSON', () => {
    const keys = generateKeyPairSync('ed25519'), s = scope(randomUUID());
    const packet = signedPacket(s, keys.privateKey);
    const good = verifyFactoryGpSignedPacket({ packet, expectedScope: s,
      trustedKey: { keyId: 'test-gp-2026-11', publicKey: keys.publicKey }, now: new Date() });
    expect(good?.scopeTupleSha256).toBe(gpV9ScopeTupleDigest(s));
    expect(verifyFactoryGpSignedPacket({ packet: { ...packet, signature: 'A'.repeat(86) },
      expectedScope: s, trustedKey: { keyId: 'test-gp-2026-11', publicKey: keys.publicKey },
      now: new Date() })).toBeNull();
    expect(verifyFactoryGpSignedPacket({ packet, expectedScope: { ...s, factoryOrgId: 'other-org' },
      trustedKey: { keyId: 'test-gp-2026-11', publicKey: keys.publicKey },
      now: new Date() })).toBeNull();
  });
});

describe.skipIf(!pgUrl)('actual PG18 lock-first GP lease issue/revoke', () => {
  it('issues once, persists unique challenge and rejects stale/replayed/cross-tenant packets', async () => {
    const f = await fixture();
    try {
      expect(await f.issuer.issue({ ...f.ctx })).toBe('denied');
      expect(await f.issuer.issue(f.ctx)).toBe('issued');
      expect(await f.issuer.issue(f.ctx)).toBe('denied');
      const where = { org_id: f.s.factoryOrgId, factory_project_id: f.s.projectId };
      const lease = await f.storage.ops.findOne(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where);
      expect(lease).toMatchObject({ lease_id: f.s.leaseIntentId, state: 'active' });
      const ledger = await f.storage.ops.findMany(FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA.name, where);
      expect(ledger).toHaveLength(1);
      await f.storage.ops.updateMany('factory_projects', { id: f.s.projectId },
        { auto_run_enabled: true });
      const second = Object.freeze({ newer: true });
      issuerRequests.set(second, { ...issuerRequests.get(f.ctx)!,
        packet: signedPacket({ ...f.s, consentRequestId: randomUUID() }, f.keys.privateKey) });
      expect(await f.issuer.issue(second)).toBe('denied');
    } finally { await f.storage.close(); }
  });

  it('revoke-before-issue leaves immutable tombstone and denies later issue', async () => {
    const f = await fixture();
    try {
      expect(await f.issuer.revoke(revokeContext(f.s))).toBe('revoked');
      expect(await f.issuer.issue(f.ctx)).toBe('denied');
      const rows = await f.storage.ops.findMany(FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA.name,
        { lease_intent_id: f.s.leaseIntentId });
      expect(rows).toHaveLength(1);
    } finally { await f.storage.close(); }
  });

  it('two OS processes cannot double-consume the same signed challenge', async () => {
    const f = await fixture();
    const a = pgWorker('issue', f), b = pgWorker('issue', f);
    try {
      await Promise.all([a.ready, b.ready]);
      a.start();b.start();
      const result = await Promise.all([a.completed, b.completed]);
      expect(result.map(x => x.status).sort()).toEqual(['denied', 'issued']);
      const rows = await f.storage.ops.findMany(FACTORY_GP_PG_HANDOVER_CONSUMPTIONS_SCHEMA.name,
        { consent_request_id: f.s.consentRequestId });
      expect(rows).toHaveLength(1);
    } finally { a.stop();b.stop();await f.storage.close(); }
  }, 30000);

  it('two OS processes serialize issue/revoke; revoke-first tombstone or revoke-after-issue always denies new effects', async () => {
    const f = await fixture();
    const issue = pgWorker('issue', f), revoke = pgWorker('revoke', f);
    try {
      await Promise.all([issue.ready, revoke.ready]);
      issue.start();revoke.start();
      const [started, stopped] = await Promise.all([issue.completed, revoke.completed]);
      expect(['issued', 'denied']).toContain(started.status);
      expect(stopped.status).toBe('revoked');
      const tombstones = await f.storage.ops.findMany(FACTORY_GP_PG_HANDOVER_REVOCATIONS_SCHEMA.name,
        { lease_intent_id: f.s.leaseIntentId });
      expect(tombstones).toHaveLength(1);
      const lease = await f.storage.ops.findOne<Record<string, unknown>>(
        FACTORY_CORE_MANAGER_LEASES_SCHEMA.name,
        { org_id: f.s.factoryOrgId, factory_project_id: f.s.projectId });
      expect(lease?.state).not.toBe('active');
      expect(await f.issuer.issue(f.ctx)).toBe('denied');
    } finally { issue.stop();revoke.stop();await f.storage.close(); }
  }, 30000);
});
