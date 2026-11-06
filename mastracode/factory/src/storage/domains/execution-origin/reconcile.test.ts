import { randomUUID } from 'node:crypto';

import { PgFactoryStorage, PostgresStore } from '@mastra/pg';
import { describe, expect, it } from 'vitest';

import { FactoryExecutionEpochStorage } from '../execution-epochs/base.js';
import { FactoryProjectsStorage } from '../projects/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import { FACTORY_EXECUTION_ORIGINS_SCHEMA, FactoryExecutionOriginStorage } from './base.js';
import { FactoryOriginMemoryReconciler } from './reconcile.js';

const qaUrl = process.env.B2B_PG_URL;
const pgDescribe = qaUrl ? describe : describe.skip;
const verified = new WeakMap<object, { orgId: string; userId: string }>();

async function open(denyAfterBridge = false) {
  const origins = new FactoryExecutionOriginStorage(async context =>
    context && typeof context === 'object' ? verified.get(context) ?? null : null);
  const bridge = new FactoryOriginMemoryReconciler(origins);
  const store = new PostgresStore({
    id: 'b2b-pg-' + randomUUID(), connectionString: qaUrl!,
    threadPersistenceGuard: denyAfterBridge
      ? { version: 1, async beforeMutation(input) {
          await bridge.guard.beforeMutation(input);
          throw new Error('forced PG transaction rollback');
        } }
      : bridge.guard,
  });
  const factory = new PgFactoryStorage({ store });
  const projects = factory.registerDomain(new FactoryProjectsStorage());
  factory.registerDomain(new FactoryExecutionEpochStorage());
  factory.registerDomain(new SourceControlStorage());
  factory.registerDomain(origins);
  await factory.init();
  await store.init();
  const memory = (await store.getStore('memory'))!;
  return { factory, store, origins, bridge, projects, memory,
    async close() { await factory.close(); } };
}

async function seed(f: Awaited<ReturnType<typeof open>>) {
  const orgId = 'org-' + randomUUID();
  const userId = 'owner-' + randomUUID();
  const sessionId = 'sess-' + randomUUID();
  const project = await f.projects.create({ orgId, userId, input: { name: sessionId } });
  await f.factory.ops.insertOne('source_control_sessions', {
    session_id: sessionId,
    project_repository_id: 'repo-' + sessionId,
    factory_project_id: project.id,
    org_id: orgId, user_id: userId,
    branch: 'branch-' + sessionId, base_branch: 'main',
    visibility: 'org', origin_session_id: null,
    created_at: new Date(), updated_at: new Date(),
  });
  const principal = {};
  verified.set(principal, { orgId, userId });
  return { orgId, userId, sessionId, projectId: project.id, principal };
}

function writeThread(id: string, resourceId: string) {
  const now = new Date();
  return { id, resourceId, title: 'Proven', createdAt: now, updatedAt: now };
}

