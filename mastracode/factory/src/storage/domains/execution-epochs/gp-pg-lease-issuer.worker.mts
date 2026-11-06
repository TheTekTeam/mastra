/**
 * Isolated test-only two-OS-process barrier worker for GP PG issue/revoke.
 * Does not load a real operator key, PM session or production Factory service.
 */
import { createPublicKey } from 'node:crypto';

import { PgFactoryStorage } from '@mastra/pg';

import { FactoryProjectsStorage } from '../projects/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import { FactoryExecutionOriginStorage } from '../execution-origin/base.js';
import { FactoryExecutionEpochStorage } from './base.js';
import { FactoryManagedCoreEffectStorage } from './managed-effect.js';
import { FactoryGpPgLeaseIssuerStorage } from './gp-pg-lease-issuer.js';
import type { GpHandoverScope, GpSignedHandoverPacket } from './gp-pg-handover-crypto.js';

const pgUrl = process.env.FACTORY_A2D_PG_TEST_URL;
const mode = process.env.FACTORY_GP_PG_WORKER_MODE;
const encoded = process.env.FACTORY_GP_PG_WORKER_INPUT;
if (!pgUrl || !encoded || (mode !== 'issue' && mode !== 'revoke'))
  throw new Error('test-only GP PG barrier worker configuration missing');
const parsed = JSON.parse(encoded) as {
  scope: GpHandoverScope; packet: GpSignedHandoverPacket; publicKeyPem: string;
};
const publicKey = createPublicKey(parsed.publicKeyPem);
const storage = new PgFactoryStorage({ connectionString: pgUrl });
storage.registerDomain(new FactoryProjectsStorage());
storage.registerDomain(new SourceControlStorage());
storage.registerDomain(new FactoryExecutionOriginStorage(async () => null));
storage.registerDomain(new FactoryExecutionEpochStorage());
storage.registerDomain(new FactoryManagedCoreEffectStorage());
const invocation = Object.freeze({ privateTest: Symbol('gp-pg-os-worker') });
const issuer = storage.registerDomain(new FactoryGpPgLeaseIssuerStorage({
  enabled: true,
  trustedKey: { keyId: 'test-gp-2026-11', publicKey },
  resolvePrivateRequest: async ctx => ctx === invocation ? {
    scope: parsed.scope, packet: parsed.packet, ttlSeconds: 60,
  } : null,
  readAuthenticatedPm: async (ops, ctx, s) => {
    if (ctx !== invocation) return null;
    const at = (await ops.databaseNow!()).getTime();
    return {
      source: 'authenticated_live_pm_v9_authority_v1', actor: 'gp',
      current: true, gpSessionVerified: true, consentUnrevoked: true,
      consentConsumedOnce: true, projectSelected: true, projectMembershipVerified: true,
      writerPaused: true, dispatchPending: 0,
      projectId: s.projectId, factoryOrgId: s.factoryOrgId,
      consentRequestId: s.consentRequestId, manifestId: s.manifestId,
      nonceSha256: s.nonceSha256, writerOwnerId: s.writerOwnerId,
      writerEpoch: s.writerEpoch, ownerEpoch: s.ownerEpoch,
      authorityRevision: s.authorityRevision, policyDigest: s.policyDigest,
      mode: s.mode, verifiedAtMs: at, heartbeatAtMs: at,
      writerLeaseExpiresAtMs: at + 30000,
    };
  },
  readNativeDrain: async (_ops, s) => ({
    source: 'factory_pg_same_transaction_drain_v1',
    projectId: s.projectId, factoryOrgId: s.factoryOrgId,
    coverageArmed: true, mappingDigest: s.mappingDigest,
    coverageVersion: s.coverageVersion,
    runningCount: 0, parkedCount: 0, pendingCount: 0,
    unknownCount: 0, unsettledEffectCount: 0,
    remoteExecutionSupported: false,
  }),
  readLiveAppGrant: async (ops, s, binding) => ({
    source: 'authenticated_github_app_grant_v1', grantActive: true,
    factoryOrgId: s.factoryOrgId, projectId: s.projectId,
    repositoryId: s.repositoryId, repositoryOwnerId: s.repositoryOwnerId,
    appInstallationId: s.appInstallationId!,
    ...binding, verifiedAtMs: (await ops.databaseNow!()).getTime(),
  }),
  resolvePrivateRevokeIdentity: ctx => ctx === invocation ? {
    factoryOrgId: parsed.scope.factoryOrgId,
    projectId: parsed.scope.projectId,
  } : null,
  resolvePrivateRevoke: async (ops, ctx) => {
    if (ctx !== invocation) return null;
    return {
      source: 'authenticated_live_gp_revocation_v1',
      actor: 'gp', gpSessionVerified: true, originVerified: true,
      csrfVerified: true, factoryOrgId: parsed.scope.factoryOrgId,
      projectId: parsed.scope.projectId,
      leaseId: parsed.scope.leaseIntentId,
      writerOwnerId: parsed.scope.writerOwnerId,
      ownerEpoch: parsed.scope.ownerEpoch,
      verifiedAtMs: (await ops.databaseNow!()).getTime(),
    };
  },
}));
await storage.init();
process.stdout.write('READY\n');
try {
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('data', chunk => String(chunk).includes('go') ? resolve() : reject(new Error('barrier mismatch')));
    process.stdin.once('error', reject);
  });
  const status = mode === 'issue' ? await issuer.issue(invocation) : await issuer.revoke(invocation);
  process.stdout.write('RESULT:' + JSON.stringify({ status }) + '\n');
} finally {
  await storage.close();
}
