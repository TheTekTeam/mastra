import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';

import { FactoryExecutionEpochStorage } from '../execution-epochs/base.js';
import { FactoryProjectsStorage } from '../projects/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import { FACTORY_EXECUTION_ORIGINS_SCHEMA, FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA,
  FactoryExecutionOriginStorage } from './base.js';

type SourceSeed = {
  sessionId?: string;
  orgId?: string;
  userId?: string;
  projectId?: string | null;
  branch?: string;
  visibility?: string | null;
  originSessionId?: string | null;
};

// Simulate BetterAuth's private, server-owned principal resolver. A caller
// reproducing the object's public shape is NOT authenticated.
const verifiedContexts = new WeakMap<object, { orgId: string; userId: string }>();
function verifiedResolver(privateContext: unknown) {
  return Promise.resolve(privateContext !== null && typeof privateContext === 'object'
    ? verifiedContexts.get(privateContext) ?? null : null);
}

async function open(url = ':memory:') {
  const storage = new LibSQLFactoryStorage({ id: 'execution-origin-test', url });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  storage.registerDomain(new FactoryExecutionEpochStorage());
  storage.registerDomain(new SourceControlStorage());
  const origin = storage.registerDomain(new FactoryExecutionOriginStorage(verifiedResolver));
  await storage.init();
  return { storage, projects, origin };
}