pgDescribe('B2b default-inert PG memory origin reconciliation', () => {
  it('refuses direct client thread stamp and requires a private issuer context', async () => {
    const f = await open();
    try {
      const s = await seed(f);
      await expect(f.memory.saveThread({ thread: writeThread('client-forged', s.projectId) }))
        .rejects.toThrow(/private pending issue/);
      expect(await f.memory.getThreadById({ threadId: 'client-forged' })).toBeNull();
      expect(await f.origins.issueNewSourceThread({
        privateServerContext: { orgId: s.orgId, userId: s.userId },
        sessionId: s.sessionId, requestId: 'spoofed',
      })).toEqual({ status: 'denied' });
    } finally { await f.close(); }
  });

  it('atomically records one memory-row origin receipt without authorizing a run or replay', async () => {
    const f = await open();
    try {
      const s = await seed(f);
      let inserted = '';
      const outcome = await f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'first',
      }, async ({ id, resourceId }) => {
        inserted = id;
        await f.memory.saveThread({ thread: writeThread(id, resourceId) });
      });
      expect(outcome).toEqual({ status: 'effect_unverified' });
      expect(await f.memory.getThreadById({ threadId: inserted }))
        .toMatchObject({ id: inserted, resourceId: s.projectId });
      const rows = await f.factory.ops.findMany<{ state: string; thread_id: string }>(
        FACTORY_EXECUTION_ORIGINS_SCHEMA.name, { session_id: s.sessionId });
      expect(rows).toMatchObject([{ thread_id: inserted, state: 'verified' }]);
      expect(await f.factory.ops.findMany('factory_execution_scopes', { org_id: s.orgId })).toEqual([]);
      let replay = false;
      expect(await f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'first',
      }, async () => { replay = true; })).toEqual({ status: 'effect_unverified' });
      expect(replay).toBe(false);
    } finally { await f.close(); }
  });

  it('rejects owner/project drift between issue and native effect; evidence stays pending', async () => {
    const f = await open();
    try {
      const s = await seed(f);
      const other = await f.projects.create({ orgId: s.orgId, userId: s.userId,
        input: { name: 'Other project' } });
      let threadId = '';
      await expect(f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'drift',
      }, async ({ id, resourceId }) => {
        threadId = id;
        await f.factory.ops.updateMany('source_control_sessions',
          { session_id: s.sessionId }, { factory_project_id: other.id });
        await f.memory.saveThread({ thread: writeThread(id, resourceId) });
      })).rejects.toThrow(/source scope changed/);
      expect(await f.memory.getThreadById({ threadId })).toBeNull();
      const rows = await f.factory.ops.findMany<{ state: string }>(
        FACTORY_EXECUTION_ORIGINS_SCHEMA.name, { session_id: s.sessionId });
      expect(rows[0]?.state).toBe('pending_memory_effect');
      // A new request ID MUST NOT reinterpret the old candidate or old session
      // as an already verified owner-bound thread.
      expect(await f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'drift',
      }, async () => { throw new Error('replayed'); })).toEqual({ status: 'effect_unverified' });
    } finally { await f.close(); }
  });

  it('rolls back origin verification and native thread INSERT together on PG failure', async () => {
    const f = await open(true);
    try {
      const s = await seed(f);
      let threadId = '';
      await expect(f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'rollback',
      }, async ({ id, resourceId }) => {
        threadId = id;
        await f.memory.saveThread({ thread: writeThread(id, resourceId) });
      })).rejects.toThrow(/forced PG transaction rollback/);
      expect(await f.memory.getThreadById({ threadId })).toBeNull();
      const evidence = await f.factory.ops.findMany<{ state: string }>(
        FACTORY_EXECUTION_ORIGINS_SCHEMA.name, { session_id: s.sessionId });
      expect(evidence[0]?.state).toBe('pending_memory_effect');
      expect(await f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'rollback',
      }, async () => { throw new Error('unsafe retry'); })).toEqual({ status: 'effect_unverified' });
    } finally { await f.close(); }
  });

  it('blocks newly quarantined historical origin between issuer and PG write', async () => {
    const f = await open();
    try {
      const s = await seed(f);
      let threadId = '';
      await expect(f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'quarantine',
      }, async ({ id, resourceId }) => {
        threadId = id;
        expect(await f.origins.quarantineHistoricalSourceSessions({ orgId: s.orgId })).toBe(1);
        await f.memory.saveThread({ thread: writeThread(id, resourceId) });
      })).rejects.toThrow(/origin quarantined/);
      expect(await f.memory.getThreadById({ threadId })).toBeNull();
      expect(await f.factory.ops.findMany('factory_execution_scopes', { org_id: s.orgId })).toEqual([]);
    } finally { await f.close(); }
  });

  it('persists ambiguous pending issuance and verified receipts across process restart', async () => {
    const f = await open();
    const s = await seed(f);
    let committed = '';
    let pending = '';
    try {
      await f.bridge.issueAndWrite({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'committed',
      }, async ({ id, resourceId }) => {
        committed = id;
        await f.memory.saveThread({ thread: writeThread(id, resourceId) });
      });
      const unresolved = await f.origins.issueNewSourceThread({
        privateServerContext: s.principal, sessionId: s.sessionId, requestId: 'lost-response',
      });
      expect(unresolved.status).toBe('pending_memory_effect');
      if (unresolved.status === 'pending_memory_effect') pending = unresolved.threadId;
    } finally { await f.close(); }
    const reopened = await open();
    try {
      const receipts = await reopened.factory.ops.findMany<{ request_id: string; state: string }>(
        FACTORY_EXECUTION_ORIGINS_SCHEMA.name, { session_id: s.sessionId });
      expect(receipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ request_id: 'committed', state: 'verified' }),
        expect.objectContaining({ request_id: 'lost-response', state: 'pending_memory_effect' }),
      ]));
      expect(await reopened.memory.getThreadById({ threadId: committed })).toBeTruthy();
      expect(await reopened.memory.getThreadById({ threadId: pending })).toBeNull();
      // Neither a private-context echo nor a new process can replay issuance.
      const principal = {};
      verified.set(principal, { orgId: s.orgId, userId: s.userId });
      expect(await reopened.bridge.issueAndWrite({
        privateServerContext: principal, sessionId: s.sessionId, requestId: 'lost-response',
      }, async () => { throw new Error('replayed'); })).toEqual({ status: 'effect_unverified' });
    } finally { await reopened.close(); }
  });
});
