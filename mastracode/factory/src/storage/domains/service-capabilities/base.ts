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
export interface ServiceEnqueueProfile {
  workItemId: string;
  role: string;
  skillName: string;
  argumentsDigest: string;
}

export interface ServiceCapabilityGrant {
  id: string;
  principalId: string;
  orgId: string;
  projectId: string;
  actions: ServiceCapabilityAction[];
  workItemIds: string[];
  enqueueProfiles: ServiceEnqueueProfile[];
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
  outcome: 'admitted' | 'effect_started' | 'denied' | 'succeeded' | 'rejected' | 'effect_unverified' | 'issued' | 'revoked';
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
    enqueue_profiles: { type: 'json' },
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

/**
 * Trusted handover attestation (schema only). This PR deliberately exposes
 * NO writer or provisioning route. Until a separately accepted PM/HP6 bridge
 * proves an exclusive paused/drained handover and persists this row, EVERY
 * service mutation fails closed at beginEffect.
 */
export const SERVICE_CAPABILITY_HANDOVER_LEASES_SCHEMA: CollectionSchema = {
  name: 'service_capability_handover_leases',
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    owner_kind: { type: 'text' },
    owner_epoch: { type: 'text' },
    automation_revision: { type: 'integer' },
    pm_dispatch_paused_at: { type: 'timestamp' },
    native_automation_paused_at: { type: 'timestamp' },
    native_sessions_drained_at: { type: 'timestamp' },
    evidence_digest: { type: 'text' },
    issued_at: { type: 'timestamp' },
    expires_at: { type: 'timestamp' },
    revoked_at: { type: 'timestamp', nullable: true },
  },
  uniqueIndexes: [{ name: 'service_capability_handover_project_unique', columns: ['org_id', 'project_id'] }],
};

