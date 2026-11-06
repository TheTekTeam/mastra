import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it } from 'vitest';

import { FactoryExecutionOriginStorage, FACTORY_EXECUTION_ORIGINS_SCHEMA } from '../execution-origin/base.js';
import { FactoryProjectsStorage } from '../projects/base.js';
import { SourceControlStorage } from '../source-control/base.js';
import {
  FACTORY_EXECUTION_EPOCHS_SCHEMA,
  FACTORY_EXECUTION_RESERVATIONS_SCHEMA,
  FactoryExecutionEpochStorage,
} from './base.js';
import {
  FACTORY_CORE_MANAGER_LEASES_SCHEMA,
  FactoryManagedCoreEffectStorage,
  FACTORY_CORE_MANAGED_EFFECT_CAPABILITY,
} from './managed-effect.js';
import type { TrustedManagedCoreRun } from './managed-effect.js';

const privateRuns = new WeakMap<object, TrustedManagedCoreRun>();
const privateResolver = async (_ops: unknown, invocation: unknown) =>
  invocation && typeof invocation === 'object' ? (privateRuns.get(invocation) ?? null) : null;
type Backend = LibSQLFactoryStorage | PgFactoryStorage;

async function open(storage: Backend) {
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const epochs = storage.registerDomain(new FactoryExecutionEpochStorage());
  storage.registerDomain(new SourceControlStorage());
  storage.registerDomain(new FactoryExecutionOriginStorage(async () => null));
  const managed = storage.registerDomain(new FactoryManagedCoreEffectStorage(privateResolver));
  await storage.init();
  return { storage, projects, epochs, managed };
}

async function seed(f: Awaited<ReturnType<typeof open>>) {
  const suffix = randomUUID();
  const project = await f.projects.create({ orgId: 'org-managed', userId: 'owner-managed', input: { name: 'HTAI' } });
  const source = (await f.storage.ops.insertOne('source_control_sessions', {
    session_id: 'session-' + suffix,
    project_repository_id: 'repo-' + suffix,
    factory_project_id: project.id,
    org_id: 'org-managed',
    user_id: 'owner-managed',
    branch: 'main',
    base_branch: 'main',
    visibility: 'org',
    origin_session_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  })) as { id: string };
  const run: TrustedManagedCoreRun = {
    orgId: 'org-managed',
    projectId: project.id,
    userId: 'owner-managed',
    sessionId: 'session-' + suffix,
    sourceRowId: source.id,
    resourceId: project.id,
    threadId: 'thread-' + suffix,
    runId: 'run-' + suffix,
    attemptId: 'attempt-' + suffix,
    phase: 'start',
    ownerEpoch: 'gp-epoch-1',
    leaseId: 'lease-' + suffix,
    managerWriterId: 'pm-writer-1',
  };
  await f.epochs.provisionUnarmed({ orgId: run.orgId, projectId: run.projectId });
  expect(await f.epochs.bindThread(run)).toBe('bound');
  // Only a purpose-built isolated test fixture can make B1 coverage positive.
  // There is no production coverage attestor, arming API or GP lease writer.
  await f.storage.withTransaction(async ops => {
    await ops.updateAtomic(
      FACTORY_EXECUTION_EPOCHS_SCHEMA.name,
      { org_id: run.orgId, factory_project_id: run.projectId },
      () => ({ fence_armed: true, coverage_version: 1, mapping_digest: 'digest-mapped' }),
    );
  });
  expect(
    await f.epochs.tryQuiesce({
      orgId: run.orgId,
      projectId: run.projectId,
      expectedRevision: 0,
      ownerEpoch: run.ownerEpoch,
    }),
  ).toBe('quiescing');
  const now = new Date();
  await f.storage.ops.insertOne(FACTORY_EXECUTION_ORIGINS_SCHEMA.name, {
    org_id: run.orgId,
    factory_project_id: run.projectId,
    user_id: run.userId,
    session_id: run.sessionId,
    source_row_id: run.sourceRowId,
    resource_id: run.resourceId,
    thread_id: run.threadId,
    anchor: 'test-anchor-' + suffix,
    request_id: 'test-request-' + suffix,
    kind_at_issue: 'unverified',
    state: 'verified',
    created_at: now,
    updated_at: now,
  });
  await f.storage.ops.insertOne(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, {
    org_id: run.orgId,
    factory_project_id: run.projectId,
    lease_id: run.leaseId,
    manager_writer_id: run.managerWriterId,
    owner_epoch: run.ownerEpoch,
    gp_consent_digest: 'a'.repeat(64),
    policy_digest: 'b'.repeat(64),
    mapping_digest: 'digest-mapped',
    automation_revision: 0,
    coverage_version: 1,
    state: 'active',
    expires_at: new Date(Date.now() + 600_000),
    created_at: now,
    updated_at: now,
  });
  const privateInvocation = Object.freeze({ marker: Symbol('server-owned-run') });
  privateRuns.set(privateInvocation, run);
  return { run, privateInvocation };
}

