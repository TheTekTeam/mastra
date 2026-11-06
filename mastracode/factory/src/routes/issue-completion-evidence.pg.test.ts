import { PgFactoryStorage } from '@mastra/pg';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { AuditStorage } from '../storage/domains/audit/base.js';
import { AuditDomain } from '../storage/domains/audit/domain.js';
import { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import { WorkItemsStorage } from '../storage/domains/work-items/base.js';
import { issueCompletionDigest } from '../storage/domains/work-items/completion-evidence.js';
import type { IssueCompletionPayload } from '../storage/domains/work-items/completion-evidence.js';
import { AutomationRunRoutes } from './automation-runs.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const database = process.env.FACTORY_TEST_POSTGRES_URL;
const ORG = 'pg-issue-completion-qa';
const USER = { workosId: 'pg-reviewer', organizationId: ORG };

async function pgStorage(id: string) {
  const storage = new PgFactoryStorage({ id, connectionString: database! });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const workItems = storage.registerDomain(new WorkItemsStorage());
  const audit = storage.registerDomain(new AuditStorage());
  workItems.useTerminalPhasePredicate(item => item.stages.includes('intake'));
  await storage.init();
  return { storage, projects, workItems, audit };
}

function app(seed: Awaited<ReturnType<typeof pgStorage>>) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, USER as never);
    await next();
  });
  const auth = fakeRouteAuth();
  mountApiRoutes(hono as any, new AutomationRunRoutes({
    auth,
    audit: new AuditDomain({ auth, audit: seed.audit, projects: seed.projects }),
    projects: seed.projects, workItems: seed.workItems, configVersion: 'pg-native-proof',
    verifyIssueCompletionEvidence: async () => true,
  }).routes());
  return hono;
}

describe.skipIf(!database)('native final-issue receipt across disposable PG18 clients', () => {
  it('persists one independently verified/issuer-audited receipt; cross-client read, replay and drift fail closed', async () => {
    const first = await pgStorage('issue-proof-first');
    let second: Awaited<ReturnType<typeof pgStorage>> | undefined;
    try {
      const project = await first.projects.create({
        orgId: ORG, userId: USER.workosId, input: { name: 'PG18 completion proof only' },
      });
      const { item } = await first.workItems.upsert({
        orgId: ORG, userId: USER.workosId, factoryProjectId: project.id,
        input: {
          title: 'GitHub issue 42 QA', stages: ['intake'],
          externalSource: { integrationId: 'github', type: 'issue', externalId: 'github-issue:42' },
          metadata: { githubIssueNumber: 42,
            githubRepositoryId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repository: 'TheTekTeam/HTAI' },
        },
      });
      const runRequestId = '11111111-1111-4111-8111-111111111111';
      const enqueued = await app(first).request(
        `/web/factory/projects/${project.id}/work-items/${item.id}/automation-runs`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: runRequestId,
            expectedRevision: item.revision, role: 'work', skillName: 'factory-plan' }) },
      );
      expect(enqueued.status).toBe(202);
      const effects = await first.workItems.listDeferredDecisions(ORG, project.id);
      expect(effects).toHaveLength(1);
      const effect = effects[0]!;
      await first.storage.ops.updateMany('factory_deferred_decisions', { id: effect.id },
        { status: 'succeeded', completed_at: new Date() });
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
      expect((await first.workItems.acceptIssueCompletionEvidenceCandidate({
        orgId: ORG, factoryProjectId: project.id, receipt, verify: async () => true,
      })).status).toBe('committed');
      second = await pgStorage('issue-proof-second');
      const path = `/web/factory/projects/${project.id}/issue-completion-evidence/${item.id}`;
      const native = await app(second).request(path);
      expect(native.status).toBe(200);
      expect(await native.json()).toEqual(receipt);
      expect((await second.workItems.acceptIssueCompletionEvidenceCandidate({
        orgId: ORG, factoryProjectId: project.id, receipt, verify: async () => true,
      })).status).toBe('replayed');
      const persisted = await second.storage.ops.findOne('factory_issue_completion_evidence', {
        org_id: ORG, factory_project_id: project.id, work_item_id: item.id,
      });
      expect(persisted).toMatchObject({ issuer_id: 'modelspend-reviewer',
        proof_digest: receipt.proofDigest });
      await second.storage.ops.updateMany('work_items', { id: item.id },
        { revision: item.revision + 1 });
      expect((await app(second).request(path)).status).toBe(409);
    } finally {
      if (second) await second.storage.close();
      await first.storage.close();
    }
  });
});
