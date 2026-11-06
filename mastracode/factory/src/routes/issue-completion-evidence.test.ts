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
type Verify = (receipt: IssueCompletionReceipt, scope: { orgId: string; factoryProjectId: string }) => Promise<boolean>;

function app(seed: FactoryStorageTestSeed, verify?: Verify, user: typeof USER | null = USER, noAdmin = false) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  const auth = fakeRouteAuth(noAdmin ? { isOrganizationAdmin: async () => false } : {});
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
      externalSource: { integrationId: 'github', type: 'issue', externalId: '42' },
      metadata: { githubIssueNumber: 42, githubRepositoryId: 123, repository: 'TheTekTeam/HTAI' },
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
    sourceVersion: 'issue-state-2026-11-06', sourceSnapshotId: 'htai-issue-42-snapshot',
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
  await seed.storage.ops.insertOne('factory_issue_completion_evidence', {
    id: '99999999-9999-4999-8999-999999999999',
    org_id: ORG, factory_project_id: project.id, work_item_id: item.id,
    work_item_revision: item.revision,
    proof: receipt, proof_digest: receipt.proofDigest, created_at: new Date(),
  });
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
    expect((await app(f.seed, undefined, null).request(f.path)).status).toBe(401);
    expect((await app(f.seed, undefined, { workosId: 'other', organizationId: 'other' }).request(f.path)).status).toBe(404);
    expect((await app(f.seed, undefined, { workosId: 'other' }).request(f.path)).status).toBe(403);
    expect((await app(f.seed, undefined, USER, true).request(f.path)).status).toBe(409);
    expect((await app(f.seed).request(f.path)).status).toBe(409);
    expect((await app(f.seed).request(f.path.replace(f.item.id, 'bogus'))).status).toBe(404);
  });

  it('only accepts exact stored receipt after a separate independent verifier positively attests', async () => {
    const f = await fixture();
    await persistCandidate(f);
    expect((await app(f.seed, async () => false).request(f.path)).status).toBe(409);
    expect((await app(f.seed, async () => { throw new Error('upstream failed'); }).request(f.path)).status).toBe(409);
    const verifier = vi.fn(async (candidate: IssueCompletionReceipt, scope: { orgId: string; factoryProjectId: string }) => {
      expect(candidate).toEqual(f.receipt);
      expect(scope).toEqual({ orgId: ORG, factoryProjectId: f.project.id });
      return true;
    });
    const response = await app(f.seed, verifier).request(f.path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(f.receipt);
    expect(verifier).toHaveBeenCalledTimes(1);
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
