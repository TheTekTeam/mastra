import { randomUUID } from 'node:crypto';

import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.js';
import {
  FACTORY_EXECUTION_RESERVATIONS_SCHEMA,
  FACTORY_EXECUTION_EPOCHS_SCHEMA,
  FactoryExecutionEpochStorage,
} from './base.js';

// Only a disposable, explicitly isolated PostgreSQL QA database may be used.
// Never point this test at live Factory DATABASE_URL.
describe.skipIf(!process.env.FACTORY_B1_PG_TEST_URL)('Factory execution epochs: isolated PostgreSQL concurrency', () => {
  const url = process.env.FACTORY_B1_PG_TEST_URL!;

  async function open() {
    const storage = new PgFactoryStorage({ connectionString: url });
    const projects = storage.registerDomain(new FactoryProjectsStorage());
    const epochs = storage.registerDomain(new FactoryExecutionEpochStorage());
    await storage.init();
    return { storage, projects, epochs };
  }

  it('fences simultaneous native starts and handover epoch updates from two SQL connections', async () => {
    let a: Awaited<ReturnType<typeof open>> | undefined;
    let b: Awaited<ReturnType<typeof open>> | undefined;
    try {
      a = await open();
      b = await open();
      for (let i = 0; i < 20; i++) {
        const suffix = randomUUID();
        const project = await a.projects.create({
          orgId: 'b1-org-' + suffix, userId: 'test-owner', input: { name: 'PG18-' + i },
        });
        const scope = {
          orgId: project.orgId, projectId: project.id, sessionId: 'session-' + suffix,
          resourceId: 'resource-' + suffix, threadId: 'thread-' + suffix,
        };
        expect(await a.epochs.provisionUnarmed({ orgId: scope.orgId, projectId: project.id })).toBe('created');
        expect(await a.epochs.bindThread(scope)).toBe('bound');
        await a.storage.withTransaction(ops => ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, {
          org_id: scope.orgId, factory_project_id: scope.projectId,
        }, () => ({ fence_armed: true, coverage_version: 1, mapping_digest: 'verified-test-fixture' })));
        const outcomes = await Promise.all([
          a.epochs.reserveNative({ ...scope, runId: 'run-' + suffix, attemptId: 'attempt-' + suffix, phase: 'start' }),
          b.epochs.tryQuiesce({
            orgId: scope.orgId, projectId: scope.projectId, expectedRevision: 0, ownerEpoch: 'pm-' + suffix,
          }),
        ]);
        const [native, handover] = outcomes;
        expect(
          (native.status === 'reserved' && (handover === 'blocked' || handover === 'conflict')) ||
          (native.status === 'denied' && handover === 'quiescing'),
        ).toBe(true);
        const epoch = await a.epochs.getEpoch({ orgId: scope.orgId, projectId: scope.projectId });
        expect(epoch?.state).toBe(native.status === 'reserved' ? 'native' : 'quiescing');
        expect(epoch?.revision).toBe(1);
        if (native.status === 'reserved') {
          expect(await a.epochs.reserveNative({
            ...scope, runId: 'run-' + suffix, attemptId: 'attempt-' + suffix, phase: 'start',
          })).toEqual({ status: 'duplicate' });
        }
      }
    } finally {
      await b?.storage.close();
      await a?.storage.close();
    }
  });

  it('keeps unknown reservations blocking across a PostgreSQL client restart', async () => {
    let a: Awaited<ReturnType<typeof open>> | undefined;
    let reopened: Awaited<ReturnType<typeof open>> | undefined;
    const suffix = randomUUID();
    try {
      a = await open();
      const project = await a.projects.create({
        orgId: 'b1-org-' + suffix, userId: 'owner', input: { name: 'Crash persistence' },
      });
      const scope = {
        orgId: project.orgId, projectId: project.id, sessionId: 'session-' + suffix,
        resourceId: 'resource-' + suffix, threadId: 'thread-' + suffix,
      };
      await a.epochs.provisionUnarmed({ orgId: scope.orgId, projectId: scope.projectId });
      await a.epochs.bindThread(scope);
      await a.storage.withTransaction(ops => ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, {
        org_id: scope.orgId, factory_project_id: scope.projectId,
      }, () => ({ fence_armed: true, coverage_version: 1, mapping_digest: 'verified-test-fixture' })));
      const admitted = await a.epochs.reserveNative({
        ...scope, runId: 'run-' + suffix, attemptId: 'attempt-' + suffix, phase: 'resume',
      });
      expect(admitted.status).toBe('reserved');
      if (admitted.status !== 'reserved') throw new Error('missing reservation');
      await a.epochs.markUncertain({ orgId: scope.orgId, projectId: scope.projectId,
        reservationId: admitted.reservationId });
      await a.storage.close();
      a = undefined;

      reopened = await open();
      expect(await reopened.epochs.tryQuiesce({
        orgId: scope.orgId, projectId: scope.projectId, expectedRevision: 1, ownerEpoch: 'pm-' + suffix,
      })).toBe('blocked');
      const rows = await reopened.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name, {
        org_id: scope.orgId, factory_project_id: scope.projectId,
      });
      expect(rows).toMatchObject([{ state: 'unknown', epoch_revision: 1 }]);
    } finally {
      await a?.storage.close();
      await reopened?.storage.close();
    }
  });
});
