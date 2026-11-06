/**
 * Explicit service capability storage. Every grant belongs to one real Factory
 * organization and project; no human-auth privileges are delegated by this table.
 * The raw bearer and consent secrets are NEVER persisted here.
 */
import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';

export const SERVICE_CAPABILITY_ACTIONS = ['workItem.enqueue', 'projectAutomation.set'] as const;
export type ServiceCapabilityAction = (typeof SERVICE_CAPABILITY_ACTIONS)[number];
export type ServiceCapabilityOperation = 'issue' | 'revoke';

export interface ServiceCapabilityGrant {
  id: string;
  principalId: string;
  orgId: string;
  projectId: string;
  actions: ServiceCapabilityAction[];
  workItemIds: string[];
  /** Keyed SHA-256 digest; never return this field from an HTTP read response. */
  tokenHash: string;
  issuedByUserId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
}

export interface ServiceCapabilityAuditEvent {
  id: string;
  grantId: string | null;
  orgId: string | null;
  projectId: string | null;
  workItemId: string | null;
  principalId: string | null;
  actorId: string | null;
  action: string;
  requestId: string | null;
  bodyFingerprint: string | null;
  outcome: 'admitted' | 'denied' | 'succeeded' | 'rejected' | 'effect_unverified' | 'issued' | 'revoked';
  reason: string | null;
  occurredAt: Date;
}

export const SERVICE_CAPABILITY_GRANTS_SCHEMA: CollectionSchema = {
  name: 'service_capability_grants',
  columns: {
    id: { type: 'uuid-pk' },
    principal_id: { type: 'text' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    actions: { type: 'json' },
    work_item_ids: { type: 'json' },
    token_hash: { type: 'text' },
    issued_by_user_id: { type: 'text' },
    issued_at: { type: 'timestamp' },
    expires_at: { type: 'timestamp' },
    revoked_at: { type: 'timestamp', nullable: true },
    version: { type: 'integer', default: 1 },
  },
  uniqueIndexes: [{ name: 'service_capability_grant_token_unique', columns: ['token_hash'] }],
  indexes: [{ name: 'service_capability_grant_project', columns: ['org_id', 'project_id', 'issued_at'] }],
};

export const SERVICE_CAPABILITY_CONSENTS_SCHEMA: CollectionSchema = {
  name: 'service_capability_consents',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    user_id: { type: 'text' },
    operation: { type: 'text' },
    target_grant_id: { type: 'text', nullable: true },
    intent_digest: { type: 'text' },
    consent_hash: { type: 'text' },
    issued_at: { type: 'timestamp' },
    expires_at: { type: 'timestamp' },
    consumed_at: { type: 'timestamp', nullable: true },
  },
  uniqueIndexes: [{ name: 'service_capability_consent_hash_unique', columns: ['consent_hash'] }],
  indexes: [{ name: 'service_capability_consent_project', columns: ['org_id', 'project_id', 'issued_at'] }],
};

export const SERVICE_CAPABILITY_AUDIT_SCHEMA: CollectionSchema = {
  name: 'service_capability_audit',
  columns: {
    id: { type: 'uuid-pk' },
    grant_id: { type: 'text', nullable: true },
    org_id: { type: 'text', nullable: true },
    project_id: { type: 'text', nullable: true },
    work_item_id: { type: 'text', nullable: true },
    principal_id: { type: 'text', nullable: true },
    actor_id: { type: 'text', nullable: true },
    action: { type: 'text' },
    request_id: { type: 'text', nullable: true },
    body_fingerprint: { type: 'text', nullable: true },
    outcome: { type: 'text' },
    reason: { type: 'text', nullable: true },
    occurred_at: { type: 'timestamp' },
  },
  indexes: [
    { name: 'service_capability_audit_project', columns: ['org_id', 'project_id', 'occurred_at'] },
    { name: 'service_capability_audit_request', columns: ['request_id', 'occurred_at'] },
  ],
};

interface GrantDbRow extends Record<string, unknown> {
  id: string;
  principal_id: string;
  org_id: string;
  project_id: string;
  actions: ServiceCapabilityAction[];
  work_item_ids: string[];
  token_hash: string;
  issued_by_user_id: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  version: number;
}
interface ConsentDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  operation: ServiceCapabilityOperation;
  target_grant_id: string | null;
  intent_digest: string;
  consent_hash: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}
interface AuditDbRow extends Record<string, unknown> {
  id: string;
  grant_id: string | null;
  org_id: string | null;
  project_id: string | null;
  work_item_id: string | null;
  principal_id: string | null;
  actor_id: string | null;
  action: string;
  request_id: string | null;
  body_fingerprint: string | null;
  outcome: ServiceCapabilityAuditEvent['outcome'];
  reason: string | null;
  occurred_at: Date;
}