export const SERVICE_CAPABILITY_EFFECT_LEASES_SCHEMA: CollectionSchema = {
  name: 'service_capability_effect_leases',
  columns: {
    id: { type: 'uuid-pk' },
    grant_id: { type: 'text' },
    grant_version: { type: 'integer' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    work_item_id: { type: 'text', nullable: true },
    action: { type: 'text' },
    request_id: { type: 'text' },
    body_fingerprint: { type: 'text' },
    admitted_at: { type: 'timestamp' },
    start_by: { type: 'timestamp' },
    started_at: { type: 'timestamp', nullable: true },
    settled_at: { type: 'timestamp', nullable: true },
    outcome: { type: 'text', nullable: true },
  },
  uniqueIndexes: [{ name: 'service_capability_one_intent_per_request', columns: ['grant_id', 'action', 'request_id'] }],
  indexes: [
    { name: 'service_capability_leases_project', columns: ['org_id', 'project_id', 'admitted_at'] },
  ],
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
  enqueue_profiles: ServiceEnqueueProfile[];
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
interface HandoverDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  owner_kind: string;
  owner_epoch: string;
  automation_revision: number;
  pm_dispatch_paused_at: Date;
  native_automation_paused_at: Date;
  native_sessions_drained_at: Date;
  evidence_digest: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface LeaseDbRow extends Record<string, unknown> {
  id: string;
  grant_id: string;
  grant_version: number;
  org_id: string;
  project_id: string;
  work_item_id: string | null;
  action: ServiceCapabilityAction;
  request_id: string;
  body_fingerprint: string;
  admitted_at: Date;
  start_by: Date;
  started_at: Date | null;
  settled_at: Date | null;
  outcome: string | null;
}
export interface ServiceCapabilityEffectLease {
  id: string;
  grantId: string;
  grantVersion: number;
  orgId: string;
  projectId: string;
  action: ServiceCapabilityAction;
  requestId: string;
  workItemId: string | null;
  admittedAt: Date;
  startBy: Date;
  startedAt: Date | null;
  settledAt: Date | null;
  outcome: string | null;
}
function toLease(row: LeaseDbRow): ServiceCapabilityEffectLease {
  return {
    id: row.id, grantId: row.grant_id, grantVersion: row.grant_version,
    orgId: row.org_id, projectId: row.project_id, workItemId: row.work_item_id,
    action: row.action, requestId: row.request_id, admittedAt: row.admitted_at,
    startBy: row.start_by, startedAt: row.started_at, settledAt: row.settled_at,
    outcome: row.outcome,
  };
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
    enqueueProfiles: row.enqueue_profiles,
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
  'principalId' | 'orgId' | 'projectId' | 'actions' | 'workItemIds' | 'enqueueProfiles' | 'tokenHash' | 'issuedByUserId' | 'issuedAt' | 'expiresAt'
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
      await ops.deleteMany('service_capability_effect_leases', {});
      await ops.deleteMany('service_capability_handover_leases', {});
      await ops.deleteMany('service_capability_consents', {});
      await ops.deleteMany('service_capability_grants', {});
    });
  }

  async init(): Promise<void> {
    await this.ensureCollections([
      SERVICE_CAPABILITY_GRANTS_SCHEMA,
      SERVICE_CAPABILITY_CONSENTS_SCHEMA,
      SERVICE_CAPABILITY_AUDIT_SCHEMA,
      SERVICE_CAPABILITY_EFFECT_LEASES_SCHEMA,
      SERVICE_CAPABILITY_HANDOVER_LEASES_SCHEMA,
    ]);
  }

  /**
   * One durable admission boundary. A revocation and an admission serialize on
   * the same Factory database; a revoked token can never receive a *new*
   * admission. Already-admitted in-flight effects require outcome reconciliation.
   */
  async admitAndRecord(input: {
    tokenHash: string | null;
    expectedGrantId: string | null;
    action: ServiceCapabilityAction;
    projectId: string;
    workItemId: string | null;
    projectAllowed: boolean;
    requestId: string;
    bodyFingerprint: string;
    role?: string;
    skillName?: string;
    argumentsDigest?: string;
    now?: Date;
  }): Promise<{ grant: ServiceCapabilityGrant; lease: ServiceCapabilityEffectLease } | null> {
    return this.storage.withTransaction(async ops => {
      // Use the transactional admission instant, not a stale preflight time.
      const admissionNow = input.now ?? new Date();
      const row = input.tokenHash && input.expectedGrantId
        ? await ops.findOne<GrantDbRow>('service_capability_grants', {
            token_hash: input.tokenHash,
            id: input.expectedGrantId,
          })
        : null;
      const projectExists = row && input.projectAllowed && row.project_id === input.projectId
        ? Boolean(await ops.findOne('factory_projects', { org_id: row.org_id, id: row.project_id }))
        : false;
      const allowed = Boolean(
        row &&
        projectExists &&
        row.revoked_at === null &&
        row.issued_at.getTime() <= admissionNow.getTime() &&
        row.expires_at.getTime() > admissionNow.getTime() &&
        row.actions.includes(input.action) &&
        (input.action !== 'workItem.enqueue' ||
          (Boolean(input.workItemId) &&
           row.enqueue_profiles.some(profile =>
             profile.workItemId === input.workItemId &&
             profile.role === input.role &&
             profile.skillName === input.skillName &&
             profile.argumentsDigest === input.argumentsDigest))),
      );
      // A request identity belongs to one immutable intent. Never replay even
      // an identical request automatically after a crash or uncertain effect.
      const prior = row
        ? await ops.findOne<LeaseDbRow>('service_capability_effect_leases', {
            grant_id: row.id, action: input.action, request_id: input.requestId,
          })
        : null;
      const fresh = allowed && !prior;
      const lease = fresh && row
        ? await ops.insertOne<LeaseDbRow>('service_capability_effect_leases', {
            grant_id: row.id,
            grant_version: row.version,
            org_id: row.org_id,
            project_id: row.project_id,
            work_item_id: input.workItemId,
            action: input.action,
            request_id: input.requestId,
            body_fingerprint: input.bodyFingerprint,
            admitted_at: admissionNow,
            start_by: new Date(admissionNow.getTime() + 15_000),
            started_at: null,
            settled_at: null,
            outcome: null,
          })
        : null;
      await this.#recordWithin(ops, {
        grantId: row?.id ?? null,
        orgId: row?.org_id ?? null,
        projectId: row?.project_id ?? null,
        workItemId: input.workItemId,
        principalId: row?.principal_id ?? null,
        actorId: row?.principal_id ?? null,
        action: input.action,
        requestId: input.requestId,
        bodyFingerprint: input.bodyFingerprint,
        outcome: fresh ? 'admitted' : 'denied',
        reason: prior ? (prior.body_fingerprint === input.bodyFingerprint
          ? 'duplicate_request_requires_reconciliation'
          : 'request_id_conflict') : (fresh ? null : 'invalid_or_out_of_scope'),
        occurredAt: admissionNow,
      });
      return fresh && row && lease ? { grant: toGrant(row), lease: toLease(lease) } : null;
    });
  }

  /** A revocation fences new native starts. Issued in-flight leases may finish later. */
  async beginEffect(input: {
    leaseId: string;
    grantId: string;
    grantVersion: number;
    orgId: string;
    projectId: string;
    action: ServiceCapabilityAction;
    requestId: string;
    bodyFingerprint: string;
    now?: Date;
  }): Promise<boolean> {
    return this.storage.withTransaction(async ops => {
      const now = input.now ?? new Date();
      const lease = await ops.findOne<LeaseDbRow>('service_capability_effect_leases', {
        id: input.leaseId, grant_id: input.grantId, grant_version: input.grantVersion,
        org_id: input.orgId, project_id: input.projectId, action: input.action,
        request_id: input.requestId, body_fingerprint: input.bodyFingerprint,
      });
      if (!lease || lease.started_at || lease.settled_at || lease.start_by.getTime() <= now.getTime()) return false;
      const grant = await ops.findOne<GrantDbRow>('service_capability_grants', {
        id: input.grantId, org_id: input.orgId, project_id: input.projectId,
      });
      if (!grant || grant.version !== input.grantVersion ||
          grant.revoked_at || grant.issued_at.getTime() > now.getTime() ||
          lease.admitted_at.getTime() > now.getTime() ||
          grant.expires_at.getTime() <= now.getTime()) return false;
      const handover = await ops.findOne<HandoverDbRow>('service_capability_handover_leases', {
        org_id: input.orgId, project_id: input.projectId,
      });
      const project = await ops.findOne<{ automation_revision: number } & Record<string, unknown>>(
        'factory_projects', { org_id: input.orgId, id: input.projectId },
      );
      if (!handover || !project ||
          handover.owner_kind !== 'factory-project-manager' ||
          !handover.owner_epoch.trim() ||
          !/^[a-f0-9]{64}$/.test(handover.evidence_digest) ||
          handover.revoked_at !== null ||
          handover.issued_at.getTime() > now.getTime() ||
          handover.expires_at.getTime() <= now.getTime() ||
          handover.automation_revision !== project.automation_revision ||
          handover.native_automation_paused_at.getTime() > handover.issued_at.getTime() ||
          handover.native_sessions_drained_at.getTime() > handover.issued_at.getTime() ||
          handover.pm_dispatch_paused_at.getTime() > handover.issued_at.getTime()) return false;
      let started = false;
      await ops.updateAtomic<LeaseDbRow>('service_capability_effect_leases', { id: lease.id }, current => {
        if (current.started_at || current.settled_at || current.start_by.getTime() <= now.getTime()) return null;
        started = true;
        return { started_at: now };
      });
      if (!started) return false;
      await this.#recordWithin(ops, {
        grantId: lease.grant_id, orgId: lease.org_id, projectId: lease.project_id,
        workItemId: lease.work_item_id, principalId: grant.principal_id, actorId: grant.principal_id,
        action: lease.action, requestId: lease.request_id,
        bodyFingerprint: lease.body_fingerprint, outcome: 'effect_started',
        reason: null, occurredAt: now,
      });
      return true;
    });
  }

  /** Settle one immutable lease and journal its outcome in the same transaction. */
  async finishEffect(input: {
    leaseId: string;
    grantId: string;
    outcome: 'succeeded' | 'rejected' | 'effect_unverified';
    reason: string | null;
    now?: Date;
  }): Promise<void> {
    await this.storage.withTransaction(async ops => {
      const now = input.now ?? new Date();
      const row = await ops.findOne<LeaseDbRow>('service_capability_effect_leases', {
        id: input.leaseId, grant_id: input.grantId,
      });
      if (!row || row.settled_at || (input.outcome === 'succeeded' && !row.started_at)) {
        throw new Error('Service effect lease missing, already settled or never started');
      }
      let settled = false;
      await ops.updateAtomic<LeaseDbRow>('service_capability_effect_leases', { id: row.id }, current => {
        if (current.settled_at || (input.outcome === 'effect_unverified' && current.outcome === 'effect_unverified')) {
          return null;
        }
        settled = true;
        // Unknown native effect is *not* final settlement: keep it visible in
        // durable open-lease reconciliation after a crash/restart.
        return input.outcome === 'effect_unverified'
          ? { outcome: 'effect_unverified' }
          : { settled_at: now, outcome: input.outcome };
      });
      if (!settled) throw new Error('Service effect lease settlement lost concurrent race');
      const grant = await ops.findOne<GrantDbRow>('service_capability_grants', {
        id: row.grant_id, org_id: row.org_id, project_id: row.project_id,
      });
      await this.#recordWithin(ops, {
        grantId: row.grant_id, orgId: row.org_id, projectId: row.project_id,
        workItemId: row.work_item_id, principalId: grant?.principal_id ?? null,
        actorId: grant?.principal_id ?? null, action: row.action, requestId: row.request_id,
        bodyFingerprint: row.body_fingerprint, outcome: input.outcome,
        reason: input.reason, occurredAt: now,
      });
    });
  }

  /** No automatic lease replay. An operator must reconcile unsettled effects after restart. */
  async listUnsettledEffectLeases(input: { orgId: string; projectId: string }): Promise<ServiceCapabilityEffectLease[]> {
    const rows = await this.ops.findMany<LeaseDbRow>('service_capability_effect_leases', {
      org_id: input.orgId, project_id: input.projectId, settled_at: null,
    }, { orderBy: [['admitted_at', 'asc']] });
    return rows.map(toLease);
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
        enqueue_profiles: grant.enqueueProfiles,
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
