import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '../../test-utils.js';
import { FACTORY_PROJECTS_SCHEMA } from './base.js';

describe('FactoryProjectsStorage', () => {
  it('creates an org-owned project without any integration or repository', async () => {
    const seed = await createFactoryStorageForTests();

    const project = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Platform', description: 'Internal platform work' },
    });

    expect(project).toMatchObject({
      orgId: 'org-1',
      createdBy: 'user-1',
      name: 'Platform',
      description: 'Internal platform work',
      modelScope: 'hybrid',
    });
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).toEqual(project);
    expect(await seed.projects.get({ orgId: 'other-org', id: project.id })).toBeNull();
  });

  it('stores an explicit model scope at creation', async () => {
    const seed = await createFactoryStorageForTests();
    const factory = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Org', modelScope: 'factory' },
    });
    const user = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Mine', modelScope: 'user' },
    });

    expect((await seed.projects.get({ orgId: 'org-1', id: factory.id }))?.modelScope).toBe('factory');
    expect((await seed.projects.get({ orgId: 'org-1', id: user.id }))?.modelScope).toBe('user');
  });

  it('round-trips the hybrid scope and reads unknown stored scopes as hybrid', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Split', modelScope: 'user' },
    });

    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { modelScope: 'hybrid' } });
    expect((await seed.projects.get({ orgId: 'org-1', id: project.id }))?.modelScope).toBe('hybrid');
    expect((await seed.projects.getById({ id: project.id }))?.modelScope).toBe('hybrid');

    // A value written by an older or newer build must not leak through as an unknown scope.
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { modelScope: 'factory' } });
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { modelScope: 'org' as never } });
    expect((await seed.projects.get({ orgId: 'org-1', id: project.id }))?.modelScope).toBe('hybrid');
  });

  it('lists, updates, and deletes projects within their organization', async () => {
    const seed = await createFactoryStorageForTests();
    const first = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'First' } });
    const other = await seed.projects.create({ orgId: 'org-2', userId: 'user-2', input: { name: 'Other org' } });

    expect((await seed.projects.list({ orgId: 'org-1' })).map(project => project.id)).toEqual([first.id]);
    expect((await seed.projects.listAll()).map(project => project.id).sort()).toEqual([first.id, other.id].sort());

    const updated = await seed.projects.update({
      orgId: 'org-1',
      id: first.id,
      input: { name: 'Renamed', description: 'Now documented' },
    });
    expect(updated).toMatchObject({ name: 'Renamed', description: 'Now documented' });
    expect(await seed.projects.update({ orgId: 'org-2', id: first.id, input: { name: 'Nope' } })).toBeNull();

    const scoped = await seed.projects.update({
      orgId: 'org-1',
      id: first.id,
      input: { modelScope: 'user' },
    });
    expect(scoped?.modelScope).toBe('user');

    const renamedAgain = await seed.projects.update({ orgId: 'org-1', id: first.id, input: { name: 'Final name' } });
    expect(renamedAgain?.modelScope).toBe('user');
    expect((await seed.projects.get({ orgId: 'org-1', id: first.id }))?.modelScope).toBe('user');

    expect(await seed.projects.delete({ orgId: 'org-2', id: first.id })).toBeNull();
    expect(await seed.projects.delete({ orgId: 'org-1', id: first.id })).toMatchObject({ id: first.id });
    expect(await seed.projects.get({ orgId: 'org-1', id: first.id })).toBeNull();
  });

  it('round-trips every environment field and clears them with null', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Env' } });
    expect(project).toMatchObject({
      sandboxWorkingDirectory: null,
      sandboxSettings: null,
      workspaceSetupCommand: null,
      activeTemplateId: null,
      activeTemplateHeads: null,
    });

    const environment = {
      sandboxWorkingDirectory: '/home/user/workspace',
      sandboxSettings: { cpuCount: 8, memoryMb: 16384 },
      workspaceSetupCommand: 'touch .ready',
      activeTemplateId: 'tpl-1',
      activeTemplateHeads: { 'mastra-ai/mastra': 'abc123' },
    };
    expect(await seed.projects.update({ orgId: 'org-1', id: project.id, input: environment })).toMatchObject(
      environment,
    );
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).toMatchObject(environment);

    const cleared = {
      sandboxWorkingDirectory: null,
      sandboxSettings: null,
      workspaceSetupCommand: null,
      activeTemplateId: null,
      activeTemplateHeads: null,
    };
    expect(await seed.projects.update({ orgId: 'org-1', id: project.id, input: cleared })).toMatchObject(cleared);
  });

  it('keeps review test checks off by default and lets a project toggle them', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    expect(project.reviewTestChecksEnabled).toBe(false);
    const enabled = await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { reviewTestChecksEnabled: true },
    });
    expect(enabled?.reviewTestChecksEnabled).toBe(true);
    const disabled = await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { reviewTestChecksEnabled: false },
    });
    expect(disabled?.reviewTestChecksEnabled).toBe(false);
    expect((await seed.projects.get({ orgId: 'org-1', id: project.id }))?.reviewTestChecksEnabled).toBe(false);
  });
});