function toGrant(row: GrantDbRow): ServiceCapabilityGrant {
  return {
    id: row.id,
    principalId: row.principal_id,
    orgId: row.org_id,
    projectId: row.project_id,
    actions: row.actions,
    workItemIds: row.work_item_ids,
    tokenHash: row.token_hash,
    issuedByUserId: row.issued_by_user_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    version: row.version,
  };
}
function toAudit(row: AuditDbRow): ServiceCapabilityAuditEvent {
  return {
    id: row.id,
    grantId: row.grant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    principalId: row.principal_id,
    actorId: row.actor_id,
    action: row.action,
    requestId: row.request_id,
    bodyFingerprint: row.body_fingerprint,
    outcome: row.outcome,
    reason: row.reason,
    occurredAt: row.occurred_at,
  };
}
export type ServiceCapabilityAuditInput = Omit<ServiceCapabilityAuditEvent, 'id'>;
export type ServiceCapabilityGrantIssue = Pick<
  ServiceCapabilityGrant,
  'principalId' | 'orgId' | 'projectId' | 'actions' | 'workItemIds' | 'tokenHash' | 'issuedByUserId' | 'issuedAt' | 'expiresAt'
>;

export interface ServiceCapabilityConsentInput {
  orgId: string;
  projectId: string;
  userId: string;
  operation: ServiceCapabilityOperation;
  targetGrantId?: string;
  intentDigest: string;
  consentHash: string;
  issuedAt: Date;
  expiresAt: Date;
}

export class ServiceCapabilityStorage extends FactoryStorageDomain {
  constructor() {
    super('service-capabilities');
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.storage.withTransaction(async ops => {
      await ops.deleteMany('service_capability_audit', {});
      await ops.deleteMany('service_capability_consents', {});
      await ops.deleteMany('service_capability_grants', {});
    });
  }

  async init(): Promise<void> {
    await this.ensureCollections([
      SERVICE_CAPABILITY_GRANTS_SCHEMA,
      SERVICE_CAPABILITY_CONSENTS_SCHEMA,
      SERVICE_CAPABILITY_AUDIT_SCHEMA,
    ]);
  }

  /** The caller supplies only a keyed digest, never a raw token. */
  async grantByTokenHash(tokenHash: string): Promise<ServiceCapabilityGrant | null> {
    const row = await this.ops.findOne<GrantDbRow>('service_capability_grants', { token_hash: tokenHash });
    return row ? toGrant(row) : null;
  }

  async getGrant({ orgId, projectId, grantId }: { orgId: string; projectId: string; grantId: string }) {
    const row = await this.ops.findOne<GrantDbRow>('service_capability_grants', {
      org_id: orgId,
      project_id: projectId,
      id: grantId,
    });
    return row ? toGrant(row) : null;
  }

  async listGrants({ orgId, projectId }: { orgId: string; projectId: string }): Promise<ServiceCapabilityGrant[]> {
    const rows = await this.ops.findMany<GrantDbRow>(
      'service_capability_grants',
      { org_id: orgId, project_id: projectId },
      { orderBy: [['issued_at', 'desc']] },
    );
    return rows.map(toGrant);
  }

  async createConsent(input: ServiceCapabilityConsentInput): Promise<void> {
    await this.ops.insertOne<ConsentDbRow>('service_capability_consents', {
      org_id: input.orgId,
      project_id: input.projectId,
      user_id: input.userId,
      operation: input.operation,
      target_grant_id: input.targetGrantId ?? null,
      intent_digest: input.intentDigest,
      consent_hash: input.consentHash,
      issued_at: input.issuedAt,
      expires_at: input.expiresAt,
      consumed_at: null,
    });
  }

  /** Append-only audit: failures throw and prevent admission to native effects. */
  async recordAudit(input: ServiceCapabilityAuditInput): Promise<ServiceCapabilityAuditEvent> {
    const row = await this.ops.insertOne<AuditDbRow>('service_capability_audit', {
      grant_id: input.grantId,
      org_id: input.orgId,
      project_id: input.projectId,
      work_item_id: input.workItemId,
      principal_id: input.principalId,
      actor_id: input.actorId,
      action: input.action,
      request_id: input.requestId,
      body_fingerprint: input.bodyFingerprint,
      outcome: input.outcome,
      reason: input.reason,
      occurred_at: input.occurredAt,
    });
    return toAudit(row);
  }

