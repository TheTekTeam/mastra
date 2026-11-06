/**
 * Read-only, project-scoped corroboration using the Factory's already installed
 * tenant GitHub App. This is NOT a completion receipt, independent HP6 approval,
 * a service grant, or permission to mutate Factory/GitHub.
 *
 * It never returns tokens, PEMs, connection configuration or arbitrary repo data.
 * The caller supplies exact GitHub expectations, while the server selects the
 * installation exclusively from the signed-in tenant's project link.
 */
import { createHash } from 'node:crypto';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type { GithubIntegration } from '../integrations/github/integration.js';
import type { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import type { SourceControlStorageHandle } from '../storage/domains/source-control/base.js';
import type { RouteAuth } from './route.js';
import { FACTORY_ROUTE_CONTRACTS } from './contracts.js';

const path = FACTORY_ROUTE_CONTRACTS.projectAppEvidenceGet.path;
const ttlMs = 90_000;
const maxEvidence = 100;

type AppClient = Pick<GithubIntegration, 'getAppOctokit' | 'getInstallationOctokit'>;
type Scope = { orgId: string; projectId: string; expectedRepository: string; expectedAutomationRevision: number };
interface Options {
  auth: RouteAuth;
  projects: FactoryProjectsStorage;
  sourceControl: SourceControlStorageHandle;
  github: AppClient;
}
interface Binding {
  factoryOrgId: string;
  projectId: string;
  projectRepositoryLinkId: string;
  connectionId: string;
  repositoryRecordId: string;
  repositoryFullName: string;
  repositoryNumericId: number;
  installationRecordId: string;
  installationId: number;
  projectAutomationRevision: number;
  bindingDigest: string;
}
interface Graph {
  repository?: {
    pullRequest?: {
      closingIssuesReferences?: {
        nodes?: Array<{ number?: number; repository?: { databaseId?: number } | null } | null>;
        pageInfo?: { hasNextPage?: boolean };
      };
      reviewThreads?: {
        nodes?: Array<{ isResolved?: boolean } | null>;
        pageInfo?: { hasNextPage?: boolean };
      };
    } | null;
  } | null;
}

function digest(fields: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)))))
    .digest('hex');
}
function timestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function binding(options: Options, scope: Scope): Promise<Binding | null> {
  const project = await options.projects.get({ orgId: scope.orgId, id: scope.projectId });
  if (!project || !Number.isSafeInteger(project.automationRevision) ||
      project.automationRevision !== scope.expectedAutomationRevision) return null;

  const links = await options.sourceControl.projectRepositories.listByProject({
    orgId: scope.orgId, factoryProjectId: scope.projectId,
  });
  const matches = [];
  for (const link of links) {
    const connection = await options.sourceControl.connections.get({
      orgId: scope.orgId, id: link.connectionId,
    });
    if (!connection || connection.factoryProjectId !== scope.projectId ||
        connection.integrationId !== 'github') continue;
    const repository = await options.sourceControl.repositories.get({
      orgId: scope.orgId, id: link.repositoryId,
    });
    if (!repository || repository.installationId !== connection.installationId ||
        repository.slug.toLowerCase() !== scope.expectedRepository.toLowerCase()) continue;
    const installation = await options.sourceControl.installations.get({
      orgId: scope.orgId, id: repository.installationId,
    });
    if (!installation || installation.integrationId !== 'github' ||
        installation.id !== connection.installationId) continue;
    const installationId = Number(installation.externalId);
    const repositoryNumericId = Number(repository.externalId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0 ||
        !Number.isSafeInteger(repositoryNumericId) || repositoryNumericId <= 0) continue;
    matches.push({
      factoryOrgId: scope.orgId,
      projectId: scope.projectId,
      projectRepositoryLinkId: link.id,
      connectionId: connection.id,
      repositoryRecordId: repository.id,
      repositoryFullName: repository.slug,
      repositoryNumericId,
      installationRecordId: installation.id,
      installationId,
      projectAutomationRevision: project.automationRevision,
    });
  }
  if (matches.length !== 1) return null;
  const selected = matches[0]!;
  return { ...selected, bindingDigest: digest(selected) };
}

