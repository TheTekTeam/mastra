import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { AuditDomain } from '../storage/domains/audit/domain.js';
import { issueCompletionDigest } from '../storage/domains/work-items/completion-evidence.js';
import type { IssueCompletionPayload, IssueCompletionReceipt } from '../storage/domains/work-items/completion-evidence.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import type { FactoryStorageTestSeed } from '../storage/test-utils.js';
import { AutomationRunRoutes } from './automation-runs.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const ORG = 'org1';
const USER = { workosId: 'u1', organizationId: ORG };
const REQUEST = '11111111-1111-4111-8111-111111111111';
type Verify = (receipt: IssueCompletionReceipt, scope: { orgId: string; factoryProjectId: string; repositoryId: string }) => Promise<boolean>;

function app(seed: FactoryStorageTestSeed, verify?: Verify, user: { workosId: string; organizationId?: string } | null = USER, noAdmin = false, enabled = true) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  const auth = fakeRouteAuth({ enabled, ...(noAdmin ? { isOrganizationAdmin: async () => false } : {}) });
  const audit = new AuditDomain({ auth, audit: seed.audit, projects: seed.projects });
  mountApiRoutes(hono as any, new AutomationRunRoutes({
    auth, audit, projects: seed.projects, workItems: seed.workItems,
    configVersion: 'fixture',
    ...(verify ? { verifyIssueCompletionEvidence: verify } : {}),
  }).routes());
  return hono;
}

async function fixture() {
  const seed = await createFactoryStorageForTests();
  seed.workItems.useTerminalPhasePredicate(item => item.stages.includes('intake'));
  const project = await seed.projects.create({ orgId: ORG, userId: 'u1', input: { name: 'HTAI QA' } });
  const { item } = await seed.workItems.upsert({
    orgId: ORG, userId: 'u1', factoryProjectId: project.id,
    input: {
      title: 'GitHub issue 42', stages: ['intake'],
      externalSource: { integrationId: 'github', type: 'issue', externalId: 'github-issue:42' },
      metadata: { githubIssueNumber: 42, githubRepositoryId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repository: 'TheTekTeam/HTAI' },
    },
  });
  const path = `/web/factory/projects/${project.id}/issue-completion-evidence/${item.id}`;
  const enqueue = await app(seed).request(
    `/web/factory/projects/${project.id}/work-items/${item.id}/automation-runs`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: REQUEST, expectedRevision: item.revision, role: 'work', skillName: 'factory-plan' }) },
  );
  expect(enqueue.status).toBe(202);
  const effects = await seed.workItems.listDeferredDecisions(ORG, project.id);
  expect(effects).toHaveLength(1);
  const effect = effects[0]!;
  await seed.storage.ops.updateMany('factory_deferred_decisions', { id: effect.id }, {
    status: 'succeeded', completed_at: new Date(),
  });
  const payload: IssueCompletionPayload = {
    ok: true, source: 'independent_native_issue_completion_readback',
    kind: 'issue_completion', schemaVersion: 1,
    projectId: project.id, workItemId: item.id, workItemRevision: item.revision,
    sourceRepository: 'TheTekTeam/HTAI', sourceIssueNumber: 42,
    sourceVersion: 'factory_0_25_issue_v1', sourceSnapshotId: 'd'.repeat(64),
    pullRequestNumber: 67, headSha: 'a'.repeat(40),
    reviewerIdentity: 'modelspend-reviewer',
    reviewHeadSha: 'a'.repeat(40), ciHeadSha: 'a'.repeat(40),
    mergeSha: 'b'.repeat(40), nativeEffectId: effect.id,
    acceptedAt: new Date().toISOString(), finalEffectState: 'completed',
    executionVerified: true, independentNativeCompletion: true,
  };
  const receipt = { ...payload, proofDigest: issueCompletionDigest(payload) };
  return { seed, project, item, path, receipt };
}

async function persistCandidate(data: Awaited<ReturnType<typeof fixture>>) {
  const { seed, project, item, receipt } = data;
  const result = await seed.workItems.acceptIssueCompletionEvidenceCandidate({
    orgId: ORG, factoryProjectId: project.id, receipt,
    // Independent GitHub App verifier is stubbed only in isolated route fixture.
    verify: async () => true,
  });
  expect(result.status).toBe('committed');
}