  /** Consume consent AND issue grant in one write transaction. Any exception rolls both back. */
  async issueWithConsent({
    consentHash,
    consent,
    grant,
    now,
  }: {
    consentHash: string;
    consent: Omit<ServiceCapabilityConsentInput, 'consentHash' | 'issuedAt' | 'expiresAt'>;
    grant: ServiceCapabilityGrantIssue;
    now: Date;
  }): Promise<{ status: 'issued'; grant: ServiceCapabilityGrant } | { status: 'invalid_consent' | 'project_not_found' | 'work_item_not_found' }> {
    return this.storage.withTransaction(async ops => {
      const accepted = await this.#consumeConsent(ops, { hash: consentHash, ...consent, now });
      if (!accepted) return { status: 'invalid_consent' };
      const project = await ops.findOne('factory_projects', { org_id: grant.orgId, id: grant.projectId });
      if (!project) return { status: 'project_not_found' };
      for (const itemId of grant.workItemIds) {
        const item = await ops.findOne('work_items', {
          org_id: grant.orgId,
          factory_project_id: grant.projectId,
          id: itemId,
        });
        if (!item) return { status: 'work_item_not_found' };
      }
      const row = await ops.insertOne<GrantDbRow>('service_capability_grants', {
        principal_id: grant.principalId,
        org_id: grant.orgId,
        project_id: grant.projectId,
        actions: grant.actions,
        work_item_ids: grant.workItemIds,
        token_hash: grant.tokenHash,
        issued_by_user_id: grant.issuedByUserId,
        issued_at: grant.issuedAt,
        expires_at: grant.expiresAt,
        revoked_at: null,
        version: 1,
      });
      await this.#recordWithin(ops, {
        grantId: row.id,
        orgId: row.org_id,
        projectId: row.project_id,
        workItemId: null,
        principalId: row.principal_id,
        actorId: row.issued_by_user_id,
        action: 'grant.issue',
        requestId: null,
        bodyFingerprint: consent.intentDigest,
        outcome: 'issued',
        reason: null,
        occurredAt: now,
      });
      return { status: 'issued', grant: toGrant(row) };
    });
  }

  /** Revocation is transactionally fenced by the exact consent/issuer/project/grant. */
  async revokeWithConsent({
    consentHash,
    consent,
    now,
  }: {
    consentHash: string;
    consent: Omit<ServiceCapabilityConsentInput, 'consentHash' | 'issuedAt' | 'expiresAt'>;
    now: Date;
  }): Promise<'revoked' | 'invalid_consent' | 'grant_not_found'> {
    return this.storage.withTransaction(async ops => {
      if (!consent.targetGrantId) return 'invalid_consent';
      const accepted = await this.#consumeConsent(ops, { hash: consentHash, ...consent, now });
      if (!accepted) return 'invalid_consent';
      let found = false;
      let wasRevoked = false;
      const row = await ops.updateAtomic<GrantDbRow>(
        'service_capability_grants',
        { org_id: consent.orgId, project_id: consent.projectId, id: consent.targetGrantId },
        current => {
          found = true;
          if (current.revoked_at) {
            wasRevoked = true;
            return null;
          }
          return { revoked_at: now, version: current.version + 1 };
        },
      );
      if (!row || !found) return 'grant_not_found';
      await this.#recordWithin(ops, {
        grantId: row.id,
        orgId: consent.orgId,
        projectId: consent.projectId,
        workItemId: null,
        principalId: row.principal_id,
        actorId: consent.userId,
        action: 'grant.revoke',
        requestId: null,
        bodyFingerprint: consent.intentDigest,
        outcome: 'revoked',
        reason: wasRevoked ? 'already_revoked' : null,
        occurredAt: now,
      });
      return 'revoked';
    });
  }

  async listAudit({ orgId, projectId }: { orgId: string; projectId: string }): Promise<ServiceCapabilityAuditEvent[]> {
    const rows = await this.ops.findMany<AuditDbRow>('service_capability_audit', {
      org_id: orgId,
      project_id: projectId,
    }, { orderBy: [['occurred_at', 'desc']], limit: 200 });
    return rows.map(toAudit);
  }

  async #consumeConsent(
    ops: FactoryStorageOps,
    input: Omit<ServiceCapabilityConsentInput, 'consentHash' | 'issuedAt' | 'expiresAt'> & { hash: string; now: Date },
  ): Promise<boolean> {
    let consumed = false;
    await ops.updateAtomic<ConsentDbRow>(
      'service_capability_consents',
      { consent_hash: input.hash, org_id: input.orgId, project_id: input.projectId, user_id: input.userId },
      current => {
        if (
          current.consumed_at !== null ||
          current.expires_at.getTime() <= input.now.getTime() ||
          current.operation !== input.operation ||
          current.target_grant_id !== (input.targetGrantId ?? null) ||
          current.intent_digest !== input.intentDigest
        ) {
          return null;
        }
        consumed = true;
        return { consumed_at: input.now };
      },
    );
    return consumed;
  }

  async #recordWithin(ops: FactoryStorageOps, input: ServiceCapabilityAuditInput): Promise<void> {
    await ops.insertOne<AuditDbRow>('service_capability_audit', {
      grant_id: input.grantId,
      org_id: input.orgId,
      project_id: input.projectId,
      work_item_id: input.workItemId,
      principal_id: input.principalId,
      actor_id: input.actorId,
      action: input.action,
      request_id: input.requestId,
      body_fingerprint: input.bodyFingerprint,
      outcome: input.outcome,
      reason: input.reason,
      occurred_at: input.occurredAt,
    });
  }
}
