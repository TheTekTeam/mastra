/**
 * A disabled-by-default, project-scoped service credential authority.
 * This is separate from BetterAuth human admin and cannot grant that role.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import type {
  ServiceCapabilityAction,
  ServiceCapabilityAuditEvent,
  ServiceCapabilityGrant,
  ServiceCapabilityStorage,
} from '../storage/domains/service-capabilities/base.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^fcp1_[A-Za-z0-9_-]{43}$/;
const CONSENT_PATTERN = /^fcc1_[A-Za-z0-9_-]{43}$/;
const MAX_GRANT_TTL_SECONDS = 86_400;
const MIN_GRANT_TTL_SECONDS = 60;
const CONSENT_TTL_MS = 5 * 60_000;

export interface ServiceCapabilityPolicy {
  /** Explicit opt-in. The default Factory configuration does not instantiate this authority. */
  enabled: true;
  /** A protected owner-private high-entropy key supplied at boot; never publish/log it. */
  hmacKey: Uint8Array;
  /** Exact pilot project UUIDs; no names, patterns or wildcard allowlists. */
  allowedProjectIds: ReadonlySet<string>;
  /** Exact GP/operator IDs supplied at boot, not hardcoded into this library. */
  allowedIssuerUserIds: ReadonlySet<string>;
  /** External operator origin; must be an exact HTTPS origin without path. */
  adminOrigin: string;
}

export interface ServiceCapabilityIssueIntent {
  operation: 'issue';
  actions: ServiceCapabilityAction[];
  workItemIds: string[];
  ttlSeconds: number;
}
export interface ServiceCapabilityRevokeIntent {
  operation: 'revoke';
  targetGrantId: string;
}
export type ServiceCapabilityIntent = ServiceCapabilityIssueIntent | ServiceCapabilityRevokeIntent;

export interface ServiceCapabilityPublicGrant {
  id: string;
  principalId: string;
  orgId: string;
  projectId: string;
  actions: ServiceCapabilityAction[];
  workItemIds: string[];
  issuedByUserId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
}

export function serviceCapabilityPublicGrant(grant: ServiceCapabilityGrant): ServiceCapabilityPublicGrant {
  const { tokenHash: _secretDigest, ...publicGrant } = grant;
  return publicGrant;
}

export function validateServiceCapabilityIntent(intent: ServiceCapabilityIntent): boolean {
  if (intent.operation === 'revoke') return UUID.test(intent.targetGrantId);
  if (!Number.isSafeInteger(intent.ttlSeconds)) return false;
  if (intent.ttlSeconds < MIN_GRANT_TTL_SECONDS || intent.ttlSeconds > MAX_GRANT_TTL_SECONDS) return false;
  const actions = new Set(intent.actions);
  if (!actions.size || actions.size !== intent.actions.length) return false;
  if ([...actions].some(action => action !== 'workItem.enqueue' && action !== 'projectAutomation.set')) return false;
  if (intent.workItemIds.length > 8 || new Set(intent.workItemIds).size !== intent.workItemIds.length) return false;
  if (intent.workItemIds.some(itemId => !UUID.test(itemId))) return false;
  return actions.has('workItem.enqueue') ? intent.workItemIds.length > 0 : intent.workItemIds.length === 0;
}