async function seedSource(
  fixture: Awaited<ReturnType<typeof open>>,
  args: SourceSeed = {},
) {
  const orgId = args.orgId ?? 'org-a';
  const userId = args.userId ?? 'owner-a';
  const sessionId = args.sessionId ?? 'session-a';
  const project = args.projectId === undefined
    ? await fixture.projects.create({ orgId, userId, input: { name: sessionId } })
    : null;
  const projectId = args.projectId === undefined ? project!.id : args.projectId;
  await fixture.storage.ops.insertOne('source_control_sessions', {
    session_id: sessionId,
    project_repository_id: 'repo-' + sessionId,
    factory_project_id: projectId,
    org_id: orgId,
    user_id: userId,
    branch: args.branch ?? 'branch-' + sessionId,
    base_branch: 'main',
    visibility: args.visibility === undefined ? 'org' : args.visibility,
    origin_session_id: args.originSessionId ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return { orgId, userId, sessionId, projectId };
}

function serverPrincipal(orgId = 'org-a', userId = 'owner-a') {
  const privateContext = { serverPrincipal: { orgId, userId } };
  verifiedContexts.set(privateContext, { orgId, userId });
  return privateContext;
}

describe('inert Factory origin issuer (PM #36 B2a)', () => {
  it('mints a server-owned opaque candidate only for verified principal and persisted source owner', async () => {
    const fixture = await open();
    try {
      const source = await seedSource(fixture);
      const result = await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'new-1',
      });
      expect(result.status).toBe('pending_memory_effect');
      if (result.status !== 'pending_memory_effect') throw new Error('missing candidate');
      expect(result.threadId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.anchor).toMatch(/^[a-f0-9]{64}$/);
      expect(result.threadId).not.toBe(result.anchor);
      expect(result.resourceId).toBe(source.projectId);
      const [row] = await fixture.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {});
      expect(row).toMatchObject({
        org_id: source.orgId, user_id: source.userId, session_id: source.sessionId,
        factory_project_id: source.projectId, thread_id: result.threadId,
        state: 'pending_memory_effect', kind_at_issue: 'unverified',
      });
      // B2a cannot authorize execution, bind B1, or attest that a Core thread exists.
      expect(await fixture.storage.ops.findMany('factory_execution_scopes', {})).toEqual([]);
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'new-1',
      })).toEqual({ status: 'effect_unverified' });
    } finally {
      await fixture.storage.close();
    }
  });

  it('fails closed on forged auth or client-writable thread/Factory stamps', async () => {
    const fixture = await open();
    try {
      const source = await seedSource(fixture);
      for (const privateServerContext of [null, {}, { orgId: 'org-a', userId: 'owner-a' },
        { serverPrincipal: { orgId: 'org-a', userId: 'owner-a' } }]) {
        expect(await fixture.origin.issueNewSourceThread({
          privateServerContext, sessionId: source.sessionId, requestId: 'forgery',
        })).toEqual({ status: 'denied' });
      }
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: 123 as unknown as string, requestId: 'bad-id',
      })).toEqual({ status: 'denied' });
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: {} as string,
      })).toEqual({ status: 'denied' });
      for (const extra of [
        { threadId: 'client-chosen' }, { factorySessionId: source.sessionId },
        { resourceId: source.projectId }, { metadata: { factorySessionId: source.sessionId } },
        { projectId: source.projectId }, { classification: 'personal' },
      ]) {
        expect(await fixture.origin.issueNewSourceThread({
          privateServerContext: serverPrincipal(), sessionId: source.sessionId,
          requestId: 'forgery', ...extra,
        })).toEqual({ status: 'denied' });
      }
      expect(await fixture.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {})).toHaveLength(0);
    } finally {
      await fixture.storage.close();
    }
  });

  it('does not cross a verified source owner/org boundary or accept a mismatched project', async () => {
    const fixture = await open();
    try {
      const source = await seedSource(fixture);
      for (const principal of [serverPrincipal('org-b'), serverPrincipal('org-a', 'other-user')]) {
        expect(await fixture.origin.issueNewSourceThread({
          privateServerContext: principal, sessionId: source.sessionId, requestId: 'cross',
        })).toEqual({ status: 'denied' });
      }
      const other = await fixture.projects.create({ orgId: 'org-b', userId: 'owner-b', input: { name: 'Other' } });
      await seedSource(fixture, { sessionId: 'cross-project', projectId: other.id });
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: 'cross-project', requestId: 'cross',
      })).toEqual({ status: 'unknown_source' });
      expect(await fixture.origin.countUnknown({ orgId: 'org-a' })).toBe(1);
      expect(await fixture.origin.countUnknown({ orgId: 'org-b' })).toBe(0);
    } finally {
      await fixture.storage.close();
    }
  });

  it('records nullable project and side/Slack/legacy scope as unknown, never personal by absence', async () => {
    const fixture = await open();
    try {
      await seedSource(fixture, { sessionId: 'null-project', projectId: null });
      await seedSource(fixture, { sessionId: 'side', originSessionId: 'another-session' });
      await seedSource(fixture, { sessionId: 'slack', branch: 'slack/team-a' });
      await seedSource(fixture, { sessionId: 'legacy', visibility: null });
      for (const sessionId of ['null-project', 'side', 'slack', 'legacy']) {
        expect(await fixture.origin.issueNewSourceThread({
          privateServerContext: serverPrincipal(), sessionId, requestId: 'request',
        })).toEqual({ status: 'unknown_source' });
      }
      expect(await fixture.origin.countUnknown({ orgId: 'org-a' })).toBe(4);
      expect(await fixture.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {})).toHaveLength(0);
    } finally {
      await fixture.storage.close();
    }
  });

  it('rejects clones from unverified parents and never issues two memory effects for the same request', async () => {
    const fixture = await open();
    try {
      const source = await seedSource(fixture);
      const first = await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'one',
      });
      expect(first.status).toBe('pending_memory_effect');
      if (first.status !== 'pending_memory_effect') throw new Error('missing candidate');
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId,
        requestId: 'clone', parentThreadId: first.threadId,
      })).toEqual({ status: 'parent_unverified' });
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId,
        requestId: 'one', parentThreadId: first.threadId,
      })).toEqual({ status: 'effect_unverified' });
      expect(await fixture.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {})).toHaveLength(1);
    } finally {
      await fixture.storage.close();
    }
  });

  it('cannot mint duplicate candidates for one request across two storage connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-origin-race-'));
    const url = 'file:' + join(directory, 'race.db');
    let first: Awaited<ReturnType<typeof open>> | undefined;
    let second: Awaited<ReturnType<typeof open>> | undefined;
    try {
      first = await open(url);
      const source = await seedSource(first);
      second = await open(url);
      const attempts = await Promise.allSettled([first.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'same',
      }), second.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'same',
      })]);
      const minted = attempts.filter(result =>
        result.status === 'fulfilled' && result.value.status === 'pending_memory_effect');
      expect(minted).toHaveLength(1);
      expect(await first.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {})).toHaveLength(1);
      expect(await second.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'same',
      })).toEqual({ status: 'effect_unverified' });
    } finally {
      await second?.storage.close();
      await first?.storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('quarantines historical sessions without trusting IDs or stamped memory and refuses subsequent promotion', async () => {
    const fixture = await open();
    try {
      const source = await seedSource(fixture, { sessionId: 'historical-authenticated' });
      await seedSource(fixture, { sessionId: 'historical-null', projectId: null });
      await seedSource(fixture, { sessionId: 'other-org', orgId: 'org-b', userId: 'owner-b' });
      expect(await fixture.origin.quarantineHistoricalSourceSessions({ orgId: 'org-a' })).toBe(2);
      expect(await fixture.origin.quarantineHistoricalSourceSessions({ orgId: 'org-a' })).toBe(2);
      expect(await fixture.origin.countUnknown({ orgId: 'org-a' })).toBe(2);
      expect(await fixture.origin.countUnknown({ orgId: 'org-b' })).toBe(0);
      const records = await fixture.storage.ops.findMany(
        FACTORY_EXECUTION_UNKNOWN_ORIGINS_SCHEMA.name, { org_id: 'org-a' });
      expect(records.map(row => row.reason)).toEqual([
        'legacy_missing_server_anchor', 'legacy_missing_server_anchor',
      ]);
      expect(await fixture.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'fake-fresh',
      })).toEqual({ status: 'unknown_source' });
      expect(await fixture.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {})).toHaveLength(0);
    } finally {
      await fixture.storage.close();
    }
  });

  it('leaves uncertain effects and legacy UNKNOWN persisted after DB restart (no automatic recovery)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-origin-test-'));
    const url = 'file:' + join(directory, 'candidate.db');
    let first: Awaited<ReturnType<typeof open>> | undefined;
    let second: Awaited<ReturnType<typeof open>> | undefined;
    try {
      first = await open(url);
      const source = await seedSource(first);
      await seedSource(first, { sessionId: 'historical', projectId: null });
      const candidate = await first.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'replay',
      });
      expect(candidate.status).toBe('pending_memory_effect');
      expect(await first.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: 'historical', requestId: 'old',
      })).toEqual({ status: 'unknown_source' });
      await first.storage.close();
      first = undefined;
      second = await open(url);
      expect(await second.origin.issueNewSourceThread({
        privateServerContext: serverPrincipal(), sessionId: source.sessionId, requestId: 'replay',
      })).toEqual({ status: 'effect_unverified' });
      const [row] = await second.storage.ops.findMany(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {});
      expect(row?.state).toBe('pending_memory_effect');
      expect(await second.origin.countUnknown({ orgId: 'org-a' })).toBe(1);
      expect(await second.storage.ops.findMany('factory_execution_scopes', {})).toHaveLength(0);
    } finally {
      await second?.storage.close();
      await first?.storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
