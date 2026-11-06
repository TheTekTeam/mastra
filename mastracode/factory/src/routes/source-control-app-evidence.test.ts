import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { buildProjectAppEvidenceRoutes } from './source-control-app-evidence.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

const ORG = 'org-htai-app-proof';
const PROJECT_OWNER = { workosId: 'gp', organizationId: ORG };
const REPO = 'TheTekTeam/HTAI';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const NOW = '2026-11-06T14:20:00.000Z';

function query(projectId: string, overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    repository: REPO,
    issueNumber: '42',
    pullRequestNumber: '67',
    expectedAutomationRevision: '0',
    expectedHeadSha: HEAD,
    expectedMergeSha: MERGE,
    ...overrides,
  });
  return '/web/factory/projects/' + projectId + '/source-control-evidence?' + params;
}

async function fixture() {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({
    orgId: ORG, userId: PROJECT_OWNER.workosId, input: { name: 'HTAI only' },
  });
  const sourceControl = seed.sourceControl.forIntegration('github');
  const installation = await sourceControl.installations.upsert({
    orgId: ORG, connectedByUserId: 'gp', externalId: '12345',
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: ORG,
    input: {
      installationId: installation.id,
      externalId: '9988',
      slug: REPO,
      defaultBranch: 'main',
    },
  });
  const connection = await sourceControl.connections.create({
    orgId: ORG, factoryProjectId: project.id,
    installationId: installation.id, createdByUserId: 'gp',
  });
  const link = await sourceControl.projectRepositories.link({
    orgId: ORG, connectionId: connection.id, repositoryId: repository.id,
    createdByUserId: 'gp', sandboxProvider: 'local', sandboxWorkdir: '/workspace/htai',
  });
  return { seed, project, sourceControl, installation, repository, connection, link };
}

type Variant = 'positive' | 'revoked' | 'repo-id-drift' | 'wrong-closing-repo' |
  'head-drift' | 'incomplete-threads' | 'ambiguous-checks';

function fakeGithub(mode: Variant = 'positive') {
  let repoReads = 0;
  let observedInstallation = 0;
  const github = {
    getAppOctokit: () => ({
      apps: { getAuthenticated: async () => ({ data: { slug: 'modelspend-factory' } }) },
    }),
    getInstallationOctokit: (installationId: number) => {
      observedInstallation = installationId;
      return {
        repos: {
          get: async () => {
            repoReads++;
            if (mode === 'revoked') throw Object.assign(new Error('forbidden'), { status: 403 });
            return { data: {
              id: mode === 'repo-id-drift' ? 9999 : 9988,
              full_name: REPO, owner: { id: 765 },
            } };
          },
        },
        issues: {
          get: async () => ({ data: {
            number: 42, id: 4200, state: 'closed', updated_at: NOW,
          } }),
        },
        pulls: {
          get: async () => ({ data: {
            number: 67,
            head: { sha: mode === 'head-drift' ? 'c'.repeat(40) : HEAD },
            base: { sha: 'f'.repeat(40), repo: { id: 9988 } },
            merge_commit_sha: MERGE,
            merged_at: NOW,
          } }),
          listReviews: async () => ({ data: [{
            id: 77, user: { id: 777, login: 'modelspend-reviewer' },
            state: 'APPROVED', commit_id: HEAD, submitted_at: NOW,
          }] }),
        },
        checks: {
          listForRef: async () => ({ data: {
            total_count: mode === 'ambiguous-checks' ? 101 : 2,
            check_runs: [{
              name: 'Node 22', head_sha: HEAD, status: 'completed',
              conclusion: 'success', completed_at: NOW,
            }, {
              name: 'ci/exact-head', head_sha: HEAD, status: 'completed',
              conclusion: 'success', completed_at: NOW,
            }],
          } }),
        },
        graphql: async () => ({ repository: { pullRequest: {
          closingIssuesReferences: {
            nodes: [{ number: 42,
              repository: { databaseId: mode === 'wrong-closing-repo' ? 9999 : 9988 } }],
            pageInfo: { hasNextPage: false },
          },
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { hasNextPage: mode === 'incomplete-threads' },
          },
        } } }),
      };
    },
  };
  return { github, getObservedInstallation: () => observedInstallation,
    getRepoReads: () => repoReads };
}

