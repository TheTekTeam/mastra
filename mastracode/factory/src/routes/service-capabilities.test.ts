import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { ServiceCapabilityAuthority } from '../service-capabilities/authority.js';
import { AuditDomain } from '../storage/domains/audit/domain.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { AutomationRunRoutes } from './automation-runs.js';
import { ProjectRoutes } from './projects.js';
import { ServiceCapabilityRoutes } from './service-capabilities.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const admin = { workosId: 'gp-admin', organizationId: 'verified-org' };
const member = { workosId: 'member', organizationId: 'verified-org' };
const outside = { workosId: 'outsider', organizationId: 'other-org' };
const origin = 'https://factory.example.test';
type User = typeof admin | null;
type Verb = 'GET' | 'POST' | 'PATCH';

async function scenario() {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({
    orgId: admin.organizationId, userId: admin.workosId, input: { name: 'HTAI pilot (test)' },
  });
  const { item } = await seed.workItems.upsert({
    orgId: admin.organizationId, userId: admin.workosId, factoryProjectId: project.id,
    input: { title: 'Pilot work item', stages: ['intake'] },
  });
  const { item: otherItem } = await seed.workItems.upsert({
    orgId: admin.organizationId, userId: admin.workosId, factoryProjectId: project.id,
    input: { title: 'Unapproved work item', stages: ['intake'] },
  });
  // Synthetic trusted attestation in an isolated test DB only. Production
  // exposes no provisioning path and starts with NO lease: all effects deny.
  await seed.storage.ops.insertOne('service_capability_handover_leases', {
    org_id: admin.organizationId,
    project_id: project.id,
    owner_kind: 'factory-project-manager',
    owner_epoch: randomUUID(),
    automation_revision: project.automationRevision,
    pm_dispatch_paused_at: new Date(Date.now() - 3_000),
    native_automation_paused_at: new Date(Date.now() - 2_000),
    native_sessions_drained_at: new Date(Date.now() - 1_000),
    evidence_digest: 'f'.repeat(64),
    issued_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
  });
  const authority = new ServiceCapabilityAuthority({
    projects: seed.projects,
    storage: seed.serviceCapabilities,
    policy: {
      enabled: true,
      hmacKey: randomBytes(32),
      allowedProjectIds: new Set([project.id]),
      allowedIssuerUserIds: new Set([admin.workosId]),
      adminOrigin: origin,
    },
  });
  const auth = fakeRouteAuth({
    isOrganizationAdmin: async (_orgId, userId) => userId === admin.workosId,
  });
  const audit = new AuditDomain({ auth, audit: seed.audit, projects: seed.projects });
  function appFor(user: User = admin) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (user) c.set('factoryAuthUser' as never, user as never);
      await next();
    });
    mountApiRoutes(app as never, [
      ...new ServiceCapabilityRoutes({
        auth, capabilities: authority, projects: seed.projects,
      }).routes(),
      ...new ProjectRoutes({
        auth, projects: seed.projects, sourceControl: seed.sourceControl, serviceCapabilities: authority,
      }).routes(),
      ...new AutomationRunRoutes({
        auth, audit, projects: seed.projects, workItems: seed.workItems,
        configVersion: 'factory-config-v1', serviceCapabilities: authority,
      }).routes(),
    ]);
    return app;
  }
  const base = '/web/factory/projects/' + project.id;
  const intent = {
    operation: 'issue' as const,
    actions: ['workItem.enqueue', 'projectAutomation.set'] as const,
    workItemIds: [item.id],
    enqueueProfiles: [{
      workItemId: item.id,
      role: 'work',
      skillName: 'factory-plan',
      argumentsDigest: createHash('sha256').update(JSON.stringify([false, null])).digest('hex'),
    }],
    ttlSeconds: 3600,
  };
  async function request(
    path: string,
    method: Verb,
    body?: unknown,
    headers: Record<string, string> = {},
    user: User = admin,
  ) {
    return appFor(user).request(path, {
      method,
      headers: {
        ...((body !== undefined) ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function consent(input: unknown, user: User = admin, sentOrigin: string = origin) {
    const response = await request(base + '/service-capability/consents', 'POST', input, {
      origin: sentOrigin,
    }, user);
    return { response, body: await response.json() as { consentToken?: string; error?: string } };
  }
  async function issue(input = intent) {
    const oneUse = await consent(input);
    expect(oneUse.response.status).toBe(201);
    const response = await request(base + '/service-capability/grants', 'POST', {
      ...input, consentToken: oneUse.body.consentToken,
    }, { origin });
    expect(response.status).toBe(201);
    return await response.json() as { token: string; grant: { id: string } };
  }
  return { seed, project, item, otherItem, authority, appFor, base, request, consent, issue, intent };
}

describe('explicit Factory service grants: human administration and native mutations', () => {
  it('requires GP issuer, org-admin human session, trusted HTTPS origin and exact project consent', async () => {
    const s = await scenario();
    expect((await s.consent(s.intent, member)).response.status).toBe(403);
    expect((await s.consent(s.intent, outside)).response.status).toBe(403);
    expect((await s.consent(s.intent, null)).response.status).toBe(401);
    expect((await s.consent(s.intent, admin, 'https://evil.example.test')).response.status).toBe(403);
    expect((await s.consent(s.intent, admin, '')).response.status).toBe(403);
    expect((await s.request(s.base + '/service-capability/grants', 'POST', {
      ...s.intent, consentToken: 'fcc1_' + 'a'.repeat(43),
    }, { origin })).status).toBe(409);

    const grant = await s.issue();
    const listed = await s.request(s.base + '/service-capability/grants', 'GET');
    expect(listed.status).toBe(200);
    const listingText = await listed.text();
    expect(listingText).toContain(grant.grant.id);
    expect(listingText).not.toContain(grant.token);
    expect(listingText).not.toContain(createHash('sha256').update(grant.token).digest('hex'));
    const bearer = { authorization: 'FactoryService ' + grant.token };
    expect((await s.request(s.base + '/service-capability/grants', 'GET', undefined, bearer, null)).status).toBe(401);
    expect((await s.request(s.base + '/service-capability/consents', 'POST',
      s.intent, { ...bearer, origin }, admin)).status).toBe(403);
    expect((await s.request(s.base + '/service-capability/grants', 'GET',
      undefined, bearer, admin)).status).toBe(403);
    const deniedAudit = await s.seed.serviceCapabilities.listAudit({
      orgId: admin.organizationId, projectId: s.project.id,
    });
    expect(deniedAudit.filter(e => e.outcome === 'denied').length).toBeGreaterThanOrEqual(2);
    expect((await s.request(s.base + '/service-capability/consents', 'POST', s.intent,
      { ...bearer, origin }, null)).status).toBe(401);
  });

  it('executes exact grant-scoped project CAS and enqueue, preserving human auth and native idempotence', async () => {
    const s = await scenario();
    const grant = await s.issue();
    const authorization = 'FactoryService ' + grant.token;
    const old = s.project;
    const casBody = {
      expectedAutomationRevision: old.automationRevision,
      expectedAutoRunEnabled: old.autoRunEnabled,
      expectedAutoApprovePlans: old.autoApprovePlans,
      autoRunEnabled: true,
      autoApprovePlans: false,
    };
    expect((await s.request(s.base + '/automation', 'PATCH', casBody, {}, member)).status).toBe(403);
    const casRequestId = randomUUID();
    const cas = await s.request(s.base + '/automation', 'PATCH', casBody, {
      authorization, 'x-factory-request-id': casRequestId, 'x-mastra-organization-id': 'other-org',
    }, null);
    expect(cas.status).toBe(200);
    expect((await cas.json() as { project: { automationRevision: number } }).project.automationRevision)
      .toBe(old.automationRevision + 1);
    // A Manager bridge must re-attest and persist the new native revision
    // after every automation CAS. A stale attestation cannot authorize effects.
    await s.seed.storage.ops.updateAtomic('service_capability_handover_leases', {
      org_id: admin.organizationId, project_id: s.project.id,
    }, () => ({ automation_revision: old.automationRevision + 1 }));
    const stale = await s.request(s.base + '/automation', 'PATCH', casBody, {
      authorization, 'x-factory-request-id': randomUUID(),
    }, null);
    expect(stale.status).toBe(409);
    const reusedIntent = await s.request(s.base + '/automation', 'PATCH', {
      expectedAutomationRevision: old.automationRevision + 1,
      expectedAutoRunEnabled: true, expectedAutoApprovePlans: false,
      autoRunEnabled: false, autoApprovePlans: true,
    }, { authorization, 'x-factory-request-id': casRequestId }, null);
    // Native CAS would succeed, but a previous service requestId must bind to
    // its original immutable body; no new effect or implicit replay is allowed.
    expect(reusedIntent.status).toBe(403);
    expect((await s.seed.projects.get({ orgId: admin.organizationId, id: s.project.id }))?.automationRevision)
      .toBe(old.automationRevision + 1);

    const enqueuePath = s.base + '/work-items/' + s.item.id + '/automation-runs';
    const run = {
      requestId: randomUUID(),
      expectedRevision: 1,
      role: 'work', skillName: 'factory-plan',
    };
    const result = await s.request(enqueuePath, 'POST', run, { authorization }, null);
    expect(result.status).toBe(202);
    const replay = await s.request(enqueuePath, 'POST', run, { authorization }, null);
    expect(replay.status).toBe(403);
    expect((await s.seed.workItems.listDeferredDecisions(admin.organizationId, s.project.id))).toHaveLength(1);
    expect((await s.request(enqueuePath, 'POST', { ...run, skillName: 'different' },
      { authorization }, null)).status).toBe(403);
    expect((await s.seed.serviceCapabilities.listAudit({
      orgId: admin.organizationId, projectId: s.project.id,
    })).map(e => e.outcome)).toEqual(expect.arrayContaining(['admitted', 'succeeded', 'rejected']));
  });

  it('denies absent/foreign/revoked/malformed bearer, wrong operation, project and work-item scope', async () => {
    const s = await scenario();
    const grant = await s.issue();
    const authorized = { authorization: 'FactoryService ' + grant.token };
    const path = s.base + '/work-items/' + s.item.id + '/automation-runs';
    const wrongItemPath = s.base + '/work-items/' + s.otherItem.id + '/automation-runs';
    const run = { requestId: randomUUID(), expectedRevision: 1, role: 'work', skillName: 'factory-plan' };
    expect((await s.request(path, 'POST', run, {
      authorization: 'FactoryService ' + 'z'.repeat(48),
    }, null)).status).toBe(403);
    expect((await s.request(path, 'POST', run, {
      authorization: 'FactoryService malformed',
    }, null)).status).toBe(403);
    expect((await s.request(wrongItemPath, 'POST', run, authorized, null)).status).toBe(403);
    expect((await s.request(path, 'POST', { ...run, role: 'plan' }, authorized, null)).status).toBe(403);
    expect((await s.request(path, 'POST', { ...run, skillName: 'sensitive-skill' },
      authorized, null)).status).toBe(403);
    expect((await s.request(path, 'POST', { ...run, arguments: 'unsanctioned' },
      authorized, null)).status).toBe(403);
    const otherProject = await s.seed.projects.create({
      orgId: 'other-org', userId: 'outsider', input: { name: 'Other tenant' },
    });
    expect((await s.request('/web/factory/projects/' + otherProject.id + '/automation', 'PATCH', {
      expectedAutomationRevision: 0, expectedAutoRunEnabled: false,
      expectedAutoApprovePlans: false, autoRunEnabled: true, autoApprovePlans: false,
    }, { ...authorized, 'x-factory-request-id': randomUUID() }, null)).status).toBe(403);
    const intent = { operation: 'revoke' as const, targetGrantId: grant.grant.id };
    const revokeConsent = await s.consent(intent);
    expect(revokeConsent.response.status).toBe(201);
    const revoked = await s.request(s.base + '/service-capability/grants/' + grant.grant.id + '/revoke',
      'POST', { consentToken: revokeConsent.body.consentToken }, { origin });
    expect(revoked.status).toBe(200);
    expect((await s.request(path, 'POST', run, authorized, null)).status).toBe(403);
    expect(await s.seed.workItems.listDeferredDecisions(admin.organizationId, s.project.id)).toHaveLength(0);
  });

  it('denies service effects on missing, expired, revoked, wrong-owner or stale-revision handover', async () => {
    for (const kind of ['missing', 'expired', 'revoked', 'wrong-owner', 'stale-revision']) {
      const s = await scenario();
      const grant = await s.issue();
      const key = { org_id: admin.organizationId, project_id: s.project.id };
      if (kind === 'missing') {
        await s.seed.storage.ops.deleteMany('service_capability_handover_leases', key);
      } else {
        await s.seed.storage.ops.updateAtomic('service_capability_handover_leases', key, () => ({
          ...(kind === 'expired' ? { expires_at: new Date(Date.now() - 1_000) } : {}),
          ...(kind === 'revoked' ? { revoked_at: new Date() } : {}),
          ...(kind === 'wrong-owner' ? { owner_kind: 'untrusted-app' } : {}),
          ...(kind === 'stale-revision' ? { automation_revision: 999 } : {}),
        }));
      }
      const response = await s.request(s.base + '/automation', 'PATCH', {
        expectedAutomationRevision: s.project.automationRevision,
        expectedAutoRunEnabled: s.project.autoRunEnabled,
        expectedAutoApprovePlans: s.project.autoApprovePlans,
        autoRunEnabled: true, autoApprovePlans: false,
      }, {
        authorization: 'FactoryService ' + grant.token,
        'x-factory-request-id': randomUUID(),
      }, null);
      expect(response.status, kind).toBe(403);
      expect((await s.seed.projects.get({
        orgId: admin.organizationId, id: s.project.id,
      }))?.automationRevision).toBe(s.project.automationRevision);
    }
  });

  it('fails closed before effect on admission journal failure and reports EFFECT_UNVERIFIED after committed effect', async () => {
    const s = await scenario();
    const grant = await s.issue();
    const authorization = 'FactoryService ' + grant.token;
    const path = s.base + '/work-items/' + s.item.id + '/automation-runs';
    const run = { requestId: randomUUID(), expectedRevision: 1, role: 'work', skillName: 'factory-plan' };
    const pre = vi.spyOn(s.seed.serviceCapabilities, 'admitAndRecord')
      .mockRejectedValueOnce(new Error('audit database unavailable'));
    expect((await s.request(path, 'POST', run, { authorization }, null)).status).toBe(503);
    expect(await s.seed.workItems.listDeferredDecisions(admin.organizationId, s.project.id)).toHaveLength(0);
    pre.mockRestore();
    const post = vi.spyOn(s.seed.serviceCapabilities, 'finishEffect')
      .mockRejectedValueOnce(new Error('outcome audit unavailable'));
    const uncertain = await s.request(path, 'POST', run, { authorization }, null);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({ status: 'EFFECT_UNVERIFIED' });
    expect(await s.seed.workItems.listDeferredDecisions(admin.organizationId, s.project.id)).toHaveLength(1);
    post.mockRestore();
  });
});
