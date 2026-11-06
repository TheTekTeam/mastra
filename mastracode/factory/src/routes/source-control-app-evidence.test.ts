import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { buildProjectAppBindingRoutes } from './source-control-app-binding.js';
import { buildProjectAppEvidenceRoutes, buildUnavailableProjectAppReadRoutes } from './source-control-app-evidence.js';
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
  'head-drift' | 'incomplete-threads' | 'ambiguous-checks' |
  'grant-removed' | 'grant-lost-after' | 'grant-oversized' |
  'repo-rename' | 'owner-transfer';

function fakeGithub(mode: Variant = 'positive') {
  let repoReads = 0;
  let grantReads = 0;
  let observedInstallation = 0;
  const github = {
    getAppOctokit: () => ({
      apps: { getAuthenticated: async () => ({ data: { slug: 'modelspend-factory' } }) },
    }),
    getInstallationOctokit: (installationId: number) => {
      observedInstallation = installationId;
      return {
        apps: {
          listReposAccessibleToInstallation: async () => {
            grantReads++;
            const active = mode !== 'grant-removed' &&
              !(mode === 'grant-lost-after' && grantReads > 1);
            const repositories = active ? [{ id: 9988, full_name: REPO }] : [];
            return { data: {
              total_count: mode === 'grant-oversized' ? 101 : repositories.length,
              repositories,
            } };
          },
        },
        repos: {
          get: async () => {
            repoReads++;
            if (mode === 'revoked') throw Object.assign(new Error('forbidden'), { status: 403 });
            return { data: {
              id: mode === 'repo-id-drift' ? 9999 : 9988,
              full_name: mode === 'repo-rename' ? 'OtherOrg/HTAI' : REPO,
              owner: { id: mode === 'owner-transfer' ? 766 : 765 },
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
    getRepoReads: () => repoReads, getGrantReads: () => grantReads };
}

function app(options: {
  seed: Awaited<ReturnType<typeof fixture>>;
  github: ReturnType<typeof fakeGithub>['github'];
  user?: { workosId: string; organizationId?: string } | null;
  admin?: boolean;
  enabled?: boolean;
  featureEnabled?: boolean;
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
    enabled: options.featureEnabled ?? true,
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
      expect(provider.getGrantReads()).toBe(2);
      expect(JSON.stringify(body)).not.toMatch(/token|private.?key|client.?secret|pem/i);
    } finally { await seed.seed.storage.close(); }
  });

  it('owner-controlled App evidence route is absent by default and only enabled on explicit opt-in', async () => {
    const seed = await fixture();
    try {
      const provider = fakeGithub();
      expect(buildProjectAppEvidenceRoutes({
        auth: fakeRouteAuth({ enabled: true }), projects: seed.seed.projects,
        sourceControl: seed.sourceControl, github: provider.github as never,
      })).toHaveLength(0);
      expect((await app({ seed, github: provider.github, featureEnabled: false })
        .request(query(seed.project.id))).status).toBe(404);
      expect(provider.getRepoReads()).toBe(0);
      expect(provider.getGrantReads()).toBe(0);
      expect((await app({ seed, github: provider.github, featureEnabled: true })
        .request(query(seed.project.id))).status).toBe(200);
      expect(provider.getGrantReads()).toBe(2);
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
    'grant-removed', 'grant-lost-after', 'grant-oversized',
    'repo-rename',
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

function bindingQuery(seed: Awaited<ReturnType<typeof fixture>>, overrides: Record<string,string> = {}) {
  const args = new URLSearchParams({
    expectedOrgId: ORG,
    repository: REPO,
    expectedRepositoryId: '9988',
    expectedOwnerId: '765',
    expectedInstallationId: '12345',
    expectedLinkId: seed.link.id,
    expectedConnectionId: seed.connection.id,
    expectedAutomationRevision: '0',
    ...overrides,
  });
  return '/web/factory/projects/' + seed.project.id + '/source-control-binding?' + args;
}

function bindingApp(options: {
  seed: Awaited<ReturnType<typeof fixture>>;
  github: ReturnType<typeof fakeGithub>['github'];
  user?: {workosId:string;organizationId?:string} | null;
  admin?: boolean;
  enabled?: boolean;
  sourceControl?: unknown;
}) {
  const hono = new Hono();
  const user = options.user === undefined ? PROJECT_OWNER : options.user;
  hono.use('*', async (c,next) => {
    if (user) c.set('factoryAuthUser' as never,user as never);
    await next();
  });
  mountApiRoutes(hono as never, buildProjectAppBindingRoutes({
    auth:fakeRouteAuth({enabled: options.enabled??true,
      isOrganizationAdmin:async()=>options.admin??true}),
    projects:options.seed.seed.projects,
    sourceControl:(options.sourceControl??options.seed.sourceControl) as never,
    github:options.github as never,enabled:true,
  }));
  return hono;
}

describe('project-wide authenticated GitHub App binding GET', () => {
  it('returns a short-lived exact current project/repo/installation grant without any issue or PR', async () => {
    const seed=await fixture();
    try {
      const provider=fakeGithub();
      const response=await bindingApp({seed,github:provider.github})
        .request(bindingQuery(seed));
      expect(response.status).toBe(200);
      const body=await response.json();
      expect(body).toMatchObject({
        version:'factory_app_project_scope_v1',
        factoryOrgId:ORG,projectId:seed.project.id,projectName:'HTAI only',
        projectRepositoryLinkId:seed.link.id,connectionId:seed.connection.id,
        repository:{fullName:REPO,id:9988,ownerId:765},
        installation:{installationId:12345,appSlug:'modelspend-factory',
          repositoryAccessVerified:true},
        projectAutomationRevision:0,
      });
      expect(body.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.expiresAtMs-body.readAtMs).toBe(90_000);
      expect(provider.getGrantReads()).toBe(2);
      expect(provider.getRepoReads()).toBe(2);
      expect(Object.keys(body).sort()).toEqual([
        'bindingDigest','connectionId','expiresAtMs','factoryOrgId','installation',
        'projectAutomationRevision','projectId','projectName','projectRepositoryLinkId',
        'readAtMs','repository','version',
      ].sort());
      expect(JSON.stringify(body)).not.toMatch(/token|pem|private.?key|client.?secret/i);
    } finally {await seed.seed.storage.close();}
  });

  it('denies anonymous, cross-org, non-admin and Factory auth-disabled', async () => {
    const seed=await fixture();
    try {
      const github=fakeGithub().github;
      for(const [overrides,status] of [
        [{user:null},401],
        [{user:{workosId:'other',organizationId:'another'}},409],
        [{admin:false},403],
        [{enabled:false},401],
      ] as const) {
        const response=await bindingApp({seed,github,...overrides} as never)
          .request(bindingQuery(seed));
        expect(response.status).toBe(status);
        expect(Object.keys(await response.json())).toEqual(['error']);
      }
    } finally {await seed.seed.storage.close();}
  });

  it.each([
    ['expectedOrgId','another'],['expectedRepositoryId','9999'],
    ['expectedOwnerId','766'],['expectedInstallationId','12346'],
    ['expectedLinkId','other-link'],['expectedConnectionId','other-connection'],
    ['expectedAutomationRevision','1'],['repository','TheTekTeam/OTHER'],
  ])('denies wrong pinned %s without leaking grant', async (key,value) => {
    const seed=await fixture();
    try {
      const response=await bindingApp({seed,github:fakeGithub().github})
        .request(bindingQuery(seed,{[key]:value}));
      expect(response.status).toBe(409);
      expect(Object.keys(await response.json())).toEqual(['error']);
    } finally {await seed.seed.storage.close();}
  });

  it.each([
    'revoked','repo-id-drift','grant-removed','grant-lost-after','grant-oversized',
    'repo-rename','owner-transfer',
  ] as const)('denies %s even if public repo remains readable',async mode => {
    const seed=await fixture();
    try {
      const response=await bindingApp({seed,github:fakeGithub(mode).github})
        .request(bindingQuery(seed));
      expect(response.status).toBe(409);
      expect(Object.keys(await response.json())).toEqual(['error']);
    } finally {await seed.seed.storage.close();}
  });

  it('denies a live DB project-repository link change during App grant reads',async () => {
    const seed=await fixture();
    try {
      let calls=0;
      const base=seed.sourceControl.projectRepositories.listByProject.bind(
        seed.sourceControl.projectRepositories);
      const sourceControl={
        ...seed.sourceControl,
        projectRepositories:{
          ...seed.sourceControl.projectRepositories,
          listByProject:async (scope:Parameters<typeof base>[0]) =>
            ++calls===1?base(scope):[],
        },
      };
      const response=await bindingApp({seed,github:fakeGithub().github,sourceControl})
        .request(bindingQuery(seed));
      expect(response.status).toBe(409);
    } finally {await seed.seed.storage.close();}
  });

  it('disabled source-control routes give authenticated JSON404, never SPA200, and anonymous401',async () => {
    const seed=await fixture();
    try {
      const auth=fakeRouteAuth({enabled:true});
      const paths=[
        '/web/factory/projects/:id/source-control-evidence',
        '/web/factory/projects/:id/source-control-binding',
      ];
      const enabled=new Hono();
      enabled.use('*',async(c,next)=>{c.set('factoryAuthUser' as never,PROJECT_OWNER as never);await next();});
      mountApiRoutes(enabled as never,buildUnavailableProjectAppReadRoutes(auth,paths));
      const anonymous=new Hono();
      mountApiRoutes(anonymous as never,buildUnavailableProjectAppReadRoutes(auth,paths));
      for(const suffix of ['source-control-evidence','source-control-binding']) {
        const path='/web/factory/projects/'+seed.project.id+'/'+suffix;
        const response=await enabled.request(path);
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual({error:'not_found'});
        expect((await anonymous.request(path)).status).toBe(401);
      }
    } finally {await seed.seed.storage.close();}
  });
});