function app(options: {
  seed: Awaited<ReturnType<typeof fixture>>;
  github: ReturnType<typeof fakeGithub>['github'];
  user?: { workosId: string; organizationId?: string } | null;
  admin?: boolean;
  enabled?: boolean;
  sourceControl?: unknown;
}) {
  const hono = new Hono();
  const user = options.user === undefined ? PROJECT_OWNER : options.user;
  hono.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(hono as never, buildProjectAppEvidenceRoutes({
    auth: fakeRouteAuth({
      enabled: options.enabled ?? true,
      isOrganizationAdmin: async () => options.admin ?? true,
    }),
    projects: options.seed.seed.projects,
    sourceControl: (options.sourceControl ?? options.seed.sourceControl) as never,
    github: options.github as never,
  }));
  return hono;
}

describe('project-scoped live GitHub App evidence GET', () => {
  it('returns a short-lived tenant-linked numeric repo+installation proof without credentials', async () => {
    const seed = await fixture();
    try {
      const provider = fakeGithub();
      const response = await app({ seed, github: provider.github }).request(query(seed.project.id));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        version: 'factory_app_source_v1',
        factoryOrgId: ORG,
        projectId: seed.project.id,
        projectRepositoryLinkId: seed.link.id,
        connectionId: seed.connection.id,
        repository: { fullName: REPO, id: 9988, ownerId: 765 },
        installation: {
          installationId: 12345, appSlug: 'modelspend-factory',
          repositoryAccessVerified: true,
        },
        projectAutomationRevision: 0,
        issue: { number: 42, databaseId: 4200, state: 'closed', repositoryId: 9988 },
        pullRequest: { number: 67, headSha: HEAD, mergeCommitSha: MERGE, repositoryId: 9988 },
        unresolvedBlockingThreads: 0,
      });
      expect(body.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.expiresAtMs - body.readAtMs).toBe(90_000);
      expect(body.reviews[0].reviewerId).toBe(777);
      expect(body.checks).toHaveLength(2);
      expect(provider.getObservedInstallation()).toBe(12345);
      expect(provider.getRepoReads()).toBe(2);
      expect(JSON.stringify(body)).not.toMatch(/token|private.?key|client.?secret|pem/i);
    } finally { await seed.seed.storage.close(); }
  });

  it('denies anonymous, non-admin, disabled auth and cross-organisation project', async () => {
    const seed = await fixture();
    try {
      const github = fakeGithub().github;
      expect((await app({ seed, github, user: null }).request(query(seed.project.id))).status).toBe(401);
      expect((await app({ seed, github, enabled: false }).request(query(seed.project.id))).status).toBe(401);
      expect((await app({ seed, github, admin: false }).request(query(seed.project.id))).status).toBe(403);
      expect((await app({ seed, github, user: { workosId: 'other', organizationId: 'another' } })
        .request(query(seed.project.id))).status).toBe(409);
      expect((await app({ seed, github }).request(query(seed.project.id, {
        expectedAutomationRevision: '1',
      }))).status).toBe(409);
      expect((await app({ seed, github }).request(query(seed.project.id, {
        expectedAutomationRevision: '',
      }))).status).toBe(400);
      expect((await app({ seed, github }).request(query(seed.project.id, {
        issueNumber: '01',
      }))).status).toBe(400);
    } finally { await seed.seed.storage.close(); }
  });

  it.each([
    'revoked', 'repo-id-drift', 'wrong-closing-repo',
    'head-drift', 'incomplete-threads', 'ambiguous-checks',
  ] as const)('fails closed on %s and returns no raw upstream response', async variant => {
    const seed = await fixture();
    try {
      const response = await app({ seed, github: fakeGithub(variant).github })
        .request(query(seed.project.id));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['error']);
      expect(JSON.stringify(body)).not.toMatch(/token|secret|forbidden from upstream/i);
    } finally { await seed.seed.storage.close(); }
  });

  it('denies a changed project link between remote GitHub reads', async () => {
    const seed = await fixture();
    try {
      let calls = 0;
      const base = seed.sourceControl.projectRepositories.listByProject.bind(
        seed.sourceControl.projectRepositories,
      );
      const sourceControl = {
        ...seed.sourceControl,
        projectRepositories: {
          ...seed.sourceControl.projectRepositories,
          listByProject: async (scope: Parameters<typeof base>[0]) => {
            calls++;
            return calls === 1 ? base(scope) : [];
          },
        },
      };
      const response = await app({ seed, github: fakeGithub().github, sourceControl })
        .request(query(seed.project.id));
      expect(response.status).toBe(409);
    } finally { await seed.seed.storage.close(); }
  });
});