function invoke(
  f: Awaited<ReturnType<typeof open>>,
  privateCoreInvocation: unknown,
  boundary: Parameters<typeof f.managed.beginEffect>[0]['boundary'] = 'model-provider-request',
) {
  return f.managed.beginEffect({ boundary, privateCoreInvocation });
}

describe('A2d inert PG managed-effect protocol', () => {
  it('advertises no adoption or live activation and fails closed for unsupported LibSQL', async () => {
    expect(FACTORY_CORE_MANAGED_EFFECT_CAPABILITY).toMatchObject({
      backend: 'postgres',
      adoptionReady: false,
      runtimeMode: 'disabled',
    });
    const f = await open(new LibSQLFactoryStorage({ id: 'a2d-libsql', url: ':memory:' }));
    try {
      const { privateInvocation } = await seed(f);
      expect(await invoke(f, privateInvocation)).toEqual({ status: 'not_ready' });
      expect(await f.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name, {})).toEqual([]);
    } finally {
      await f.storage.close();
    }
  });

  it('never accepts caller-echoed identity, remote Gateway or synchronous ingress', async () => {
    const f = await open(new LibSQLFactoryStorage({ id: 'a2d-spoof', url: ':memory:' }));
    try {
      const { run } = await seed(f);
      expect(await invoke(f, { ...run })).toEqual({ status: 'denied' });
      expect(await invoke(f, null)).toEqual({ status: 'denied' });
      expect(await invoke(f, run, 'remote-gateway')).toEqual({ status: 'unsupported' });
      expect(await invoke(f, run, 'provider-eager-network')).toEqual({ status: 'unsupported' });
      expect(await invoke(f, run, 'synchronous-clone-construction')).toEqual({ status: 'unsupported' });
      expect(await invoke(f, run, 'synchronous-thread-signal')).toEqual({ status: 'unsupported' });
    } finally {
      await f.storage.close();
    }
  });
});

const pgUrl = process.env.FACTORY_A2D_PG_TEST_URL;

// Two real OS processes, independent PG pools and a parent-issued start
// barrier. This does not rely on one event loop's Promise scheduling.
function pgWorker(mode: 'begin' | 'revoke', run: TrustedManagedCoreRun) {
  const source = fileURLToPath(new URL('./managed-effect.worker.mts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', source], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACTORY_A2D_PG_TEST_URL: pgUrl!,
      FACTORY_A2D_WORKER_MODE: mode,
      FACTORY_A2D_WORKER_RUN: JSON.stringify(run),
    },
  });
  let stdout = '';
  let stderr = '';
  let notifiedReady = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.on('data', data => {
    stdout += String(data);
    if (!notifiedReady && stdout.includes('READY\n')) {
      notifiedReady = true;
      readyResolve();
    }
  });
  child.stderr.on('data', data => {
    stderr += String(data);
  });
  const completed = new Promise<{ status: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (!notifiedReady) readyReject(new Error('A2d worker exited before barrier: ' + stderr.slice(-400)));
      const line = stdout.split('\n').find(part => part.startsWith('RESULT:'));
      if (code !== 0 || !line) {
        reject(new Error('A2d worker failed (code ' + code + '): ' + stderr.slice(-400)));
        return;
      }
      resolve(JSON.parse(line.slice('RESULT:'.length)) as { status: string });
    });
  });
  return { ready, completed, start: () => child.stdin.end('go\n'), stop: () => child.kill() };
}