function intentDigest(intent: ServiceCapabilityIntent): string {
  const canonical =
    intent.operation === 'issue'
      ? ['issue', [...intent.actions].sort(), [...intent.workItemIds].sort(), intent.ttlSeconds]
      : ['revoke', intent.targetGrantId];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface ServiceCapabilityAdmission {
  grantId: string;
  principalId: string;
  orgId: string;
  projectId: string;
  workItemId: string | null;
  action: ServiceCapabilityAction;
  requestId: string;
  bodyFingerprint: string;
}

export class ServiceCapabilityAuthority {
  readonly #storage: ServiceCapabilityStorage;
  readonly #projects: FactoryProjectsStorage;
  readonly #policy: ServiceCapabilityPolicy;
  readonly #key: Buffer;

  constructor(deps: { storage: ServiceCapabilityStorage; projects: FactoryProjectsStorage; policy: ServiceCapabilityPolicy }) {
    this.#storage = deps.storage;
    this.#projects = deps.projects;
    this.#policy = deps.policy;
    if (deps.policy.hmacKey.byteLength < 32) throw new Error('Service capability HMAC key must be at least 256 bits');
    if (deps.policy.allowedProjectIds.size === 0 || deps.policy.allowedIssuerUserIds.size === 0) {
      throw new Error('Service capability pilot requires explicit project and issuer allowlists');
    }
    if ([...deps.policy.allowedProjectIds].some(projectId => !UUID.test(projectId))) {
      throw new Error('Service capability project allowlist must contain exact UUIDs');
    }
    const origin = new URL(deps.policy.adminOrigin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== deps.policy.adminOrigin ||
      origin.username ||
      origin.password
    ) {
      throw new Error('Service capability administrative origin must be exact HTTPS');
    }
    this.#key = Buffer.from(deps.policy.hmacKey);
  }

  allowsIssuer(userId: string, projectId: string): boolean {
    return this.#policy.allowedIssuerUserIds.has(userId) && this.#policy.allowedProjectIds.has(projectId);
  }

  /** For all grant-management writes, reject missing/mismatched Origin even for a signed-in admin. */
  trustedAdminOrigin(origin: string | undefined): boolean {
    return origin === this.#policy.adminOrigin;
  }

  allowsProject(projectId: string): boolean {
    return this.#policy.allowedProjectIds.has(projectId);
  }

  #hmac(purpose: 'consent' | 'service', secret: string): string {
    return createHmac('sha256', this.#key).update(purpose).update('\0').update(secret).digest('hex');
  }

  /** Returns only the new consent token. The backing store holds its keyed digest. */
  async beginConsent(input: {
    orgId: string;
    projectId: string;
    userId: string;
    intent: ServiceCapabilityIntent;
    now?: Date;
  }): Promise<string> {
    if (!this.allowsIssuer(input.userId, input.projectId) || !validateServiceCapabilityIntent(input.intent)) {
      throw new Error('Service capability consent is not allowed for this principal/project/intent');
    }
    if (!(await this.#projects.get({ orgId: input.orgId, id: input.projectId }))) {
      throw new Error('Service capability consent project not found');
    }
    const now = input.now ?? new Date();
    const raw = 'fcc1_' + randomBytes(32).toString('base64url');
    await this.#storage.createConsent({
      orgId: input.orgId,
      projectId: input.projectId,
      userId: input.userId,
      operation: input.intent.operation,
      ...(input.intent.operation === 'revoke' ? { targetGrantId: input.intent.targetGrantId } : {}),
      intentDigest: intentDigest(input.intent),
      consentHash: this.#hmac('consent', raw),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + CONSENT_TTL_MS),
    });
    return raw;
  }

  async issueGrant(input: {
    orgId: string;
    projectId: string;
    userId: string;
    consentToken: string;
    intent: ServiceCapabilityIssueIntent;
    now?: Date;
  }): Promise<{ status: 'issued'; grant: ServiceCapabilityPublicGrant; token: string } | { status: 'denied'; code: string }> {
    const now = input.now ?? new Date();
    if (!this.allowsIssuer(input.userId, input.projectId) || !validateServiceCapabilityIntent(input.intent)) {
      return { status: 'denied', code: 'scope_denied' };
    }
    if (!CONSENT_PATTERN.test(input.consentToken)) return { status: 'denied', code: 'invalid_consent' };
    const token = 'fcp1_' + randomBytes(32).toString('base64url');
    const grant = {
      principalId: randomUUID(),
      orgId: input.orgId,
      projectId: input.projectId,
      issuedByUserId: input.userId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + input.intent.ttlSeconds * 1000),
      actions: input.intent.actions,
      workItemIds: input.intent.workItemIds,
      tokenHash: this.#hmac('service', token),
    };
    const result = await this.#storage.issueWithConsent({
      consentHash: this.#hmac('consent', input.consentToken),
      consent: {
        orgId: input.orgId, projectId: input.projectId, userId: input.userId,
        operation: 'issue', intentDigest: intentDigest(input.intent),
      },
      grant,
      now,
    });
    if (result.status !== 'issued') return { status: 'denied', code: result.status };
    return { status: 'issued', grant: serviceCapabilityPublicGrant(result.grant), token };
  }

  async revokeGrant(input: {
    orgId: string;
    projectId: string;
    userId: string;
    consentToken: string;
    intent: ServiceCapabilityRevokeIntent;
    now?: Date;
  }): Promise<'revoked' | 'denied'> {
    if (!this.allowsIssuer(input.userId, input.projectId) || !validateServiceCapabilityIntent(input.intent)) {
      return 'denied';
    }
    if (!CONSENT_PATTERN.test(input.consentToken)) return 'denied';
    const result = await this.#storage.revokeWithConsent({
      consentHash: this.#hmac('consent', input.consentToken),
      consent: {
        orgId: input.orgId, projectId: input.projectId, userId: input.userId,
        operation: 'revoke', targetGrantId: input.intent.targetGrantId, intentDigest: intentDigest(input.intent),
      },
      now: input.now ?? new Date(),
    });
    return result === 'revoked' ? 'revoked' : 'denied';
  }

  async listGrants(input: { orgId: string; projectId: string }): Promise<ServiceCapabilityPublicGrant[]> {
    return (await this.#storage.listGrants(input)).map(serviceCapabilityPublicGrant);
  }

  /** Recognize only the explicit service scheme. Human Authorization semantics are untouched. */
  hasServiceCredential(header: string | undefined): boolean {
    return header?.startsWith('FactoryService') ?? false;
  }

  /**
   * Durable admission: every HTTP mutation must pass this fresh DB lookup.
   * A bad token never supplies org/project; both stay unknown in the denial journal.
   */
  async admit(input: {
    authorization: string;
    action: ServiceCapabilityAction;
    projectId: string;
    workItemId?: string;
    requestId: string;
    bodyFingerprint: string;
    now?: Date;
  }): Promise<{ status: 'admitted'; admission: ServiceCapabilityAdmission } | { status: 'denied' }> {
    const now = input.now ?? new Date();
    const raw = input.authorization.slice('FactoryService '.length);
    let grant: ServiceCapabilityGrant | null = null;
    if (TOKEN_PATTERN.test(raw)) {
      const hash = this.#hmac('service', raw);
      grant = await this.#storage.grantByTokenHash(hash);
      const candidate = Buffer.from(hash, 'hex');
      const expected = Buffer.from(grant?.tokenHash ?? '0'.repeat(64), 'hex');
      // Always perform a fixed-length comparison, including unknown token hashes.
      if (!timingSafeEqual(candidate, expected)) grant = null;
    } else {
      // Malformed material is not persisted or echoed; equal-length dummy comparison.
      timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    }
    const allowed =
      grant !== null &&
      grant.revokedAt === null &&
      grant.expiresAt.getTime() > now.getTime() &&
      this.#policy.allowedProjectIds.has(grant.projectId) &&
      grant.projectId === input.projectId &&
      grant.actions.includes(input.action) &&
      (input.action !== 'workItem.enqueue' ||
        (Boolean(input.workItemId) && grant.workItemIds.includes(input.workItemId!))) &&
      Boolean(await this.#projects.get({ orgId: grant.orgId, id: grant.projectId }));

    const audit = {
      grantId: grant?.id ?? null,
      orgId: grant?.orgId ?? null,
      projectId: grant?.projectId ?? null,
      workItemId: input.workItemId ?? null,
      principalId: grant?.principalId ?? null,
      actorId: grant?.principalId ?? null,
      action: input.action,
      requestId: input.requestId,
      bodyFingerprint: input.bodyFingerprint,
      outcome: allowed ? 'admitted' as const : 'denied' as const,
      reason: allowed ? null : 'invalid_or_out_of_scope',
      occurredAt: now,
    };
    // If admission or denial cannot be durably audited, throws before any native effect.
    await this.#storage.recordAudit(audit);
    if (!allowed || !grant) return { status: 'denied' };
    return {
      status: 'admitted',
      admission: {
        grantId: grant.id,
        principalId: grant.principalId,
        orgId: grant.orgId,
        projectId: grant.projectId,
        workItemId: input.workItemId ?? null,
        action: input.action,
        requestId: input.requestId,
        bodyFingerprint: input.bodyFingerprint,
      },
    };
  }

  async auditManagementDenial(input: {
    orgId: string;
    projectId: string;
    userId: string;
    operation: 'grant.issue' | 'grant.revoke';
    reason: string;
  }): Promise<void> {
    await this.#storage.recordAudit({
      grantId: null,
      orgId: input.orgId,
      projectId: input.projectId,
      workItemId: null,
      principalId: null,
      actorId: input.userId,
      action: input.operation,
      requestId: null,
      bodyFingerprint: null,
      outcome: 'denied',
      reason: input.reason,
      occurredAt: new Date(),
    });
  }

  /** Appends the effect outcome without exposing token material. Failure is EFFECT_UNVERIFIED to the caller. */
  async finish(admission: ServiceCapabilityAdmission, outcome: ServiceCapabilityAuditEvent['outcome'], reason: string | null = null) {
    await this.#storage.recordAudit({
      grantId: admission.grantId,
      orgId: admission.orgId,
      projectId: admission.projectId,
      workItemId: admission.workItemId,
      principalId: admission.principalId,
      actorId: admission.principalId,
      action: admission.action,
      requestId: admission.requestId,
      bodyFingerprint: admission.bodyFingerprint,
      outcome,
      reason,
      occurredAt: new Date(),
    });
  }
}
