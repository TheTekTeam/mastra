import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.js';
import {
  FACTORY_EXECUTION_EPOCHS_SCHEMA,
  FACTORY_EXECUTION_RESERVATIONS_SCHEMA,
  FACTORY_EXECUTION_SCOPES_SCHEMA,
  FactoryExecutionEpochStorage,
} from './base.js';

async function open(url = ':memory:') {
  const storage = new LibSQLFactoryStorage({ id: 'execution-epoch-test', url });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const epochs = storage.registerDomain(new FactoryExecutionEpochStorage());
  await storage.init();
  return { storage, projects, epochs };
}

async function setup(epochs: FactoryExecutionEpochStorage, projects: FactoryProjectsStorage) {
  const project = await projects.create({ orgId: 'org-a', userId: 'owner-a', input: { name: 'HTAI' } });
  expect(await epochs.provisionUnarmed({ orgId: 'org-a', projectId: project.id })).toBe('created');
  const scope = { orgId: 'org-a', projectId: project.id, sessionId: 'session-a', resourceId: 'resource-a', threadId: 'thread-a' };
  expect(await epochs.bindThread(scope)).toBe('bound');
  return scope;
}

async function fixtureArm(storage: LibSQLFactoryStorage, projectId: string) {
  // No production arming API is exported. Only a test transaction can exercise
  // the future concurrent admission path; B1 is not registered in the app.
  await storage.withTransaction(ops =>
    ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name,
      { org_id: 'org-a', factory_project_id: projectId },
      () => ({ fence_armed: true, coverage_version: 1, mapping_digest: 'verified-test-fixture' })),
  );
}

