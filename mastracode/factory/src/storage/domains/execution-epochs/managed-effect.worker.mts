/**
 * Dedicated disposable-PG18 TWO-OS-PROCESS test worker for A2d.
 * No production invocation or credentials are embedded in source.
 */
import { PgFactoryStorage } from '@mastra/pg';

import { FactoryExecutionOriginStorage } from '../execution-origin/base.js';
import { FactoryProjectsStorage } from '../projects/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import { FACTORY_EXECUTION_EPOCHS_SCHEMA, FactoryExecutionEpochStorage } from './base.js';
import { FACTORY_CORE_MANAGER_LEASES_SCHEMA, FactoryManagedCoreEffectStorage } from './managed-effect.js';
import type { TrustedManagedCoreRun } from './managed-effect.js';

const connectionString = process.env.FACTORY_A2D_PG_TEST_URL;
const mode = process.env.FACTORY_A2D_WORKER_MODE;
const input = process.env.FACTORY_A2D_WORKER_RUN;
if (!connectionString || !input || (mode !== 'begin' && mode !== 'revoke')) {
  process.stderr.write('A2d worker requires test-only PG URL, mode and trusted test fixture\n');
  process.exit(2);
}

const run = JSON.parse(input) as TrustedManagedCoreRun;
const storage = new PgFactoryStorage({ connectionString });
storage.registerDomain(new FactoryProjectsStorage());
storage.registerDomain(new FactoryExecutionEpochStorage());
storage.registerDomain(new SourceControlStorage());
storage.registerDomain(new FactoryExecutionOriginStorage(async () => null));
const effects = storage.registerDomain(new FactoryManagedCoreEffectStorage(async () => run));
await storage.init();

// The parent starts two independent OS processes first, then releases both.
// This is a PG database contention proof, not simulated Promise interleaving.
process.stdout.write('READY\n');
await new Promise<void>(resolve =>
  process.stdin.once('data', () => {
    process.stdin.pause();
    resolve();
  }),
);
try {
  if (mode === 'begin') {
    const result = await effects.beginEffect({
      boundary: 'model-provider-request',
      privateCoreInvocation: Object.freeze({ test: true }),
    });
    process.stdout.write('RESULT:' + JSON.stringify(result) + '\n');
  } else {
    await storage.withTransaction(async ops => {
      const where = { org_id: run.orgId, factory_project_id: run.projectId };
      await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, where, row => ({
        revision: (row.revision as number) + 1,
      }));
      await ops.updateMany(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where, { state: 'revoked' });
    });
    process.stdout.write('RESULT:' + JSON.stringify({ status: 'revoked' }) + '\n');
  }
} finally {
  await storage.close();
}
// This single-use test subprocess has no background responsibilities.
process.exit(0);