describe.skipIf(!pgUrl)('PG18 same-pool A2d begin/revoke/UNKNOWN proof', () => {
  async function pgFixture() {
    const f = await open(new PgFactoryStorage({ connectionString: pgUrl! }));
    const scope = await seed(f);
    return { ...f, ...scope };
  }

  it('begins once with DB-clock lease, then blocks attempt replay and crash UNKNOWN', async () => {
    const f = await pgFixture();
    try {
      const first = await invoke(f, f.privateInvocation);
      expect(first.status).toBe('begun');
      if (first.status !== 'begun') throw new Error('missing reservation');
      expect(await invoke(f, f.privateInvocation)).toEqual({ status: 'duplicate' });
      expect(
        await f.epochs.markUncertain({
          orgId: f.run.orgId,
          projectId: f.run.projectId,
          reservationId: first.reservationId,
        }),
      ).toBe(true);
      const secondInvocation = Object.freeze({ anotherAttempt: true });
      privateRuns.set(secondInvocation, { ...f.run, attemptId: 'attempt-second' });
      expect(await invoke(f, secondInvocation)).toEqual({ status: 'duplicate' });
      expect(
        await f.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name, {
          org_id: f.run.orgId,
          factory_project_id: f.run.projectId,
        }),
      ).toMatchObject([{ state: 'unknown' }]);
    } finally {
      await f.storage.close();
    }
  });

  it('denies stale GP lease, native unpause, changed source owner or quarantine', async () => {
    const f = await pgFixture();
    try {
      const where = { org_id: f.run.orgId, factory_project_id: f.run.projectId };
      await f.storage.ops.updateMany(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where, { state: 'revoked' });
      expect(await invoke(f, f.privateInvocation)).toEqual({ status: 'denied' });
      await f.storage.ops.updateMany(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where, {
        state: 'active',
        expires_at: new Date(0),
      });
      expect(await invoke(f, f.privateInvocation)).toEqual({ status: 'denied' });
      await f.storage.ops.updateMany(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where, {
        expires_at: new Date(Date.now() + 600_000),
      });
      await f.storage.ops.updateMany('factory_projects', { id: f.run.projectId }, { auto_run_enabled: true });
      expect(await invoke(f, f.privateInvocation)).toEqual({ status: 'denied' });
      await f.storage.ops.updateMany('factory_projects', { id: f.run.projectId }, { auto_run_enabled: false });
      await f.storage.ops.updateMany(
        'source_control_sessions',
        { id: f.run.sourceRowId },
        { user_id: 'another-owner' },
      );
      expect(await invoke(f, f.privateInvocation)).toEqual({ status: 'denied' });
      await f.storage.ops.updateMany('source_control_sessions', { id: f.run.sourceRowId }, { user_id: f.run.userId });
      await f.storage.ops.insertOne('factory_execution_unknown_origins', {
        org_id: f.run.orgId,
        user_id: f.run.userId,
        session_id: f.run.sessionId,
        reason: 'untrusted_scope',
        created_at: new Date(),
      });
      expect(await invoke(f, f.privateInvocation)).toEqual({ status: 'denied' });
    } finally {
      await f.storage.close();
    }
  });

  it('serializes opposing begin and revocation epoch-CAS on independent pools', async () => {
    const f = await pgFixture();
    const another = await open(new PgFactoryStorage({ connectionString: pgUrl! }));
    try {
      const where = { org_id: f.run.orgId, factory_project_id: f.run.projectId };
      const revoker = async () =>
        another.storage.withTransaction(async ops => {
          await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, where, row => ({
            revision: (row.revision as number) + 1,
          }));
          await ops.updateMany(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where, { state: 'revoked' });
        });
      const [start] = await Promise.all([invoke(f, f.privateInvocation), revoker()]);
      const rows = await f.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name, where);
      expect(['begun', 'denied']).toContain(start.status);
      expect(rows).toHaveLength(start.status === 'begun' ? 1 : 0);
      expect(await invoke(f, f.privateInvocation)).not.toMatchObject({ status: 'begun' });
    } finally {
      await another.storage.close();
      await f.storage.close();
    }
  });

  it('serializes begin versus revoke across two real OS processes', async () => {
    const f = await pgFixture();
    const begin = pgWorker('begin', f.run);
    const revoke = pgWorker('revoke', f.run);
    try {
      await Promise.all([begin.ready, revoke.ready]);
      begin.start();
      revoke.start();
      const [started, stopped] = await Promise.all([begin.completed, revoke.completed]);
      expect(stopped).toEqual({ status: 'revoked' });
      expect(['begun', 'denied']).toContain(started.status);
      const rows = await f.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name, {
        org_id: f.run.orgId,
        factory_project_id: f.run.projectId,
      });
      expect(rows).toHaveLength(started.status === 'begun' ? 1 : 0);
      // A newly issued attempt cannot start after revocation, regardless of
      // whether its earlier attempt committed before the revocation CAS.
      const fresh = Object.freeze({ postRevocation: true });
      privateRuns.set(fresh, { ...f.run, attemptId: 'post-revoke-' + randomUUID() });
      expect(await invoke(f, fresh)).toEqual({ status: 'denied' });
    } finally {
      begin.stop();
      revoke.stop();
      await f.storage.close();
    }
  }, 30_000);

  it('preserves pre-effect reservation after process exit and blocks fresh attempt on restart', async () => {
    const f = await pgFixture();
    const original = pgWorker('begin', f.run);
    try {
      await original.ready;
      original.start();
      expect((await original.completed).status).toBe('begun');
      const laterRun = { ...f.run, attemptId: 'post-crash-' + randomUUID() };
      const restarted = pgWorker('begin', laterRun);
      try {
        await restarted.ready;
        restarted.start();
        expect(await restarted.completed).toEqual({ status: 'duplicate' });
      } finally {
        restarted.stop();
      }
      const rows = await f.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name, {
        org_id: f.run.orgId,
        factory_project_id: f.run.projectId,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'reserved' });
    } finally {
      original.stop();
      await f.storage.close();
    }
  }, 30_000);
});
