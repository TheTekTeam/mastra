/**
 * Independent Node process; source-only test key and private test seam.
 * Starts BEFORE challenge issuance to keep the real five-second nonce window.
 * NEVER represents live independent GP/PM authority or authorizes a write.
 */
import { createPublicKey } from 'node:crypto';
import { PgFactoryStorage } from '@mastra/pg';
import { FactoryExecutionEpochStorage } from './base.js';
import { FactoryGpPgB1V3NativeStorageOps } from './gp-pg-b1-v3-native-storageops.js';
import type { FactoryGpPgRebindV3Expected } from './gp-pg-post-tombstone-v3.js';
import { FactoryManagedCoreEffectStorage } from './managed-effect.js';

const url = process.env.FACTORY_GP_B1_V3_NATIVE_PG_TEST_URL;
const marker = process.env.FACTORY_GP_B1_V3_NATIVE_EPHEMERAL_MARKER;
if (
  !marker?.startsWith('factory_b1_v3_') ||
  !url?.startsWith('postgresql://postgres:') ||
  !url.includes('@127.0.0.1:') ||
  !url.endsWith('/' + marker)
) {
  throw new Error('DENIED: isolated local rootless PG18 only');
}
interface WorkerInit {
  pinnedKeyId: string;
  publicKeyPem: string;
}
interface WorkerPayload {
  orgId: string;
  projectId: string;
  leaseId: string;
  challengeId: string;
  expected: FactoryGpPgRebindV3Expected;
  packet: unknown;
}
const init = JSON.parse(process.env.FACTORY_GP_B1_V3_NATIVE_WORKER_INPUT || 'null') as WorkerInit;
if (!init?.pinnedKeyId || !init?.publicKeyPem) throw new Error('DENIED: missing test-only pinned key');
let s: WorkerPayload | null = null;
const privateInvocation = Object.freeze({ isolatedWorker: true });
const storage = new PgFactoryStorage({ connectionString: url });
storage.registerDomain(new FactoryExecutionEpochStorage());
storage.registerDomain(new FactoryManagedCoreEffectStorage());
const native = storage.registerDomain(
  new FactoryGpPgB1V3NativeStorageOps({
    enabled: true,
    resolvePrivateRevokeIdentity: () => null,
    resolvePrivateRevoke: async () => null,
    resolvePrivateChallengeIdentity: ctx =>
      ctx === privateInvocation && s
        ? {
            factoryOrgId: s.orgId,
            projectId: s.projectId,
            leaseIntentId: s.leaseId,
            challengeId: s.challengeId,
          }
        : null,
    readPrivatePmV11: async (ops, ctx) => {
      if (ctx !== privateInvocation || !s) return null;
      // Reproduce a PM verification that completes strictly after the native
      // transaction's initial clock read. Without a fresh PG clock check,
      // both workers can be incorrectly denied before nonce CAS.
      await new Promise(resolve => setTimeout(resolve, 15));
      return {
        source: 'independent_live_pm_v11_epoch_transition_v3',
        packet: s.packet,
        expected: s.expected,
        verifiedAtMs: (await ops.databaseNow!()).getTime(),
      };
    },
    pinnedPmKey: { keyId: init.pinnedKeyId, publicKey: createPublicKey(init.publicKeyPem) },
  }),
);
await storage.init();
process.stdout.write('READY\n');
let pending = '';
process.stdin.on('data', async chunk => {
  pending += String(chunk);
  if (!pending.includes('\n')) return;
  process.stdin.removeAllListeners('data');
  try {
    s = JSON.parse(pending.slice(0, pending.indexOf('\n'))) as WorkerPayload;
    if (!s?.orgId || !s.projectId || !s.leaseId || !s.challengeId) throw new Error('missing native test scope');
    const status = await native.consumePrivateV3Nonce(privateInvocation);
    process.stdout.write('RESULT:' + JSON.stringify({ status }) + '\n');
    await storage.close();
  } catch (error) {
    process.stderr.write('WORKER_FAILURE:' + String(error) + '\n');
    await storage.close();
    process.exitCode = 2;
  }
});