function expected(c: Context) {
  const contract = FACTORY_ROUTE_CONTRACTS.projectAppEvidenceGet;
  const pathInput = contract.pathSchema.safeParse({ id: c.req.param('id') });
  const queryInput = contract.querySchema.safeParse(c.req.query());
  if (!pathInput.success || !queryInput.success) return null;
  return {
    projectId: pathInput.data.id.toLowerCase(),
    expectedRepository: queryInput.data.repository,
    issueNumber: queryInput.data.issueNumber,
    pullRequestNumber: queryInput.data.pullRequestNumber,
    expectedAutomationRevision: queryInput.data.expectedAutomationRevision,
    expectedHeadSha: queryInput.data.expectedHeadSha,
    expectedMergeSha: queryInput.data.expectedMergeSha,
  };
}

export function buildProjectAppEvidenceRoutes(options: Options): ApiRoute[] {
  return [registerApiRoute(path, {
    method: 'GET',
    requiresAuth: false,
    handler: async raw => {
      const c = raw as Context;
      // No-auth local Factory is NOT an acceptable final evidence issuer.
      if (!options.auth.enabled()) return c.json({ error: 'operator_signin_required' }, 401);
      await options.auth.ensureUser(c);
      const tenant = options.auth.tenant(c);
      if (!tenant?.orgId) return c.json({ error: 'unauthorized' }, 401);
      const args = expected(c);
      if (!args) return c.json({ error: 'invalid_project_app_evidence_request' }, 400);
      // Only an org administrator can inspect installation binding metadata.
      if (!(await options.auth.isOrganizationAdmin(c, tenant.orgId)))
        return c.json({ error: 'forbidden' }, 403);
      const scope: Scope = {
        orgId: tenant.orgId,
        projectId: args.projectId,
        expectedRepository: args.expectedRepository,
        expectedAutomationRevision: args.expectedAutomationRevision,
      };
      try {
        const before = await binding(options, scope);
        if (!before) return c.json({ error: 'app_source_unavailable' }, 409);
        const [owner, repo] = before.repositoryFullName.split('/');
        if (!owner || !repo) return c.json({ error: 'app_source_unavailable' }, 409);
        const app = options.github.getAppOctokit();
        const octokit = options.github.getInstallationOctokit(before.installationId);

        const [appResult, repoResult, issueResult, prResult, reviewsResult, checksResult, graph] =
          await Promise.all([
            app.apps.getAuthenticated(),
            octokit.repos.get({ owner, repo }),
            octokit.issues.get({ owner, repo, issue_number: args.issueNumber }),
            octokit.pulls.get({ owner, repo, pull_number: args.pullRequestNumber }),
            octokit.pulls.listReviews({ owner, repo, pull_number: args.pullRequestNumber, per_page: maxEvidence }),
            octokit.checks.listForRef({ owner, repo, ref: args.expectedHeadSha, per_page: maxEvidence }),
            octokit.graphql<Graph>(
              'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{databaseId}}pageInfo{hasNextPage}}reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}',
              { owner, repo, number: args.pullRequestNumber },
            ),
          ]);

        const liveRepo = repoResult.data;
        const issue = issueResult.data;
        const pr = prResult.data;
        const appSlug = appResult.data?.slug;
        if (typeof appSlug !== 'string' || !appSlug ||
            liveRepo.id !== before.repositoryNumericId ||
            liveRepo.full_name.toLowerCase() !== before.repositoryFullName.toLowerCase() ||
            !Number.isSafeInteger(liveRepo.owner?.id) ||
            issue.number !== args.issueNumber || pr.number !== args.pullRequestNumber ||
            pr.head.sha !== args.expectedHeadSha || pr.merge_commit_sha !== args.expectedMergeSha ||
            pr.base.repo?.id !== before.repositoryNumericId ||
            reviewsResult.data.length >= maxEvidence ||
            checksResult.data.total_count > checksResult.data.check_runs.length ||
            checksResult.data.check_runs.length >= maxEvidence) {
          return c.json({ error: 'app_evidence_unverified' }, 409);
        }
        const linkedIssues = graph.repository?.pullRequest?.closingIssuesReferences;
        const threads = graph.repository?.pullRequest?.reviewThreads;
        if (!linkedIssues || !threads ||
            linkedIssues.pageInfo?.hasNextPage !== false ||
            threads.pageInfo?.hasNextPage !== false ||
            !linkedIssues.nodes?.some(node =>
              node?.number === args.issueNumber && node.repository?.databaseId === liveRepo.id) ||
            !Array.isArray(threads.nodes)) {
          return c.json({ error: 'app_evidence_incomplete' }, 409);
        }
        const reviews = reviewsResult.data.map(review => ({
          reviewerId: review.user?.id ?? 0,
          identity: review.user?.login ?? '',
          state: review.state,
          commitId: review.commit_id ?? '',
          submittedAtMs: timestamp(review.submitted_at) ?? 0,
        }));
        const checks = checksResult.data.check_runs.map(check => ({
          name: check.name,
          headSha: check.head_sha,
          status: check.status,
          conclusion: check.conclusion ?? '',
          completedAtMs: timestamp(check.completed_at) ?? 0,
        }));
        if (reviews.some(review => !Number.isSafeInteger(review.reviewerId) || review.reviewerId <= 0 ||
             !review.identity || !review.commitId || !review.submittedAtMs) ||
            checks.some(check => !check.name || check.headSha !== args.expectedHeadSha ||
             !check.status || !check.completedAtMs)) {
          return c.json({ error: 'app_evidence_incomplete' }, 409);
        }
        // Detect a DB relink/revoke/epoch drift during live remote reads.
        const after = await binding(options, scope);
        if (!after || after.bindingDigest !== before.bindingDigest)
          return c.json({ error: 'app_source_changed' }, 409);
        const finalRepo = await octokit.repos.get({ owner, repo });
        if (finalRepo.data.id !== before.repositoryNumericId ||
            finalRepo.data.full_name.toLowerCase() !== before.repositoryFullName.toLowerCase())
          return c.json({ error: 'app_installation_access_lost' }, 409);

        const readAtMs = Date.now();
        return c.json({
          version: 'factory_app_source_v1',
          factoryOrgId: before.factoryOrgId,
          projectId: before.projectId,
          projectRepositoryLinkId: before.projectRepositoryLinkId,
          connectionId: before.connectionId,
          repository: {
            fullName: liveRepo.full_name,
            id: liveRepo.id,
            ownerId: liveRepo.owner.id,
          },
          installation: {
            installationId: before.installationId,
            appSlug,
            repositoryAccessVerified: true,
            verifiedAtMs: readAtMs,
          },
          bindingDigest: before.bindingDigest,
          projectAutomationRevision: before.projectAutomationRevision,
          readAtMs,
          expiresAtMs: readAtMs + ttlMs,
          issue: {
            number: issue.number,
            databaseId: issue.id,
            state: issue.state,
            updatedAt: issue.updated_at,
            repositoryId: liveRepo.id,
          },
          pullRequest: {
            number: pr.number,
            headSha: pr.head.sha,
            baseSha: pr.base.sha,
            mergeCommitSha: pr.merge_commit_sha,
            mergedAtMs: timestamp(pr.merged_at),
            repositoryId: liveRepo.id,
          },
          reviews,
          checks,
          unresolvedBlockingThreads: threads.nodes.filter(thread => thread?.isResolved !== true).length,
        });
      } catch {
        // Never forward Octokit HTTP bodies, auth headers, installation tokens or stack traces.
        return c.json({ error: 'app_source_unavailable' }, 409);
      }
    },
  })];
}
