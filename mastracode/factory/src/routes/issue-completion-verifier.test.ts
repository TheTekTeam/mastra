import { describe, expect, it } from 'vitest';
import type { GithubIntegration } from '../integrations/github/integration.js';
import type { SourceControlStorageHandle } from '../storage/domains/source-control/base.js';
import type { IssueCompletionReceipt } from '../storage/domains/work-items/completion-evidence.js';
import { createIssueCompletionGithubVerifier } from './issue-completion-verifier.js';

const ORG = 'org1';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_ID = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_ID = '33333333-3333-4333-8333-333333333333';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const receipt = {
  projectId: PROJECT, sourceRepository: 'TheTekTeam/HTAI',
  sourceIssueNumber: 42, pullRequestNumber: 67,
  headSha: HEAD, mergeSha: MERGE,
} as IssueCompletionReceipt;
const scope = { orgId: ORG, factoryProjectId: PROJECT, repositoryId: REPOSITORY_ID };

function fixture() {
  const state = {
    repository: { id: REPOSITORY_ID, slug: 'TheTekTeam/HTAI', installationId: INSTALLATION_ID },
    links: [{ repositoryId: REPOSITORY_ID }],
    installation: { integrationId: 'github', externalId: '12345' },
    issue: { number: 42, state: 'closed', state_reason: 'completed' },
    pr: { number: 67, state: 'closed', merged: true, merged_at: '2026-11-06T10:00:00Z',
      head: { sha: HEAD }, merge_commit_sha: MERGE, base: { repo: { full_name: 'TheTekTeam/HTAI' } } },
    reviews: [{ user: { login: 'modelspend-reviewer' }, state: 'APPROVED', commit_id: HEAD,
      submitted_at: '2026-11-06T10:10:00Z' }],
    checks: { total_count: 2, check_runs: [
      { name: 'Node 22', head_sha: HEAD, status: 'completed', conclusion: 'success', completed_at: '2026-11-06T10:00:00Z' },
      { name: 'ci/exact-head', head_sha: HEAD, status: 'completed', conclusion: 'success', completed_at: '2026-11-06T10:00:00Z' },
    ] },
    graph: { repository: { pullRequest: {
      closingIssuesReferences: { nodes: [{ number: 42 }], pageInfo: { hasNextPage: false } },
      reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } },
    } } },
    calls: [] as string[],
  };
  const sourceControl = {
    repositories: { get: async (input: unknown) => { state.calls.push('repo'); return state.repository; } },
    projectRepositories: { listByProject: async () => { state.calls.push('links'); return state.links; } },
    installations: { get: async () => { state.calls.push('install'); return state.installation; } },
  } as unknown as SourceControlStorageHandle;
  const github = {
    getInstallationOctokit: (id: number) => {
      state.calls.push('app-installation-' + id);
      return {
        issues: { get: async () => ({ data: state.issue }) },
        pulls: {
          get: async () => ({ data: state.pr }),
          listReviews: async () => ({ data: state.reviews }),
        },
        checks: { listForRef: async () => ({ data: state.checks }) },
        graphql: async () => state.graph,
      };
    },
  } as unknown as GithubIntegration;
  return { state, verify: createIssueCompletionGithubVerifier(github, sourceControl) };
}

describe('independent GitHub App-only final issue verifier', () => {
  it('requires exact org-owned linked repo, closed issue, merged PR, HP6 approval, latest CI and closed thread', async () => {
    const { state, verify } = fixture();
    expect(await verify(receipt, scope)).toBe(true);
    expect(state.calls).toEqual(['repo', 'links', 'install', 'app-installation-12345']);
  });

  it('rejects unlinked/cross-org repository, invalid app installation and absent credential', async () => {
    for (const mutate of [
      (s: ReturnType<typeof fixture>['state']) => { s.repository = null as any; },
      (s: ReturnType<typeof fixture>['state']) => { s.repository.slug = 'attacker/other'; },
      (s: ReturnType<typeof fixture>['state']) => { s.links = []; },
      (s: ReturnType<typeof fixture>['state']) => { s.installation.externalId = 'invalid'; },
      (s: ReturnType<typeof fixture>['state']) => { s.installation.integrationId = 'other'; },
    ]) {
      const f = fixture();
      mutate(f.state);
      expect(await f.verify(receipt, scope)).toBe(false);
    }
  });

  it('rejects status-only done, PR/issue mismatch, missing linked issue, unresolved review and pagination', async () => {
    for (const mutate of [
      (s: ReturnType<typeof fixture>['state']) => { s.issue.state = 'open'; },
      (s: ReturnType<typeof fixture>['state']) => { s.issue.state_reason = 'not_planned'; },
      (s: ReturnType<typeof fixture>['state']) => { s.pr.merged = false; },
      (s: ReturnType<typeof fixture>['state']) => { s.pr.head.sha = 'c'.repeat(40); },
      (s: ReturnType<typeof fixture>['state']) => { s.pr.merge_commit_sha = 'c'.repeat(40); },
      (s: ReturnType<typeof fixture>['state']) => { s.graph.repository.pullRequest.closingIssuesReferences.nodes = [{ number: 99 }]; },
      (s: ReturnType<typeof fixture>['state']) => { s.graph.repository.pullRequest.reviewThreads.nodes = [{ isResolved: false }]; },
      (s: ReturnType<typeof fixture>['state']) => { s.graph.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true; },
    ]) {
      const f = fixture();
      mutate(f.state);
      expect(await f.verify(receipt, scope)).toBe(false);
    }
  });

  it('rejects stale HP6 head, later changes requested, unreviewed PR and latest failed exact CI', async () => {
    for (const mutate of [
      (s: ReturnType<typeof fixture>['state']) => { s.reviews[0]!.commit_id = 'c'.repeat(40); },
      (s: ReturnType<typeof fixture>['state']) => { s.reviews[0]!.state = 'CHANGES_REQUESTED'; },
      (s: ReturnType<typeof fixture>['state']) => { s.reviews.push({
        user: { login: 'other-reviewer' }, state: 'CHANGES_REQUESTED', commit_id: HEAD, submitted_at: '2026-11-06T11:00:00Z'
      }); },
      (s: ReturnType<typeof fixture>['state']) => { s.checks.check_runs[1]!.conclusion = 'failure'; },
      (s: ReturnType<typeof fixture>['state']) => { s.checks.check_runs[1]!.head_sha = 'c'.repeat(40); },
      (s: ReturnType<typeof fixture>['state']) => { s.checks.total_count = 3; },
    ]) {
      const f = fixture();
      mutate(f.state);
      expect(await f.verify(receipt, scope)).toBe(false);
    }
  });
});