describe('FactoryProjectsStorage automation handover fencing', () => {
  const request = (project: { id: string; automationRevision: number }, changes: { autoRunEnabled: boolean; autoApprovePlans: boolean }) => ({
    orgId: 'org-1',
    id: project.id,
    expectedAutomationRevision: project.automationRevision,
    expectedAutoRunEnabled: false,
    expectedAutoApprovePlans: false,
    ...changes,
  });

  it('atomically updates both switches, rejects stale and cross-org attempts, and leaves conflict state unchanged', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Handover' } });
    expect(project).toMatchObject({ autoRunEnabled: false, autoApprovePlans: false, automationRevision: 0 });
    const original = request(project, { autoRunEnabled: true, autoApprovePlans: true });
    expect(await seed.projects.compareAndSetAutomation({ ...original, orgId: 'other-org' })).toEqual({
      status: 'not_found',
    });

    const success = await seed.projects.compareAndSetAutomation(original);
    expect(success.status).toBe('updated');
    if (success.status !== 'updated') throw new Error('expected successful CAS');
    expect(success.project).toMatchObject({
      autoRunEnabled: true,
      autoApprovePlans: true,
      automationRevision: 1,
    });

    const snapshot = await seed.projects.get({ orgId: 'org-1', id: project.id });
    const stale = await seed.projects.compareAndSetAutomation(original);
    expect(stale).toMatchObject({ status: 'conflict', project: { automationRevision: 1 } });
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).toEqual(snapshot);

    const noop = await seed.projects.compareAndSetAutomation({
      ...original,
      expectedAutomationRevision: 1,
      expectedAutoRunEnabled: true,
      expectedAutoApprovePlans: true,
    });
    expect(noop).toMatchObject({ status: 'updated', project: { automationRevision: 1 } });
  });

  it('fences an ABA transition and increases the revision for legacy effective switch writes only', async () => {
    const seed = await createFactoryStorageForTests();
    const initial = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'ABA' } });
    const first = await seed.projects.update({
      orgId: 'org-1',
      id: initial.id,
      input: { autoRunEnabled: true },
    });
    expect(first?.automationRevision).toBe(1);
    const second = await seed.projects.update({
      orgId: 'org-1',
      id: initial.id,
      input: { autoRunEnabled: false, autoApprovePlans: false },
    });
    expect(second?.automationRevision).toBe(2);
    const metadataOnly = await seed.projects.update({
      orgId: 'org-1',
      id: initial.id,
      input: { name: 'ABA restored', autoRunEnabled: false },
    });
    expect(metadataOnly?.automationRevision).toBe(2);
    expect(
      await seed.projects.compareAndSetAutomation(
        request(initial, { autoRunEnabled: true, autoApprovePlans: true }),
      ),
    ).toMatchObject({ status: 'conflict', project: { automationRevision: 2 } });
  });

  it('adds the revision with a default to a legacy file database and retains it across reopening', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'factory-automation-migration-'));
    const url = `file:${join(folder, 'factory.db')}`;
    const oldColumns = Object.fromEntries(
      Object.entries(FACTORY_PROJECTS_SCHEMA.columns).filter(([name]) => name !== 'automation_revision'),
    );
    let original: LibSQLFactoryStorage | undefined;
    let migrated: LibSQLFactoryStorage | undefined;
    let restored: LibSQLFactoryStorage | undefined;
    try {
      original = new LibSQLFactoryStorage({ id: 'old-projects', url });
      await original.init();
      await original.ensureCollections([{ ...FACTORY_PROJECTS_SCHEMA, columns: oldColumns }]);
      const oldRow = await original.ops.insertOne<{ id: string; org_id: string; name: string }>('factory_projects', {
        org_id: 'org-1',
        created_by: 'user-1',
        name: 'Legacy',
        created_at: new Date(),
        updated_at: new Date(),
      });
      await original.close();
      original = undefined;

      migrated = new LibSQLFactoryStorage({ id: 'upgraded-projects', url });
      await migrated.init();
      await migrated.ensureCollections([FACTORY_PROJECTS_SCHEMA]);
      expect(
        (await migrated.ops.findOne<Record<string, unknown>>('factory_projects', { id: oldRow.id }))
          ?.automation_revision,
      ).toBe(0);
      await migrated.close();
      migrated = undefined;

      restored = new LibSQLFactoryStorage({ id: 'reopened-projects', url });
      await restored.init();
      await restored.ensureCollections([FACTORY_PROJECTS_SCHEMA]);
      const row = await restored.ops.findOne<Record<string, unknown>>('factory_projects', { id: oldRow.id });
      expect(row).toMatchObject({ org_id: 'org-1', name: 'Legacy', automation_revision: 0 });
    } finally {
      await original?.close();
      await migrated?.close();
      await restored?.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('accepts exactly one concurrent same-revision transition', async () => {
    const seed = await createFactoryStorageForTests();
    const initial = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Raced' } });
    const common = request(initial, { autoRunEnabled: true, autoApprovePlans: false });
    const outcomes = await Promise.all([
      seed.projects.compareAndSetAutomation(common),
      seed.projects.compareAndSetAutomation({ ...common, autoRunEnabled: false, autoApprovePlans: true }),
    ]);
    expect(outcomes.map(value => value.status).sort()).toEqual(['conflict', 'updated']);
    const latest = await seed.projects.get({ orgId: 'org-1', id: initial.id });
    expect(latest?.automationRevision).toBe(1);
    expect(latest?.autoRunEnabled !== latest?.autoApprovePlans).toBe(true);
  });
});

