/** Project-wide, non-mutating GitHub App repository grant. Unlike issue/PR
 * corroboration, this is usable before a project has any accepted work item.
 * The response is transport-backed, never a signed completion receipt.
 */
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import { FACTORY_ROUTE_CONTRACTS } from './contracts.js';
import { binding, installationGrantsRepository } from './source-control-app-evidence.js';
import type { Options, Scope } from './source-control-app-evidence.js';

const path = FACTORY_ROUTE_CONTRACTS.projectAppBindingGet.path;
const ttlMs = 90_000;
const maxEvidence = 100;

function expected(c: Context) {
  const contract = FACTORY_ROUTE_CONTRACTS.projectAppBindingGet;
  const parsedPath = contract.pathSchema.safeParse({ id: c.req.param('id') });
  const parsedQuery = contract.querySchema.safeParse(c.req.query());
  if (!parsedPath.success || !parsedQuery.success) return null;
  return { projectId: parsedPath.data.id.toLowerCase(), ...parsedQuery.data };
}

export function buildProjectAppBindingRoutes(options: Options): ApiRoute[] {
  if (options.enabled !== true) return [];
  return [registerApiRoute(path, {
    method: 'GET',
    requiresAuth: false,
    handler: async raw => {
      const c = raw as Context;
      if (!options.auth.enabled()) return c.json({ error: 'operator_signin_required' }, 401);
      await options.auth.ensureUser(c);
      const tenant = options.auth.tenant(c);
      if (!tenant?.orgId) return c.json({ error: 'unauthorized' }, 401);
      const args = expected(c);
      if (!args) return c.json({ error: 'invalid_project_app_binding_request' }, 400);
      if (args.expectedOrgId !== tenant.orgId) return c.json({ error: 'app_binding_unavailable' }, 409);
      if (!(await options.auth.isOrganizationAdmin(c, tenant.orgId)))
        return c.json({ error: 'forbidden' }, 403);
      const scope: Scope = {
        orgId: tenant.orgId, projectId: args.projectId,
        expectedRepository: args.repository,
        expectedAutomationRevision: args.expectedAutomationRevision,
      };
      try {
        // The sole project link, connection, repository, installation and
        // automation epoch must all be current and satisfy owner-pinned IDs.
        const before = await binding(options, scope);
        if (!before || before.repositoryNumericId !== args.expectedRepositoryId ||
            before.installationId !== args.expectedInstallationId ||
            before.projectRepositoryLinkId !== args.expectedLinkId ||
            before.connectionId !== args.expectedConnectionId)
          return c.json({ error: 'app_binding_unavailable' }, 409);
        const firstProject = await options.projects.get({orgId: tenant.orgId, id: args.projectId});
        if (!firstProject || typeof firstProject.name !== 'string' || !firstProject.name ||
            firstProject.automationRevision !== before.projectAutomationRevision)
          return c.json({ error: 'app_binding_unavailable' }, 409);
        const [owner, repo] = before.repositoryFullName.split('/');
        if (!owner || !repo) return c.json({ error: 'app_binding_unavailable' }, 409);
        const octokit = options.github.getInstallationOctokit(before.installationId);
        const app = options.github.getAppOctokit();
        const [grant, currentRepo, appIdentity] = await Promise.all([
          octokit.apps.listReposAccessibleToInstallation({ per_page: maxEvidence }),
          octokit.repos.get({ owner, repo }),
          app.apps.getAuthenticated(),
        ]);
        const liveRepo = currentRepo.data;
        const appSlug = appIdentity.data?.slug;
        if (!installationGrantsRepository(grant, before) ||
            liveRepo.id !== before.repositoryNumericId ||
            typeof liveRepo.full_name !== 'string' ||
            liveRepo.full_name.toLowerCase() !== before.repositoryFullName.toLowerCase() ||
            liveRepo.owner?.id !== args.expectedOwnerId ||
            typeof appSlug !== 'string' || !appSlug)
          return c.json({ error: 'app_installation_access_lost' }, 409);

        // A public repos.get success alone is insufficient. Requery both
        // DB scope and installation-authenticated repository membership.
        const after = await binding(options, scope);
        const finalProject = await options.projects.get({orgId: tenant.orgId, id: args.projectId});
        if (!after || after.bindingDigest !== before.bindingDigest ||
            !finalProject || finalProject.name !== firstProject.name ||
            finalProject.automationRevision !== before.projectAutomationRevision)
          return c.json({ error: 'app_binding_changed' }, 409);
        const [finalGrant, finalRepo] = await Promise.all([
          octokit.apps.listReposAccessibleToInstallation({ per_page: maxEvidence }),
          octokit.repos.get({ owner, repo }),
        ]);
        if (!installationGrantsRepository(finalGrant, before) ||
            finalRepo.data.id !== before.repositoryNumericId ||
            finalRepo.data.full_name?.toLowerCase() !== before.repositoryFullName.toLowerCase() ||
            finalRepo.data.owner?.id !== args.expectedOwnerId)
          return c.json({ error: 'app_installation_access_lost' }, 409);

        // The final remote GitHub call is an await: a link may be unlinked or
        // the automation epoch advanced while that last grant check ran.
        // Revalidate the durable DB scope AFTER it, immediately before reply.
        const closingBinding = await binding(options, scope);
        const closingProject = await options.projects.get({ orgId: tenant.orgId, id: args.projectId });
        if (!closingBinding || closingBinding.bindingDigest !== before.bindingDigest ||
            !closingProject || closingProject.name !== firstProject.name ||
            closingProject.automationRevision !== before.projectAutomationRevision)
          return c.json({ error: 'app_binding_changed' }, 409);

        const readAtMs = Date.now();
        return c.json({
          version: 'factory_app_project_scope_v1',
          factoryOrgId: before.factoryOrgId,
          projectId: before.projectId,
          projectName: firstProject.name,
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
        });
      } catch {
        // Upstream auth, revocation, transport and partial results are denied
        // without copying tokens, headers, response bodies or diagnostic URLs.
        return c.json({ error: 'app_binding_unavailable' }, 409);
      }
    },
  })];
}
