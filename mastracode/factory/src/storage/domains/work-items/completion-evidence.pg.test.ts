import { randomUUID } from 'node:crypto';

import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.js';
import { WorkItemsStorage } from './base.js';
import { issueCompletionDigest } from './completion-evidence.js';
import type { IssueCompletionPayload } from './completion-evidence.js';

/**
 * CI supplies ONLY its disposable PostgreSQL 18 instance. No default/local/live
 * database is ever inferred. Separate clients test the durable storage boundary;
 * the future independent verifier is intentionally represented by a fixture.
 */
const testPgUrl = process.env.FACTORY_COMPLETION_PG_TEST_URL;

async function openClient() {
  const storage = new PgFactoryStorage({
    id: 'factory-completion-storage-' + randomUUID(), connectionString: testPgUrl!,
  });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const workItems = storage.registerDomain(new WorkItemsStorage());
  workItems.useTerminalPhasePredicate(item => item.stages.includes('intake'));
  await storage.init();
  return { storage, projects, workItems };
}

describe.skipIf(!testPgUrl)('native issue completion PG18 immutable cross-client storage', () => {
  it('fails without verifier, persists one issuer receipt, replays exactly, rejects drift and cross-tenant reads', async () => {
    const first = await openClient();
    let second: Awaited<ReturnType<typeof openClient>> | undefined;
    try {
      const orgId = 'completion-storage-qa-' + randomUUID();
      const project = await first.projects.create({
        orgId, userId: 'fixture-attestor', input: { name: 'PG18 completion storage verification' },
      });
      const { item } = await first.workItems.upsert({
        orgId, userId: 'fixture-attestor', factoryProjectId: project.id,
        input: {
          title: 'GitHub issue 42 storage QA', stages: ['intake'],
          externalSource: { integrationId: 'github', type: 'issue', externalId: 'github-issue:42' },
          metadata: {
            githubIssueNumber: 42,
            githubRepositoryId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            repository: 'TheTekTeam/HTAI',
          },
        },
      });
      const effectId = randomUUID();
      const now = new Date();
      await first.storage.ops.insertOne('factory_deferred_decisions', {
        id: effectId, org_id: orgId, factory_project_id: project.id,
        evaluation_id: 'fixture-evaluation', work_item_id: item.id, source_key: null,
        idempotency_key: 'fixture-' + effectId, effect_ordinal: 0,
        effect_hash: 'fixture-hash', causal_chain: [], actor: null,
        decision: { type: 'fixture-completed' }, status: 'succeeded',
        attempts: 1, available_at: now, completed_at: now,
        created_at: now, updated_at: now,
      });
      const payload: IssueCompletionPayload = {
        ok: true, source: 'independent_native_issue_completion_readback',
        kind: 'issue_completion', schemaVersion: 1,
        projectId: project.id, workItemId: item.id, workItemRevision: item.revision,
        sourceRepository: 'TheTekTeam/HTAI', sourceIssueNumber: 42,
        sourceVersion: 'factory_0_25_issue_v1', sourceSnapshotId: 'd'.repeat(64),
        pullRequestNumber: 67, headSha: 'a'.repeat(40),
        reviewerIdentity: 'modelspend-reviewer', reviewHeadSha: 'a'.repeat(40),
        ciHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
        nativeEffectId: effectId, acceptedAt: now.toISOString(),
        finalEffectState: 'completed', executionVerified: true,
        independentNativeCompletion: true,
      };
      const receipt = { ...payload, proofDigest: issueCompletionDigest(payload) };
      const scope = { orgId, factoryProjectId: project.id, receipt };

      expect(await first.workItems.acceptIssueCompletionEvidenceCandidate({
        ...scope, verify: async () => false,
      })).toEqual({ status: 'unverified' });
      expect(await first.workItems.getIssueCompletionEvidence(orgId, project.id, item.id))
        .toEqual({ kind: 'missing' });

      expect(await first.workItems.acceptIssueCompletionEvidenceCandidate({
        ...scope, verify: async (_receipt, identity) =>
          identity.orgId === orgId &&
          identity.factoryProjectId === project.id &&
          identity.repositoryId === 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })).toEqual({ status: 'committed' });

      second = await openClient();
      expect(await second.workItems.getIssueCompletionEvidence(orgId, project.id, item.id))
        .toEqual({ kind: 'found', receipt, repositoryId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      expect(await second.workItems.acceptIssueCompletionEvidenceCandidate({
        ...scope, verify: async () => true,
      })).toEqual({ status: 'replayed' });
      const otherPayload = { ...payload, mergeSha: 'c'.repeat(40) };
      expect(await second.workItems.acceptIssueCompletionEvidenceCandidate({
        ...scope, receipt: { ...otherPayload, proofDigest: issueCompletionDigest(otherPayload) },
        verify: async () => true,
      })).toEqual({ status: 'conflict' });
      expect(await second.storage.ops.findMany('factory_issue_completion_evidence', {
        org_id: orgId, factory_project_id: project.id, work_item_id: item.id,
      })).toHaveLength(1);
      expect(await second.workItems.getIssueCompletionEvidence('other-tenant', project.id, item.id))
        .toEqual({ kind: 'missing' });

      await second.storage.ops.updateMany('work_items', { id: item.id }, {
        revision: item.revision + 1,
      });
      expect(await first.workItems.getIssueCompletionEvidence(orgId, project.id, item.id))
        .toEqual({ kind: 'ambiguous' });
      expect(await second.workItems.acceptIssueCompletionEvidenceCandidate({
        ...scope, verify: async () => true,
      })).toEqual({ status: 'conflict' });
    } finally {
      await second?.storage.close();
      await first.storage.close();
    }
  });
  it('accepts only exact persisted legacy GitHub issue readbacks, never new candidates', async () => {
    const first = await openClient();
    try {
      const orgId = 'legacy-qa-' + randomUUID();
      const repositoryId = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const repository = 'TheTekTeam/HTAI';
      const project = await first.projects.create({
        orgId, userId: 'fixture-attestor', input: { name: 'Legacy readback QA' },
      });
      const { item } = await first.workItems.upsert({
        orgId, userId: 'fixture-attestor', factoryProjectId: project.id,
        input: {
          title: 'Legacy GitHub issue 42', stages: ['intake'],
          externalSource: { integrationId: 'github', type: 'github_issue', externalId: '42' },
          metadata: { githubIssueNumber: 42, githubRepositoryId: repositoryId, repository },
        },
      });
      const effectId = randomUUID();
      const now = new Date();
      const payload: IssueCompletionPayload = {
        ok: true, source: 'independent_native_issue_completion_readback',
        kind: 'issue_completion', schemaVersion: 1,
        projectId: project.id, workItemId: item.id, workItemRevision: item.revision,
        sourceRepository: repository, sourceIssueNumber: 42,
        sourceVersion: 'legacy_github_issue_v1', sourceSnapshotId: 'd'.repeat(64),
        pullRequestNumber: 67, headSha: 'a'.repeat(40),
        reviewerIdentity: 'modelspend-reviewer', reviewHeadSha: 'a'.repeat(40),
        ciHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
        nativeEffectId: effectId, acceptedAt: now.toISOString(),
        finalEffectState: 'completed', executionVerified: true,
        independentNativeCompletion: true,
      };
      const receipt = { ...payload, proofDigest: issueCompletionDigest(payload) };
      await first.storage.ops.insertOne('factory_deferred_decisions', {
        id: effectId, org_id: orgId, factory_project_id: project.id,
        evaluation_id: 'fixture-evaluation', work_item_id: item.id, source_key: null,
        idempotency_key: 'fixture-' + effectId, effect_ordinal: 0,
        effect_hash: 'fixture-hash', causal_chain: [], actor: null,
        decision: { type: 'fixture-completed' }, status: 'succeeded',
        attempts: 1, available_at: now, completed_at: now,
        created_at: now, updated_at: now,
      });
      expect(await first.workItems.acceptIssueCompletionEvidenceCandidate({
        orgId, factoryProjectId: project.id, receipt, verify: async () => true,
      })).toEqual({ status: 'conflict' });
      expect(await first.workItems.getIssueCompletionEvidence(orgId, project.id, item.id))
        .toEqual({ kind: 'missing' });

      // Historical persistence fixture, not a live legacy proof admission route.
      await first.storage.ops.insertOne('factory_issue_completion_evidence', {
        id: randomUUID(), org_id: orgId, factory_project_id: project.id,
        work_item_id: item.id, work_item_revision: item.revision,
        proof: receipt, proof_digest: receipt.proofDigest,
        issuer_id: 'modelspend-reviewer', independently_verified_at: now, created_at: now,
      });
      const found = { kind: 'found', receipt, repositoryId };
      const lookup = () => first.workItems.getIssueCompletionEvidence(orgId, project.id, item.id);
      const change = (type: string, externalId: string, integrationId = 'github', name?: string) =>
        first.storage.ops.updateMany('work_items', { org_id: orgId, id: item.id }, {
          external_source: { integrationId, type, externalId },
          metadata: {
            githubIssueNumber: 42, githubRepositoryId: repositoryId,
            ...(name !== undefined ? { repository: name } : {}),
          },
        });
      expect(await lookup()).toEqual(found);
      await change('github', '42', 'github', repository);
      expect(await lookup()).toEqual(found);
      await change('issue', 'github-issue:42', 'github', repository);
      expect(await lookup()).toEqual({ kind: 'ambiguous' });
      await change('github', 'github-issue:42', 'github', repository);
      expect(await lookup()).toEqual({ kind: 'ambiguous' });
      await change('github_issue', '43', 'github', repository);
      expect(await lookup()).toEqual({ kind: 'ambiguous' });
      await change('github_issue', '42', 'gitlab', repository);
      expect(await lookup()).toEqual({ kind: 'ambiguous' });
      await change('github_issue', '42', 'github', 'TheTekTeam/Other');
      expect(await lookup()).toEqual({ kind: 'ambiguous' });
      await change('github_issue', '42');
      expect(await lookup()).toEqual({ kind: 'ambiguous' });
      expect(await first.workItems.getIssueCompletionEvidence('other-tenant', project.id, item.id))
        .toEqual({ kind: 'missing' });
      expect(await first.workItems.getIssueCompletionEvidence(orgId, randomUUID(), item.id))
        .toEqual({ kind: 'missing' });
    } finally {
      await first.storage.close();
    }
  });
});