describe('FactoryProjectsStorage builds', () => {
  it('defaults the build columns and round-trips them', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    expect(project).toMatchObject({
      lastBuildId: null,
      lastBuildAttemptedAt: null,
      buildOnPushEnabled: false,
      buildPushDebounceMinutes: 10,
    });

    const at = new Date('2026-10-08T10:00:00.000Z');
    const updated = await seed.projects.update({
      orgId: 'org-1',
      id: project.id,
      input: { lastBuildId: 'tpl_1', lastBuildAttemptedAt: at, buildOnPushEnabled: true, buildPushDebounceMinutes: 3 },
    });
    expect(updated).toMatchObject({
      lastBuildId: 'tpl_1',
      lastBuildAttemptedAt: at,
      buildOnPushEnabled: true,
      buildPushDebounceMinutes: 3,
    });
  });

  it('claimBuildAttempt wins once per debounce window', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    const t0 = new Date('2026-10-08T10:00:00.000Z');

    expect(await seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t0 })).toBe(true);
    const afterFirst = await seed.projects.getById({ id: project.id });
    expect(afterFirst?.lastPushBuildAt).toEqual(t0);

    const t1 = new Date(t0.getTime() + 9 * 60_000);
    expect(await seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t1 })).toBe(false);
    expect((await seed.projects.getById({ id: project.id }))?.lastPushBuildAt).toEqual(t0);

    const t2 = new Date(t0.getTime() + 10 * 60_000);
    expect(await seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t2 })).toBe(true);
    expect((await seed.projects.getById({ id: project.id }))?.lastPushBuildAt).toEqual(t2);

    // Two concurrent claims on a fresh window: exactly one wins.
    const t3 = new Date(t2.getTime() + 60 * 60_000);
    const results = await Promise.all([
      seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t3 }),
      seed.projects.claimBuildAttempt({ id: project.id, debounceMinutes: 10, now: t3 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('pinActiveTemplate writes only while the build is still the last one', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'P' } });
    await seed.projects.update({ orgId: 'org-1', id: project.id, input: { lastBuildId: 'build-2' } });

    expect(
      await seed.projects.pinActiveTemplate({ id: project.id, buildId: 'build-1', templateId: 'tpl-1', heads: {} }),
    ).toBe(false);
    expect((await seed.projects.getById({ id: project.id }))?.activeTemplateId).toBeNull();

    expect(
      await seed.projects.pinActiveTemplate({
        id: project.id,
        buildId: 'build-2',
        templateId: 'tpl-2',
        heads: { 'acme/api': 'abc' },
      }),
    ).toBe(true);
    const stored = await seed.projects.getById({ id: project.id });
    expect(stored?.activeTemplateId).toBe('tpl-2');
    expect(stored?.activeTemplateHeads).toEqual({ 'acme/api': 'abc' });
  });
});
