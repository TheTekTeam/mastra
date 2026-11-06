/**
 * Live read-only GitHub App corroboration for a *candidate* durable Factory
 * final-issue receipt. No private-key fallback, API mutation or public write.
 * An absent/revoked installation credential, ambiguous pagination or failed
 * GitHub API call returns false and causes the scoped GET to fail closed.
 *
 * Source version and snapshot ID are native Factory/MCP observations, NOT
 * GitHub issue.updated_at; the Project Manager independently pins both.
 */
import type { GithubIntegration } from '../integrations/github/integration.js';
import type { SourceControlStorageHandle } from '../storage/domains/source-control/base.js';
import type { IssueCompletionReceipt } from '../storage/domains/work-items/completion-evidence.js';

type GithubClient = Pick<GithubIntegration, 'getInstallationOctokit'>;

export interface IssueCompletionVerifyScope {
  orgId: string;
  factoryProjectId: string;
  repositoryId: string;
}

interface GraphEvidence {
  repository?: {
    pullRequest?: {
      closingIssuesReferences?: {
        nodes?: Array<{ number?: number } | null>;
        pageInfo?: { hasNextPage?: boolean };
      };
      reviewThreads?: {
        nodes?: Array<{ isResolved?: boolean } | null>;
        pageInfo?: { hasNextPage?: boolean };
      };
    } | null;
  } | null;
}

function latestReviewNotBlocked(reviews: Array<{
  user?: { login?: string } | null;
  state: string;
  commit_id?: string | null;
  submitted_at?: string | null;
}>, head: string): boolean {
  const latest = new Map<string, { state: string; commit_id?: string | null; submitted_at?: string | null }>();
  const sorted = [...reviews].sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));
  for (const review of sorted) {
    const login = review.user?.login?.toLowerCase();
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    latest.set(login, review);
  }
  const hp6 = latest.get('modelspend-reviewer');
  if (!hp6 || hp6.state !== 'APPROVED' || hp6.commit_id !== head) return false;
  return [...latest.values()].every(review => review.state !== 'CHANGES_REQUESTED');
}

function latestCiChecksPassed(checks: Array<{
  name: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  completed_at?: string | null;
}> , head: string): boolean {
  const latest = new Map<string, (typeof checks)[number]>();
  for (const check of checks) {
    if (check.head_sha !== head) return false;
    const key = check.name.trim().toLowerCase().replaceAll(' ', '');
    const before = latest.get(key);
    if (!before || (before.completed_at ?? '') <= (check.completed_at ?? '')) latest.set(key, check);
  }
  const required = ['node22', 'ci/exact-head'];
  return required.every(key => {
    const check = latest.get(key);
    return check?.status === 'completed' && check.conclusion === 'success';
  });
}

/**
 * Verify a stored candidate through the actual tenant's installed GitHub App
 * (not a user token, untrusted webhook payload or caller-supplied pass flag).
 */
export function createIssueCompletionGithubVerifier(
  github: GithubClient,
  sourceControl: SourceControlStorageHandle,
): (receipt: IssueCompletionReceipt, scope: IssueCompletionVerifyScope) => Promise<boolean> {
  return async (receipt, scope) => {
    try {
      if (!scope.repositoryId || !receipt.sourceRepository.includes('/')) return false;
      const repository = await sourceControl.repositories.get({
        orgId: scope.orgId, id: scope.repositoryId,
      });
      if (!repository || repository.slug.toLowerCase() !== receipt.sourceRepository.toLowerCase()) return false;
      const linked = await sourceControl.projectRepositories.listByProject({
        orgId: scope.orgId, factoryProjectId: scope.factoryProjectId,
      });
      if (!linked.some(link => link.repositoryId === repository.id)) return false;
      const installation = await sourceControl.installations.get({
        orgId: scope.orgId, id: repository.installationId,
      });
      if (!installation || installation.integrationId !== 'github') return false;
      const installationId = Number(installation.externalId);
      if (!Number.isSafeInteger(installationId) || installationId < 1) return false;
      const octokit = github.getInstallationOctokit(installationId);
      const [owner, repo] = receipt.sourceRepository.split('/');
      if (!owner || !repo) return false;

      const [issueResult, prResult, reviewsResult, checksResult, graph] = await Promise.all([
        octokit.issues.get({ owner, repo, issue_number: receipt.sourceIssueNumber }),
        octokit.pulls.get({ owner, repo, pull_number: receipt.pullRequestNumber }),
        octokit.pulls.listReviews({ owner, repo, pull_number: receipt.pullRequestNumber, per_page: 100 }),
        octokit.checks.listForRef({ owner, repo, ref: receipt.headSha, per_page: 100 }),
        octokit.graphql<GraphEvidence>(`
          query NativeIssueCompletion($owner:String!,$repo:String!,$number:Int!) {
            repository(owner:$owner,name:$repo) {
              pullRequest(number:$number) {
                closingIssuesReferences(first:100) {
                  nodes { number }
                  pageInfo { hasNextPage }
                }
                reviewThreads(first:100) {
                  nodes { isResolved }
                  pageInfo { hasNextPage }
                }
              }
            }
          }
        `, { owner, repo, number: receipt.pullRequestNumber }),
      ]);

      const issue = issueResult.data;
      const pr = prResult.data;
      if (issue.number !== receipt.sourceIssueNumber || issue.state !== 'closed' ||
          issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate' ||
          pr.number !== receipt.pullRequestNumber || pr.state !== 'closed' ||
          pr.merged !== true || !pr.merged_at || pr.head.sha !== receipt.headSha ||
          pr.merge_commit_sha !== receipt.mergeSha ||
          pr.base.repo?.full_name.toLowerCase() !== receipt.sourceRepository.toLowerCase()) return false;

      const reviews = reviewsResult.data;
      if (reviews.length >= 100 || !latestReviewNotBlocked(reviews, receipt.headSha)) return false;
      const checks = checksResult.data;
      if (checks.total_count > checks.check_runs.length || checks.check_runs.length >= 100 ||
          !latestCiChecksPassed(checks.check_runs, receipt.headSha)) return false;

      const linkedIssue = graph.repository?.pullRequest?.closingIssuesReferences;
      const threads = graph.repository?.pullRequest?.reviewThreads;
      if (!linkedIssue || !threads ||
          linkedIssue.pageInfo?.hasNextPage !== false ||
          threads.pageInfo?.hasNextPage !== false ||
          !linkedIssue.nodes?.some(node => node?.number === receipt.sourceIssueNumber) ||
          threads.nodes?.some(node => node?.isResolved !== true)) return false;
      return true;
    } catch {
      // The API and auth provider failure class must not leak installation IDs
      // or raw GitHub response bodies through the operator-facing GET route.
      return false;
    }
  };
}
