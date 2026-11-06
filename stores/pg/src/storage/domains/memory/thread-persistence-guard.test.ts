import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresStore } from '../../index';
import { PG_THREAD_PERSISTENCE_GUARD_VERSION } from './thread-persistence-guard';
import type { PgThreadPersistenceGuardV1, PgThreadPersistenceMutation } from './thread-persistence-guard';

const qaUrl = process.env.A0_PG_URL;
const pgDescribe = qaUrl ? describe : describe.skip;

function thread(id: string, resourceId: string, metadata?: Record<string, unknown>) {
  const now = new Date();
  return { id, resourceId, title: 'Unchanged', metadata, createdAt: now, updatedAt: now };
}

function schemaName() {
  return 'a0guard_' + randomUUID().replaceAll('-', '').slice(0, 16);
}

pgDescribe('PG-only opt-in thread persistence guard protocol', () => {
  it('rejects unsupported guard versions before allocating a protected PG writer', () => {
    expect(() => new PostgresStore({
      id: 'pg-a0-unsupported', connectionString: qaUrl!, schemaName: schemaName(),
      threadPersistenceGuard: { version: 2, beforeMutation: async () => {} } as never,
    })).toThrow();
  });

  it('defaults off, reports capability honestly, and keeps normal writes unchanged', async () => {
    const store = new PostgresStore({ id: 'pg-a0-default', connectionString: qaUrl!, schemaName: schemaName() });
    try {
      expect(store.getThreadPersistenceGuardCapability())
        .toEqual({ backend: 'postgres', version: 1, installed: false, adoptionReady: false, operations: [] });
      await store.init();
      const memory = (await store.getStore('memory'))!;
      await memory.saveThread({ thread: thread('without-guard', 'personal') });
      expect(await memory.getThreadById({ threadId: 'without-guard' }))
        .toMatchObject({ resourceId: 'personal' });
    } finally {
      await store.close();
    }
  });

  it('denies forged client stamps before a native save, but allows unselected traffic', async () => {
    let privateServerProof = false;
    const observed: PgThreadPersistenceMutation[] = [];
    const guard: PgThreadPersistenceGuardV1 = {
      version: PG_THREAD_PERSISTENCE_GUARD_VERSION,
      async beforeMutation({ transaction: _tx, ...mutation }) {
        observed.push(mutation);
        if (mutation.proposed?.resourceId === 'selected-project' && !privateServerProof) {
          throw new Error('no private server provenance');
        }
      },
    };
    const store = new PostgresStore({
      id: 'pg-a0-admission', connectionString: qaUrl!, schemaName: schemaName(),
      threadPersistenceGuard: guard,
    });
    try {
      expect(store.getThreadPersistenceGuardCapability()).toMatchObject({
        backend: 'postgres', version: 1, installed: true, adoptionReady: false,
        operations: ['save', 'update', 'copy', 'move', 'delete'],
      });
      await store.init();
      const memory = (await store.getStore('memory'))!;
      await expect(memory.saveThread({ thread: thread('forged', 'selected-project', {
        factorySessionId: 'selected-project', organizationId: 'org-a', ownerId: 'gp',
      }) })).rejects.toThrow();
      expect(await memory.getThreadById({ threadId: 'forged' })).toBeNull();
      await memory.saveThread({ thread: thread('personal', 'unselected-user') });
      privateServerProof = true;
      await memory.saveThread({ thread: thread('verified', 'selected-project') });
      expect(observed.filter(mutation => mutation.operation === 'save')).toHaveLength(3);
      expect(await memory.getThreadById({ threadId: 'verified' }))
        .toMatchObject({ resourceId: 'selected-project' });
    } finally {
      await store.close();
    }
  });

  it('fails closed on clone, metadata update, resource transfer and delete before effect', async () => {
    let privateServerProof = true;
    const guard: PgThreadPersistenceGuardV1 = {
      version: 1,
      async beforeMutation(mutation) {
        if (mutation.operation !== 'save' && !privateServerProof) throw new Error('revoked');
      },
    };
    const store = new PostgresStore({
      id: 'pg-a0-mutations', connectionString: qaUrl!, schemaName: schemaName(),
      threadPersistenceGuard: guard,
    });
    try {
      await store.init();
      const memory = (await store.getStore('memory'))!;
      await memory.saveThread({ thread: thread('origin', 'selected-project') });
      privateServerProof = false;
      await expect(memory.copyThread({
        sourceThreadId: 'origin', newThreadId: 'spoof-clone', resourceId: 'selected-project',
      })).rejects.toThrow();
      expect(await memory.getThreadById({ threadId: 'spoof-clone' })).toBeNull();
      await expect(memory.updateThread({ id: 'origin', title: 'Spoofed' })).rejects.toThrow();
      await expect(memory.updateThreadResourceId({ threadId: 'origin', resourceId: 'unselected-user' }))
        .rejects.toThrow();
      await expect(memory.deleteThread({ threadId: 'origin' })).rejects.toThrow();
      expect(await memory.getThreadById({ threadId: 'origin' }))
        .toMatchObject({ resourceId: 'selected-project', title: 'Unchanged' });
    } finally {
      await store.close();
    }
  });

  it('holds a guarded clone source lock across concurrent cross-process resource transfer', async () => {
    const schema = schemaName();
    let releaseCopy!: () => void;
    let signalCopy!: () => void;
    const entered = new Promise<void>(resolve => { signalCopy = resolve; });
    const barrier = new Promise<void>(resolve => { releaseCopy = resolve; });
    const guard: PgThreadPersistenceGuardV1 = {
      version: 1,
      async beforeMutation(input) {
        if (input.operation !== 'copy') return;
        expect(input.copySource).toMatchObject({ resourceId: 'selected-project' });
        signalCopy();
        await barrier;
      },
    };
    const a = new PostgresStore({ id: 'pg-a0-clone-a', connectionString: qaUrl!, schemaName: schema,
      threadPersistenceGuard: guard });
    const b = new PostgresStore({ id: 'pg-a0-clone-b', connectionString: qaUrl!, schemaName: schema });
    try {
      await a.init();
      await b.init();
      const first = (await a.getStore('memory'))!;
      const second = (await b.getStore('memory'))!;
      await first.saveThread({ thread: thread('clone-source', 'selected-project') });
      const copy = first.copyThread({
        sourceThreadId: 'clone-source', newThreadId: 'concurrent-copy', resourceId: 'selected-project',
      });
      await entered;
      let transferCommitted = false;
      const move = second.updateThreadResourceId({ threadId: 'clone-source', resourceId: 'other-project' })
        .then(() => { transferCommitted = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(transferCommitted).toBe(false);
      releaseCopy();
      await copy;
      await move;
      expect(await first.getThreadById({ threadId: 'concurrent-copy' }))
        .toMatchObject({ resourceId: 'selected-project' });
      expect(await first.getThreadById({ threadId: 'clone-source' }))
        .toMatchObject({ resourceId: 'other-project' });
    } finally {
      releaseCopy?.();
      await a.close();
      await b.close();
    }
  });

  it('rolls back guard-side evidence writes and native thread creation together on rejection', async () => {
    const schema = schemaName();
    const pool = new Pool({ connectionString: qaUrl });
    const guard: PgThreadPersistenceGuardV1 = {
      version: 1,
      async beforeMutation({ transaction }) {
        await transaction.none(`INSERT INTO "${schema}".guard_events (event) VALUES ($1)`, ['attempt']);
        throw new Error('rejected after durable guard evidence');
      },
    };
    const store = new PostgresStore({ id: 'pg-a0-rollback', pool, schemaName: schema, threadPersistenceGuard: guard });
    try {
      await store.init();
      await pool.query(`CREATE TABLE "${schema}".guard_events (event text NOT NULL)`);
      const memory = (await store.getStore('memory'))!;
      await expect(memory.saveThread({ thread: thread('rollback', 'selected-project') })).rejects.toThrow();
      expect(await memory.getThreadById({ threadId: 'rollback' })).toBeNull();
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}".guard_events`);
      expect(result.rows[0]?.count).toBe(0);
    } finally {
      await store.close();
      await pool.end();
    }
  });

  it('holds the same PG transaction epoch lock against a competing revocation', async () => {
    const schema = schemaName();
    const pool = new Pool({ connectionString: qaUrl, max: 4 });
    let releaseGuard!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const barrier = new Promise<void>(resolve => { releaseGuard = resolve; });
    const guard: PgThreadPersistenceGuardV1 = {
      version: 1,
      async beforeMutation({ transaction }) {
        const epoch = await transaction.one<{ revision: number }>(
          `SELECT revision FROM "${schema}".guard_epoch WHERE id = 1 FOR SHARE`);
        if (epoch.revision !== 0) throw new Error('stale owner epoch');
        signalEntered();
        await barrier;
      },
    };
    const store = new PostgresStore({ id: 'pg-a0-race', pool, schemaName: schema, threadPersistenceGuard: guard });
    try {
      await store.init();
      await pool.query(`CREATE TABLE "${schema}".guard_epoch (id integer PRIMARY KEY, revision integer NOT NULL)`);
      await pool.query(`INSERT INTO "${schema}".guard_epoch VALUES (1, 0)`);
      const memory = (await store.getStore('memory'))!;
      const write = memory.saveThread({ thread: thread('race', 'selected-project') });
      await entered;
      let revocationCommitted = false;
      const revoke = pool.query(`UPDATE "${schema}".guard_epoch SET revision = 1 WHERE id = 1`)
        .then(() => { revocationCommitted = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(revocationCommitted).toBe(false);
      releaseGuard();
      await write;
      await revoke;
      expect(revocationCommitted).toBe(true);
      await expect(memory.saveThread({ thread: thread('after-revoke', 'selected-project') }))
        .rejects.toThrow();
      expect(await memory.getThreadById({ threadId: 'after-revoke' })).toBeNull();
    } finally {
      releaseGuard?.();
      await store.close();
      await pool.end();
    }
  });
});
