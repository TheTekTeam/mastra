import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditDomain } from '../storage/domains/audit/domain.js';
import { factoryDecisionHash } from '../storage/domains/work-items/base.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { FactoryStorageTestSeed } from '../storage/test-utils.js';
import { AutomationRunRoutes } from './automation-runs.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

let seed: FactoryStorageTestSeed;
let PROJECT_ID = '';
let WORK_ITEM_ID = '';

const orgUser = { workosId: 'u1', organizationId: 'org1' };

function buildApp(
  user: { workosId: string; organizationId?: string } | null,
  options: { enabled?: boolean; isOrganizationAdmin?: (orgId: string, userId: string) => Promise<boolean> } = {},
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  const audit = new AuditDomain({
    auth: fakeRouteAuth(options),
    audit: seed.audit,
    projects: seed.projects,
  });
  mountApiRoutes(
    app as any,
    new AutomationRunRoutes({
      auth: fakeRouteAuth(options),
      audit,
      projects: seed.projects,
      workItems: seed.workItems,
      configVersion: 'factory-config-v1',
    }).routes(),
  );
  return app;
}

const listAudit = (orgId: string) => seed.audit.list({ orgId });

function post(body: unknown, user: typeof orgUser | null = orgUser, options = {}) {
  const path = `/web/factory/projects/${PROJECT_ID}/work-items/${WORK_ITEM_ID}/automation-runs`;
  return buildApp(user, options).request(path, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

function getReceipt(
  requestId = REQUEST_ID,
  user: typeof orgUser | null = orgUser,
  options: { enabled?: boolean; isOrganizationAdmin?: (orgId: string, userId: string) => Promise<boolean> } = {},
) {
  return buildApp(user, options).request(`/web/factory/projects/${PROJECT_ID}/automation-runs/${requestId}`, {
    method: 'GET',
  });
}

const listDecisions = () => seed.workItems.listDeferredDecisions('org1', PROJECT_ID);
const listDecisionsLocal = () => seed.workItems.listDeferredDecisions('local', PROJECT_ID);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

async function persistedReceiptRows() {
  const ingress = await seed.storage.ops.findOne('factory_rule_ingress', {
    org_id: 'org1',
    factory_project_id: PROJECT_ID,
    identity: `external-orchestrator:${REQUEST_ID}`,
  });
  if (!ingress) throw new Error('Expected persisted ingress');
  const evaluation = await seed.storage.ops.findOne('factory_rule_evaluations', {
    ingress_id: ingress.id,
  });
  if (!evaluation) throw new Error('Expected persisted evaluation');
  const effect = await seed.storage.ops.findOne('factory_deferred_decisions', {
    evaluation_id: evaluation.id,
    idempotency_key: `external-orchestrator:${REQUEST_ID}`,
  });
  if (!effect) throw new Error('Expected persisted effect');
  return { ingress, evaluation, effect };
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  expectedRevision: 1,
  role: 'work',
  skillName: 'factory-plan',
  ...overrides,
});

async function seedProjectAndItem(orgId = 'org1') {
  const project = await seed.projects.create({ orgId, userId: 'u1', input: { name: `${orgId} project` } });
  PROJECT_ID = project.id;
  const { item } = await seed.workItems.upsert({
    orgId,
    userId: 'u1',
    factoryProjectId: PROJECT_ID,
    input: { title: 'Bootstrap from intake', stages: ['intake'] },
  });
  WORK_ITEM_ID = item.id;
  return item;
}

beforeEach(async () => {
  seed = await createFactoryStorageForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('automation-runs ingress', () => {
  it('commits one bounded invokeSkill decision and stores a system actor', async () => {
    await seedProjectAndItem();
    const res = await post(validBody());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'committed', requestId: REQUEST_ID });

    const decisions = await listDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toMatchObject({ type: 'invokeSkill', role: 'work', skillName: 'factory-plan' });
    expect(decisions[0]!.actor).toEqual({ type: 'system', id: 'factory-external-orchestrator' });
    const events = await listAudit('org1');
    expect(events.events.map(e => e.action)).toContain('factory.run.queued');
  });

  it('rejects tenant callers who are not organization administrators', async () => {
    await seedProjectAndItem();
    const res = await post(validBody(), orgUser, { isOrganizationAdmin: async () => false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
    expect(await listDecisions()).toHaveLength(0);
  });

  it('rejects unauthenticated tenant callers', async () => {
    await seedProjectAndItem();
    const res = await post(validBody(), null);
    expect(res.status).toBe(401);
    expect(await listDecisions()).toHaveLength(0);
  });

  it('supports the trusted local no-auth storage scope without inventing a tenant user', async () => {
    await seedProjectAndItem('local');
    const res = await post(validBody(), null, { enabled: false });
    expect(res.status).toBe(202);
    const decisions = await listDecisionsLocal();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.actor).toEqual({ type: 'system', id: 'factory-external-orchestrator' });
    // Audit must persist under the synthetic `local` scope — the tenant-gated
    // emit() path would silently drop it here.
    const events = await listAudit('local');
    const queued = events.events.find(e => e.action === 'factory.run.queued');
    expect(queued).toBeDefined();
    expect(queued!.actorType).toBe('system');
    expect(queued!.actorId).toBe('factory-external-orchestrator');
  });

  it('replays the same request id without inserting a second decision', async () => {
    await seedProjectAndItem();
    const first = await post(validBody());
    expect(first.status).toBe(202);
    const second = await post(validBody());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'replayed', requestId: REQUEST_ID });
    expect(await listDecisions()).toHaveLength(1);

    // The replay must not append a second audit event for the same request.
    const events = await listAudit('org1');
    expect(events.events.filter(e => e.action === 'factory.run.queued')).toHaveLength(1);
  });

  it('rejects a stale expected revision without creating a runnable decision', async () => {
    await seedProjectAndItem();
    const res = await post(validBody({ expectedRevision: 99 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'rejected', code: 'stale' });
    expect(await listDecisions()).toHaveLength(0);
    const events = await listAudit('org1');
    expect(events.events.map(e => e.action)).toContain('factory.run.rejected');
  });

  it('rejects reuse of a request id for a different operation', async () => {
    await seedProjectAndItem();
    const first = await post(validBody());
    expect(first.status).toBe(202);

    // Same requestId, different skill — must not be reported as durably queued.
    const conflict = await post(validBody({ skillName: 'factory-triage', role: 'triage' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ status: 'rejected', code: 'request_id_conflict' });
    expect(await listDecisions()).toHaveLength(1);

    const events = await listAudit('org1');
    const rejected = events.events.find(
      e => e.action === 'factory.run.rejected' && (e.metadata as any)?.code === 'request_id_conflict',
    );
    expect(rejected).toBeDefined();
  });

  it('rejects unsupported request fields at the HTTP boundary', async () => {
    await seedProjectAndItem();
    const res = await post(validBody({ extra: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_automation_run_request' });
    expect(await listDecisions()).toHaveLength(0);
  });

  it('rejects unknown roles before a deferred failure can be queued', async () => {
    await seedProjectAndItem();
    const res = await post(validBody({ role: 'ghost' }));
    expect(res.status).toBe(400);
    expect(await listDecisions()).toHaveLength(0);
  });

  it('returns 404 for an unknown work item', async () => {
    await seedProjectAndItem();
    WORK_ITEM_ID = '22222222-2222-4222-8222-222222222222';
    const res = await post(validBody());
    expect(res.status).toBe(404);
    expect(await listDecisions()).toHaveLength(0);
  });
  // #208: a 202 response cannot prove which work item/skill was committed.
  // The independent supervisor needs a durable native identity read after ingress.
  it('reads back the exact committed enqueue binding without disclosing arguments', async () => {
    await seedProjectAndItem();
    expect((await post(validBody({ arguments: '  private operator argument  ' }))).status).toBe(202);
    const effect = (await listDecisions())[0]!;
    const response = await getReceipt();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toEqual({
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      workItemId: WORK_ITEM_ID,
      role: 'work',
      skillName: 'factory-plan',
      argumentsSha256: createHash('sha256').update(JSON.stringify('private operator argument')).digest('hex'),
      expectedRevision: 1,
      nativeEffectId: effect.id,
      decisionStatus: 'pending',
    });
    expect(JSON.stringify(receipt)).not.toContain('private operator argument');
  });

  it('survives replay and a fresh HTTP handler without creating a second effect', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const first = await getReceipt();
    expect(first.status).toBe(200);
    expect((await post(validBody())).status).toBe(200);
    const next = await getReceipt();
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual(await first.json());
    expect(await listDecisions()).toHaveLength(1);
  });

  // #208: a new process must be able to prove the exact committed enqueue
  // from durable storage after the original LibSQL connection is gone.
  it('preserves the native enqueue receipt across a file-backed database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-enqueue-receipt-'));
    const url = `file:${join(directory, 'factory.db')}`;
    const originalSeed = seed;
    const persistedSeed = await createFactoryStorageForTests({ url, closeOnTestFinished: false });
    let persistedClosed = false;
    let reopenedSeed: FactoryStorageTestSeed | undefined;
    try {
      seed = persistedSeed;
      await seedProjectAndItem();
      expect((await post(validBody({ arguments: '  persisted private argument  ' }))).status).toBe(202);
      const effectId = (await listDecisions())[0]!.id;
      const expected = {
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
        workItemId: WORK_ITEM_ID,
        role: 'work',
        skillName: 'factory-plan',
        argumentsSha256: createHash('sha256').update(JSON.stringify('persisted private argument')).digest('hex'),
        expectedRevision: 1,
        nativeEffectId: effectId,
        decisionStatus: 'pending',
      };

      await persistedSeed.storage.close();
      persistedClosed = true;
      reopenedSeed = await createFactoryStorageForTests({ url, closeOnTestFinished: false });
      seed = reopenedSeed;
      const response = await getReceipt();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect((await post(validBody({ arguments: '  persisted private argument  ' }))).status).toBe(200);
      expect(await listDecisions()).toHaveLength(1);
    } finally {
      seed = originalSeed;
      if (reopenedSeed) await reopenedSeed.storage.close();
      if (!persistedClosed) await persistedSeed.storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // #208: a fresh handler in the same Node process cannot prove OS-process durability.
  it('reads the exact native receipt from a separate Node process after storage closes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-enqueue-process-'));
    const url = `file:${join(directory, 'factory.db')}`;
    const originalSeed = seed;
    const persistedSeed = await createFactoryStorageForTests({ url, closeOnTestFinished: false });
    let persistedClosed = false;
    try {
      seed = persistedSeed;
      await seedProjectAndItem();
      expect((await post(validBody({ arguments: '  cross-process private argument  ' }))).status).toBe(202);
      const originalReceipt = await getReceipt();
      expect(originalReceipt.status).toBe(200);
      const expected = await originalReceipt.json();
      await persistedSeed.storage.close();
      persistedClosed = true;

      // The child reads real persisted storage in a fresh PID without operator credentials.
      const childScript = [
        "import { Hono } from 'hono';",
        "import { LibSQLFactoryStorage } from '@mastra/libsql';",
        "import { WorkItemsStorage } from './src/storage/domains/work-items/base.js';",
        "import { FactoryProjectsStorage } from './src/storage/domains/projects/base.js';",
        "import { AuditStorage } from './src/storage/domains/audit/base.js';",
        "import { AuditDomain } from './src/storage/domains/audit/domain.js';",
        "import { AutomationRunRoutes } from './src/routes/automation-runs.js';",
        "import { fakeRouteAuth, mountApiRoutes } from './src/routes/test-utils.js';",
        'const [url, orgId, projectId, requestId] = process.argv.slice(1);',
        "const storage = new LibSQLFactoryStorage({ id: 'factory-restart-proof', url });",
        'const workItems = storage.registerDomain(new WorkItemsStorage());',
        'const projects = storage.registerDomain(new FactoryProjectsStorage());',
        'const auditStore = storage.registerDomain(new AuditStorage());',
        'await storage.init();',
        'try {',
        '  const result = await workItems.getEnqueueReceipt(orgId, projectId, requestId);',
        '  const decisions = await workItems.listDeferredDecisions(orgId, projectId);',
        '  const makeApp = (user, isAdmin = true) => {',
        '    const app = new Hono();',
        '    app.use("*", async (c, next) => { if (user) c.set("factoryAuthUser", user); await next(); });',
        '    const auth = fakeRouteAuth({ isOrganizationAdmin: async () => isAdmin });',
        '    const audit = new AuditDomain({ auth, audit: auditStore, projects });',
        '    mountApiRoutes(app, new AutomationRunRoutes({',
        '      auth, audit, projects, workItems, configVersion: "factory-config-v1"',
        '    }).routes());',
        '    return app;',
        '  };',
        '  const path = "/web/factory/projects/" + projectId + "/automation-runs/" + requestId;',
        '  const allowed = await makeApp({ workosId: "u1", organizationId: orgId }).request(path);',
        '  const anonymous = await makeApp(null).request(path);',
        '  const nonAdmin = await makeApp({ workosId: "u1", organizationId: orgId }, false).request(path);',
        '  const foreignTenant = await makeApp({ workosId: "u2", organizationId: "foreign-org" }).request(path);',
        '  const http = {',
        '    status: allowed.status, receipt: allowed.status === 200 ? await allowed.json() : null,',
        '    anonymousStatus: anonymous.status, nonAdminStatus: nonAdmin.status,',
        '    foreignTenantStatus: foreignTenant.status',
        '  };',
        '  console.log(JSON.stringify({ pid: process.pid, result, decisionCount: decisions.length, http }));',
        '} finally { await storage.close(); }',
      ].join('\n');
      const childOutput = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', childScript, url, 'org1', PROJECT_ID, REQUEST_ID],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          encoding: 'utf8',
          timeout: 20_000,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), NODE_ENV: 'test' },
        },
      ).trim();
      const proof = JSON.parse(childOutput) as {
        pid: number;
        result: { kind: string; receipt?: unknown };
        decisionCount: number;
        http: {
          status: number;
          receipt: unknown;
          anonymousStatus: number;
          nonAdminStatus: number;
          foreignTenantStatus: number;
        };
      };
      expect(proof.pid).not.toBe(process.pid);
      expect(proof.result).toEqual({ kind: 'found', receipt: expected });
      expect(proof.decisionCount).toBe(1);
      expect(proof.http).toEqual({
        status: 200,
        receipt: expected,
        anonymousStatus: 401,
        nonAdminStatus: 200,
        foreignTenantStatus: 404,
      });
    } finally {
      seed = originalSeed;
      if (!persistedClosed) await persistedSeed.storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('grants receipt read to signed-in members of only the owning project organization', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const memberOptions = { isOrganizationAdmin: async () => false };
    const member = await getReceipt(REQUEST_ID, orgUser, memberOptions);
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      workItemId: WORK_ITEM_ID,
      role: 'work',
      skillName: 'factory-plan',
    });
    const otherMember = { workosId: 'u2', organizationId: 'org1' };
    expect((await getReceipt(REQUEST_ID, otherMember, memberOptions)).status).toBe(200);

    const unknownRequest = await getReceipt('33333333-3333-4333-8333-333333333333', orgUser, memberOptions);
    expect(unknownRequest.status).toBe(404);
    expect(await unknownRequest.json()).toEqual({ error: 'Enqueue receipt not found' });
    expect((await getReceipt(REQUEST_ID, null)).status).toBe(401);
    expect((await getReceipt(REQUEST_ID, { workosId: 'u2' }, memberOptions)).status).toBe(403);
    expect((await getReceipt(REQUEST_ID, { workosId: 'u2', organizationId: 'foreign-org' }, memberOptions)).status).toBe(404);

    const other = await seed.projects.create({ orgId: 'org1', userId: 'u1', input: { name: 'Separate project' } });
    PROJECT_ID = other.id;
    expect((await getReceipt(REQUEST_ID, orgUser, memberOptions)).status).toBe(404);
  });

  it('keeps automation POST administrator-only even when that member may GET a receipt', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const beforeAudit = await listAudit('org1');
    const beforeDecisions = await listDecisions();
    const memberOptions = { isOrganizationAdmin: async () => false };
    expect((await getReceipt(REQUEST_ID, orgUser, memberOptions)).status).toBe(200);
    expect(await listAudit('org1')).toEqual(beforeAudit);
    const forbiddenPost = await post(
      validBody({ requestId: '44444444-4444-4444-8444-444444444444' }),
      orgUser,
      memberOptions,
    );
    expect(forbiddenPost.status).toBe(403);
    expect(await forbiddenPost.json()).toMatchObject({ error: 'forbidden' });
    expect(await listDecisions()).toEqual(beforeDecisions);
  });

  it('returns 404 for unknown requests and malformed receipt identities', async () => {
    await seedProjectAndItem();
    expect((await getReceipt()).status).toBe(404);
    expect((await getReceipt('not-a-uuid')).status).toBe(404);
  });

  it('returns missing, not proof of a durable effect, for an uncommitted stale request', async () => {
    await seedProjectAndItem();
    expect((await post(validBody({ expectedRevision: 999 }))).status).toBe(409);
    // A stale ingress deliberately persists nothing, so native readback must be 404.
    expect((await getReceipt()).status).toBe(404);
  });

  it('fails closed when an accepted ingress loses its durable effect record', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const decision = (await listDecisions())[0]!;
    await seed.storage.withTransaction(async ops => {
      await ops.deleteMany('factory_deferred_decisions', { id: decision.id });
    });
    expect((await getReceipt()).status).toBe(409);
  });

  it.each([
    { name: 'wrong ingress trigger type', table: 'factory_rule_ingress', patch: { trigger_type: 'other-event' } },
    { name: 'rejected evaluation', table: 'factory_rule_evaluations', patch: { outcome: 'rejected' } },
    {
      name: 'evaluation work-item mismatch',
      table: 'factory_rule_evaluations',
      patch: { work_item_id: '22222222-2222-4222-8222-222222222222' },
    },
    { name: 'revision mismatch', table: 'factory_rule_evaluations', patch: { expected_revision: 2 } },
    {
      name: 'deferred effect work-item mismatch',
      table: 'factory_deferred_decisions',
      patch: { work_item_id: '22222222-2222-4222-8222-222222222222' },
    },
    { name: 'unexpected effect ordinal', table: 'factory_deferred_decisions', patch: { effect_ordinal: 1 } },
    { name: 'effect hash mismatch', table: 'factory_deferred_decisions', patch: { effect_hash: '0'.repeat(64) } },
    {
      name: 'non-system effect actor',
      table: 'factory_deferred_decisions',
      patch: { actor: { type: 'user', id: 'u1' } },
    },
    { name: 'unknown decision status', table: 'factory_deferred_decisions', patch: { status: 'unknown' } },
  ] as const)('fails closed on $name without creating another effect', async ({ table, patch }) => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const rows = await persistedReceiptRows();
    const target =
      table === 'factory_rule_ingress'
        ? rows.ingress
        : table === 'factory_rule_evaluations'
          ? rows.evaluation
          : rows.effect;
    await seed.storage.ops.updateMany(table, { id: target.id }, patch);
    const response = await getReceipt();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Enqueue receipt not independently verifiable' });
    expect(await listDecisions()).toHaveLength(1);
  });

  it.each([
    { field: 'role', value: 'triage' },
    { field: 'skillName', value: 'factory-triage' },
  ])('rejects a deferred effect $field that disagrees with the committed decision', async ({ field, value }) => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const { effect } = await persistedReceiptRows();
    const decision = effect.decision as Record<string, unknown>;
    await seed.storage.ops.updateMany(
      'factory_deferred_decisions',
      { id: effect.id },
      { decision: { ...decision, [field]: value } },
    );
    expect((await getReceipt()).status).toBe(409);
  });

  it('rejects a committed ingress decision that disagrees with its deferred effect', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const { ingress } = await persistedReceiptRows();
    const result = ingress.result as Record<string, unknown> & { decisions: Record<string, unknown>[] };
    await seed.storage.ops.updateMany(
      'factory_rule_ingress',
      { id: ingress.id },
      {
        result: { ...result, decisions: [{ ...result.decisions[0]!, role: 'triage' }] },
      },
    );
    expect((await getReceipt()).status).toBe(409);
  });

  it('rejects duplicate native evaluations for one accepted ingress', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const { ingress, evaluation } = await persistedReceiptRows();
    await seed.storage.ops.insertOne('factory_rule_evaluations', {
      ingress_id: ingress.id,
      work_item_id: WORK_ITEM_ID,
      rule_set_version: evaluation.rule_set_version,
      expected_revision: 1,
      outcome: 'accepted',
      code: null,
      reason: null,
      causal_chain: [],
      created_at: new Date(),
    });
    expect((await getReceipt()).status).toBe(409);
  });

  it('database uniqueness prevents a duplicate matching deferred effect', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const { evaluation } = await persistedReceiptRows();
    await expect(
      seed.storage.ops.insertOne('factory_deferred_decisions', {
        org_id: 'org1',
        factory_project_id: PROJECT_ID,
        evaluation_id: evaluation.id,
        work_item_id: WORK_ITEM_ID,
        idempotency_key: `external-orchestrator:${REQUEST_ID}`,
        effect_ordinal: 1,
        effect_hash: '0'.repeat(64),
        causal_chain: [],
        decision: { type: 'invokeSkill', role: 'work', skillName: 'factory-plan' },
        status: 'pending',
        attempts: 0,
        available_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).rejects.toThrow();
    expect((await getReceipt()).status).toBe(200);
    expect(await listDecisions()).toHaveLength(1);
  });

  it.each([
    { name: 'unsupported role', patch: { role: 'ghost' } },
    { name: 'oversized skill name', patch: { skillName: 'x'.repeat(129) } },
  ])('rejects a hash-consistent but schema-invalid $name at the HTTP boundary', async ({ patch }) => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const { ingress, effect } = await persistedReceiptRows();
    const result = ingress.result as Record<string, unknown> & { decisions: Record<string, unknown>[] };
    const decision = { ...result.decisions[0]!, ...patch };
    await seed.storage.ops.updateMany(
      'factory_rule_ingress',
      { id: ingress.id },
      {
        result: { ...result, decisions: [decision] },
      },
    );
    await seed.storage.ops.updateMany(
      'factory_deferred_decisions',
      { id: effect.id },
      {
        decision,
        effect_hash: factoryDecisionHash(decision),
      },
    );
    expect((await seed.workItems.getEnqueueReceipt('org1', PROJECT_ID, REQUEST_ID)).kind).toBe('found');
    expect((await getReceipt()).status).toBe(409);
  });

  it('keeps receipt GET read-only without appending audit or deferred-decision records', async () => {
    await seedProjectAndItem();
    expect((await post(validBody())).status).toBe(202);
    const beforeAudit = await listAudit('org1');
    const beforeDecisions = await listDecisions();
    expect((await getReceipt()).status).toBe(200);
    expect(await listAudit('org1')).toEqual(beforeAudit);
    expect(await listDecisions()).toEqual(beforeDecisions);
  });

  it('reads the same scoped receipt in local no-auth mode', async () => {
    await seedProjectAndItem('local');
    expect((await post(validBody(), null, { enabled: false })).status).toBe(202);
    const res = await getReceipt(REQUEST_ID, null, { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requestId: REQUEST_ID, projectId: PROJECT_ID });
  });
});