describe('Factory native epoch storage (inert PM #36 foundation)', () => {
  it('keeps unarmed projects incapable of native admission or handover', async () => {
    const { storage, projects, epochs } = await open();
    try {
      const scope = await setup(epochs, projects);
      expect(await epochs.getEpoch({ orgId: 'org-a', projectId: scope.projectId }))
        .toEqual({ revision: 0, state: 'native', armed: false, mappingRevision: 1,
          coverageVersion: 0, mappingDigest: null, ownerEpoch: null });
      expect(await epochs.reserveNative({ ...scope, runId: 'run-a', attemptId: 'attempt-a', phase: 'start' }))
        .toEqual({ status: 'not_ready' });
      expect(await epochs.tryQuiesce({ orgId: 'org-a', projectId: scope.projectId, expectedRevision: 0, ownerEpoch: 'owner-1' }))
        .toBe('not_ready');
    } finally {
      await storage.close();
    }
  });

  it('never reclassifies an existing source thread across sessions, projects or organizations', async () => {
    const { storage, projects, epochs } = await open();
    try {
      const scope = await setup(epochs, projects);
      const other = await projects.create({ orgId: 'org-b', userId: 'owner-b', input: { name: 'Other' } });
      expect(await epochs.provisionUnarmed({ orgId: 'org-b', projectId: scope.projectId })).toBe('not_found');
      expect(await epochs.provisionUnarmed({ orgId: 'org-b', projectId: other.id })).toBe('created');
      expect(await epochs.bindThread(scope)).toBe('existing');
      expect(await epochs.bindThread({ ...scope, sessionId: 'forged-session' })).toBe('conflict');
      expect(await epochs.bindThread({ ...scope, orgId: 'org-b', projectId: other.id })).toBe('conflict');
      expect(await epochs.bindThread({ ...scope, threadId: 'thread-b', orgId: 'org-b', projectId: scope.projectId }))
        .toBe('not_ready');
      expect(await storage.ops.findMany(FACTORY_EXECUTION_SCOPES_SCHEMA.name,
        { org_id: 'org-a', factory_project_id: scope.projectId })).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it('allows one immutable thread binding across two competing database connections', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'factory-epoch-binding-'));
    const url = 'file:' + join(folder, 'bindings.db');
    let a: Awaited<ReturnType<typeof open>> | undefined;
    let b: Awaited<ReturnType<typeof open>> | undefined;
    try {
      a = await open(url);
      const first = await a.projects.create({ orgId: 'org-a', userId: 'owner-a', input: { name: 'A' } });
      const second = await a.projects.create({ orgId: 'org-b', userId: 'owner-b', input: { name: 'B' } });
      await a.epochs.provisionUnarmed({ orgId: 'org-a', projectId: first.id });
      await a.epochs.provisionUnarmed({ orgId: 'org-b', projectId: second.id });
      b = await open(url);
      const scope = { sessionId: 'session', resourceId: 'resource', threadId: 'thread' };
      const results = await Promise.all([
        a.epochs.bindThread({ ...scope, orgId: 'org-a', projectId: first.id }),
        b.epochs.bindThread({ ...scope, orgId: 'org-b', projectId: second.id }),
      ]);
      expect(results.sort()).toEqual(['bound', 'conflict']);
      expect(await a.storage.ops.findMany(FACTORY_EXECUTION_SCOPES_SCHEMA.name, {})).toHaveLength(1);
    } finally {
      await b?.storage.close();
      await a?.storage.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('invalidates attested mapping on a newly bound thread and refuses binding during quiescence', async () => {
    const { storage, projects, epochs } = await open();
    try {
      const scope = await setup(epochs, projects);
      await fixtureArm(storage, scope.projectId);
      expect(await epochs.bindThread({ ...scope, sessionId: 'new-session', threadId: 'thread-new' })).toBe('bound');
      expect(await epochs.getEpoch({ orgId: 'org-a', projectId: scope.projectId }))
        .toMatchObject({ armed: false, mappingRevision: 2, mappingDigest: null, coverageVersion: 0 });
      expect(await epochs.reserveNative({ ...scope, runId: 'run-new', attemptId: 'attempt-new', phase: 'start' }))
        .toEqual({ status: 'not_ready' });
      await fixtureArm(storage, scope.projectId);
      expect(await epochs.tryQuiesce({ orgId: 'org-a', projectId: scope.projectId,
        expectedRevision: 0, ownerEpoch: 'owner-1' })).toBe('quiescing');
      expect(await epochs.bindThread({ ...scope, threadId: 'after-quiesce' })).toBe('not_ready');
    } finally {
      await storage.close();
    }
  });

  it('persists attempt replay denial and crash-unknown reservations without timeout clearance', async () => {
    const { storage, projects, epochs } = await open();
    try {
      const scope = await setup(epochs, projects);
      await fixtureArm(storage, scope.projectId);
      const input = { ...scope, runId: 'run-1', attemptId: 'attempt-1', phase: 'start' as const };
      const first = await epochs.reserveNative(input);
      expect(first.status).toBe('reserved');
      if (first.status !== 'reserved') throw new Error('reservation missing');
      expect(await epochs.reserveNative(input)).toEqual({ status: 'duplicate' });
      expect(await epochs.markUncertain({
        orgId: scope.orgId, projectId: scope.projectId, reservationId: first.reservationId,
      })).toBe(true);
      expect(await epochs.tryQuiesce({
        orgId: scope.orgId, projectId: scope.projectId, expectedRevision: 0, ownerEpoch: 'owner-1',
      })).toBe('blocked');
      const rows = await storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name,
        { org_id: scope.orgId, factory_project_id: scope.projectId });
      expect(rows).toMatchObject([{ state: 'unknown', epoch_revision: 1 }]);
    } finally {
      await storage.close();
    }
  });

  it('admits either native start or quiescence but never both across two SQLite connections', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'factory-epoch-race-'));
    const url = 'file:' + join(folder, 'raced.db');
    let a: Awaited<ReturnType<typeof open>> | undefined;
    let b: Awaited<ReturnType<typeof open>> | undefined;
    try {
      a = await open(url);
      const scope = await setup(a.epochs, a.projects);
      await fixtureArm(a.storage, scope.projectId);
      b = await open(url);
      const [start, stop] = await Promise.all([
        a.epochs.reserveNative({ ...scope, runId: 'run-race', attemptId: 'attempt-race', phase: 'start' }),
        b.epochs.tryQuiesce({ orgId: scope.orgId, projectId: scope.projectId, expectedRevision: 0, ownerEpoch: 'owner-1' }),
      ]);
      expect((start.status === 'reserved' && (stop === 'blocked' || stop === 'conflict')) ||
        (start.status === 'denied' && stop === 'quiescing')).toBe(true);
      expect((await b.epochs.getEpoch({ orgId: 'org-a', projectId: scope.projectId }))?.state)
        .toBe(start.status === 'reserved' ? 'native' : 'quiescing');
      expect((await b.epochs.reserveNative({
        ...scope, runId: 'run-race', attemptId: 'attempt-race', phase: 'start',
      })).status).not.toBe('reserved');
    } finally {
      await b?.storage.close();
      await a?.storage.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('adds tables to an existing DB, retains reservation on restart and restores the old backup', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'factory-epoch-migration-'));
    const url = 'file:' + join(folder, 'factory.db');
    const backup = join(folder, 'before-epoch.db');
    let original: LibSQLFactoryStorage | undefined;
    let migrated: Awaited<ReturnType<typeof open>> | undefined;
    let reopened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      original = new LibSQLFactoryStorage({ id: 'old-factory', url });
      const projectStore = original.registerDomain(new FactoryProjectsStorage());
      await original.init();
      const project = await projectStore.create({ orgId: 'org-a', userId: 'owner-a', input: { name: 'Existing' } });
      await original.close();
      original = undefined;
      await copyFile(join(folder, 'factory.db'), backup);

      migrated = await open(url);
      expect(await migrated.epochs.provisionUnarmed({ orgId: 'org-a', projectId: project.id })).toBe('created');
      const scope = { orgId: 'org-a', projectId: project.id, sessionId: 'session', resourceId: 'resource', threadId: 'thread' };
      expect(await migrated.epochs.bindThread(scope)).toBe('bound');
      await fixtureArm(migrated.storage, project.id);
      expect((await migrated.epochs.reserveNative({ ...scope, runId: 'run', attemptId: 'attempt', phase: 'resume' })).status)
        .toBe('reserved');
      await migrated.storage.close();
      migrated = undefined;

      reopened = await open(url);
      expect(await reopened.epochs.tryQuiesce({ orgId: 'org-a', projectId: project.id,
        expectedRevision: 0, ownerEpoch: 'owner-1' })).toBe('blocked');
      expect(await reopened.epochs.reserveNative({ ...scope, runId: 'run', attemptId: 'attempt', phase: 'resume' }))
        .toEqual({ status: 'duplicate' });
      await reopened.storage.close();
      reopened = undefined;

      const restored = new LibSQLFactoryStorage({ id: 'restored-backup', url: 'file:' + backup });
      try {
        const originalProjects = restored.registerDomain(new FactoryProjectsStorage());
        await restored.init();
        expect((await originalProjects.get({ orgId: 'org-a', id: project.id }))?.name).toBe('Existing');
      } finally {
        await restored.close();
      }
    } finally {
      await original?.close();
      await migrated?.storage.close();
      await reopened?.storage.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