describe('authenticated native issue completion readback', () => {
  it('never infers completion from an item phase or enqueue alone', async () => {
    const f = await fixture();
    const response = await app(f.seed).request(f.path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Issue completion evidence not found' });
  });

  it('denies unauthenticated and cross-tenant access, and keeps unsigned candidates default-off for members', async () => {
    const f = await fixture();
    await persistCandidate(f);
    // Explicit JSON errors prevent an absent/unmatched API route from falling
    // through the Factory SPA and returning misleading HTTP 200 HTML.
    for (const [user, status, error] of [
      [null, 401, 'unauthorized'],
      [{ workosId: 'other', organizationId: 'other' }, 404, 'Project not found'],
      [{ workosId: 'other' }, 403, 'organization_required'],
    ] as const) {
      const denied = await app(f.seed, undefined, user).request(f.path);
      expect(denied.status).toBe(status);
      expect(denied.headers.get('content-type')).toContain('application/json');
      expect(await denied.json()).toMatchObject({ error });
    }
    expect((await app(f.seed, undefined, USER, true).request(f.path)).status).toBe(409);
    expect((await app(f.seed).request(f.path)).status).toBe(409);
    expect((await app(f.seed, undefined, null, false, false).request(f.path)).status).toBe(401);
    expect((await app(f.seed).request(f.path.replace(f.item.id, 'bogus'))).status).toBe(404);
  });

  it('only accepts exact stored receipt after a separate independent verifier positively attests', async () => {
    const f = await fixture();
    await persistCandidate(f);
    expect((await app(f.seed, async () => false).request(f.path)).status).toBe(409);
    expect((await app(f.seed, async () => { throw new Error('upstream failed'); }).request(f.path)).status).toBe(409);
    const verifier = vi.fn(async (candidate: IssueCompletionReceipt, scope: { orgId: string; factoryProjectId: string; repositoryId: string }) => {
      expect(candidate).toEqual(f.receipt);
      expect(scope).toEqual({ orgId: ORG, factoryProjectId: f.project.id,
        repositoryId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      return true;
    });
    const response = await app(f.seed, verifier).request(f.path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(f.receipt);
    expect(Object.keys(f.receipt)).toHaveLength(23);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it('does not report an issue complete before the independently attested acceptance time', async () => {
    const f = await fixture();
    const { proofDigest: _previousDigest, ...payload } = f.receipt;
    const futurePayload = { ...payload, acceptedAt: new Date(Date.now() + 60_000).toISOString() };
    f.receipt = { ...futurePayload, proofDigest: issueCompletionDigest(futurePayload) };
    await persistCandidate(f);

    // A valid persisted candidate and an otherwise positive external verifier
    // must not make future-dated completion visible at this public readback.
    const verifier = vi.fn(async () => true);
    const response = await app(f.seed, verifier).request(f.path);
    expect(response.status).toBe(409);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('restricted source-only ingress is insert-once, audited, collision-safe and has no HTTP POST', async () => {
    const f = await fixture();
    const denied = await f.seed.workItems.acceptIssueCompletionEvidenceCandidate({
      orgId: ORG, factoryProjectId: f.project.id, receipt: f.receipt,
      verify: async () => false,
    });
    expect(denied.status).toBe('unverified');
    expect((await app(f.seed).request(f.path)).status).toBe(404);
    await persistCandidate(f);
    const replay = await f.seed.workItems.acceptIssueCompletionEvidenceCandidate({
      orgId: ORG, factoryProjectId: f.project.id, receipt: f.receipt,
      verify: async () => true,
    });
    expect(replay.status).toBe('replayed');
    const rows = await f.seed.storage.ops.findMany('factory_issue_completion_evidence', {
      org_id: ORG, factory_project_id: f.project.id, work_item_id: f.item.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issuer_id: 'modelspend-reviewer',
      proof_digest: f.receipt.proofDigest });
    expect((await app(f.seed).request(f.path, { method: 'POST' })).status).toBe(404);
  });

  it('fences item revision drift during external verification before immutable DB insert', async () => {
    const f = await fixture();
    const result = await f.seed.workItems.acceptIssueCompletionEvidenceCandidate({
      orgId: ORG, factoryProjectId: f.project.id, receipt: f.receipt,
      verify: async () => {
        await f.seed.storage.ops.updateMany('work_items', { id: f.item.id },
          { revision: f.item.revision + 1 });
        return true;
      },
    });
    expect(result.status).toBe('conflict');
    expect((await app(f.seed).request(f.path)).status).toBe(404);
  });

  it('rejects checksum tampering, stale source revision, divergent CI head and native effect mismatch before verifier', async () => {
    const f = await fixture();
    await persistCandidate(f);
    const verifier = vi.fn(async () => true);
    for (const bad of [
      { proof: { ...f.receipt, sourceRepository: 'attacker/other' } },
      { work_item_revision: f.item.revision + 1 },
      { proof: { ...f.receipt, ciHeadSha: 'c'.repeat(40) } },
      { proof: { ...f.receipt, nativeEffectId: '88888888-8888-4888-8888-888888888888' } },
    ]) {
      await f.seed.storage.ops.updateMany('factory_issue_completion_evidence', { work_item_id: f.item.id }, {
        proof: f.receipt, work_item_revision: f.item.revision, ...bad,
      });
      expect((await app(f.seed, verifier).request(f.path)).status).toBe(409);
    }
    expect(verifier).not.toHaveBeenCalled();
  });
});
