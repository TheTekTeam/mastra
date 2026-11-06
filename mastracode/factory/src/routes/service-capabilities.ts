/**
 * Opt-in human-admin management of narrowly scoped Factory service grants.
 * No bearer credential can enter these routes; they use the existing signed-in
 * organization session, trusted HTTPS Origin and persisted one-use consent.
 */
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import type {
  ServiceCapabilityIntent,
  ServiceCapabilityIssueIntent,
  ServiceCapabilityRevokeIntent,
  ServiceCapabilityAuthority,
} from '../service-capabilities/authority.js';
import type { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import { FACTORY_ROUTE_CONTRACTS } from './contracts.js';
import { Route } from './route.js';
import type { RouteDependencies } from './route.js';

type Scope = { orgId: string; userId: string; projectId: string };
interface ServiceCapabilityRoutesDeps extends RouteDependencies {
  capabilities: ServiceCapabilityAuthority;
  projects: FactoryProjectsStorage;
}

function loose(c: unknown): Context {
  return c as Context;
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

export class ServiceCapabilityRoutes extends Route<ServiceCapabilityRoutesDeps> {
  async #admin(c: Context, projectId: string, mutation: boolean): Promise<Scope | { response: Response }> {
    const { auth, capabilities, projects } = this.deps;
    if (!auth.enabled()) return { response: c.json({ error: 'forbidden' }, 403) };
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) return { response: c.json({ error: 'unauthorized' }, 401) };
    if (!tenant.orgId) return { response: c.json({ error: 'organization_required' }, 403) };
    const scope = { orgId: tenant.orgId, userId: tenant.userId, projectId };
    // A bearer on a browser-admin route is a confused-deputy hazard, even
    // when the same request happens to include a valid human session.
    if (capabilities.hasServiceCredential(c.req.header('authorization'))) {
      await capabilities.auditManagementDenial({ ...scope, operation: 'grant.consent', reason: 'service_bearer_forbidden' });
      return { response: c.json({ error: 'forbidden' }, 403) };
    }
    if (
      !(await auth.isOrganizationAdmin(c, tenant.orgId)) ||
      !capabilities.allowsIssuer(tenant.userId, projectId)
    ) {
      await capabilities.auditManagementDenial({ ...scope, operation: 'grant.consent', reason: 'issuer_forbidden' });
      return { response: c.json({ error: 'forbidden' }, 403) };
    }
    if (mutation && !capabilities.trustedAdminOrigin(c.req.header('origin'))) {
      await capabilities.auditManagementDenial({ ...scope, operation: 'grant.consent', reason: 'trusted_origin_required' });
      return { response: c.json({ error: 'trusted_origin_required' }, 403) };
    }
    await projects.ensureReady();
    const project = await projects.get({ orgId: tenant.orgId, id: projectId });
    if (!project) return { response: c.json({ error: 'Project not found' }, 404) };
    return { orgId: tenant.orgId, userId: tenant.userId, projectId };
  }

  routes(): ApiRoute[] {
    const { capabilities } = this.deps;
    const consentContract = FACTORY_ROUTE_CONTRACTS.serviceCapabilityConsent;
    const issueContract = FACTORY_ROUTE_CONTRACTS.serviceCapabilityGrantIssue;
    const listContract = FACTORY_ROUTE_CONTRACTS.serviceCapabilityGrantList;
    const revokeContract = FACTORY_ROUTE_CONTRACTS.serviceCapabilityGrantRevoke;
    return [
      registerApiRoute(consentContract.path, {
        method: consentContract.method,
        requiresAuth: false,
        handler: async c => {
          const context = loose(c);
          const path = consentContract.pathSchema.safeParse({ id: c.req.param('id') });
          if (!path.success) return c.json({ error: 'Project not found' }, 404);
          const scope = await this.#admin(context, path.data.id, true);
          if ('response' in scope) return scope.response;
          const body = consentContract.bodySchema.safeParse(await readJson(context));
          if (!body.success) {
            await capabilities.auditManagementDenial({ ...scope, operation: 'grant.consent', reason: 'invalid_intent' });
            return c.json({ error: 'invalid_service_capability_intent' }, 400);
          }
          const issuedAt = new Date();
          try {
            const consentToken = await capabilities.beginConsent({
              ...scope,
              intent: body.data as ServiceCapabilityIntent,
              now: issuedAt,
            });
            context.header('Cache-Control', 'no-store');
            return c.json({ consentToken, expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString() }, 201);
          } catch {
            return c.json({ error: 'service_capability_consent_denied' }, 403);
          }
        },
      }),
      registerApiRoute(issueContract.path, {
        method: issueContract.method,
        requiresAuth: false,
        handler: async c => {
          const context = loose(c);
          const path = issueContract.pathSchema.safeParse({ id: c.req.param('id') });
          if (!path.success) return c.json({ error: 'Project not found' }, 404);
          const scope = await this.#admin(context, path.data.id, true);
          if ('response' in scope) return scope.response;
          const body = issueContract.bodySchema.safeParse(await readJson(context));
          if (!body.success) {
            await capabilities.auditManagementDenial({ ...scope, operation: 'grant.issue', reason: 'invalid_grant' });
            return c.json({ error: 'invalid_service_capability_grant' }, 400);
          }
          const { consentToken, ...intent } = body.data;
          const result = await capabilities.issueGrant({
            ...scope,
            consentToken,
            intent: intent as ServiceCapabilityIssueIntent,
          });
          if (result.status !== 'issued') {
            await capabilities.auditManagementDenial({ ...scope, operation: 'grant.issue', reason: result.code });
            return c.json({ error: 'service_capability_grant_denied' }, 409);
          }
          context.header('Cache-Control', 'no-store');
          return c.json({ grant: result.grant, token: result.token }, 201);
        },
      }),
      registerApiRoute(listContract.path, {
        method: listContract.method,
        requiresAuth: false,
        handler: async c => {
          const context = loose(c);
          const path = listContract.pathSchema.safeParse({ id: c.req.param('id') });
          if (!path.success) return c.json({ error: 'Project not found' }, 404);
          const scope = await this.#admin(context, path.data.id, false);
          if ('response' in scope) return scope.response;
          context.header('Cache-Control', 'no-store');
          return c.json({ grants: await capabilities.listGrants(scope) });
        },
      }),
      registerApiRoute(revokeContract.path, {
        method: revokeContract.method,
        requiresAuth: false,
        handler: async c => {
          const context = loose(c);
          const path = revokeContract.pathSchema.safeParse({ id: c.req.param('id'), grantId: c.req.param('grantId') });
          if (!path.success) return c.json({ error: 'Service grant not found' }, 404);
          const scope = await this.#admin(context, path.data.id, true);
          if ('response' in scope) return scope.response;
          const body = revokeContract.bodySchema.safeParse(await readJson(context));
          if (!body.success) {
            await capabilities.auditManagementDenial({ ...scope, operation: 'grant.revoke', reason: 'invalid_revoke' });
            return c.json({ error: 'invalid_service_capability_revoke' }, 400);
          }
          const intent: ServiceCapabilityRevokeIntent = { operation: 'revoke', targetGrantId: path.data.grantId };
          const result = await capabilities.revokeGrant({ ...scope, consentToken: body.data.consentToken, intent });
          if (result !== 'revoked') {
            await capabilities.auditManagementDenial({ ...scope, operation: 'grant.revoke', reason: 'invalid_consent' });
            return c.json({ error: 'service_capability_revoke_denied' }, 409);
          }
          context.header('Cache-Control', 'no-store');
          return c.json({ revoked: true as const });
        },
      }),
    ];
  }
}
