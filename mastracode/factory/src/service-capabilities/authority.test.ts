import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, vi } from 'vitest';

import { FactoryProjectsStorage } from '../storage/domains/projects/base.js';
import { ServiceCapabilityStorage } from '../storage/domains/service-capabilities/base.js';

import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { ServiceCapabilityAuthority } from './authority.js';
import type { ServiceCapabilityIssueIntent, ServiceCapabilityPolicy } from './authority.js';

const ISSUE_AUTOMATION: ServiceCapabilityIssueIntent = {
  operation: 'issue',
  actions: ['projectAutomation.set'],
  workItemIds: [],
  enqueueProfiles: [],
  ttlSeconds: 3600,
};

async function scenario(url?: string) {
  const seed = await createFactoryStorageForTests(url ? { url, closeOnTestFinished: false } : {});
  const project = await seed.projects.create({
    orgId: 'verified-org', userId: 'gp-admin', input: { name: 'HTAI pilot' },
  });
  await seed.storage.ops.insertOne('service_capability_handover_leases', {
    org_id: 'verified-org',
    project_id: project.id,
    owner_kind: 'factory-project-manager',
    owner_epoch: 'test-epoch',
    automation_revision: project.automationRevision,
    pm_dispatch_paused_at: new Date('2029-12-31T23:58:00Z'),
    native_automation_paused_at: new Date('2029-12-31T23:59:00Z'),
    native_sessions_drained_at: new Date('2029-12-31T23:59:30Z'),
    evidence_digest: 'e'.repeat(64),
    issued_at: new Date('2030-01-01T00:00:00Z'),
    expires_at: new Date('2030-01-01T01:00:00Z'),
    revoked_at: null,
  });
  const policy: ServiceCapabilityPolicy = {
    enabled: true,
    hmacKey: randomBytes(32),
    adminOrigin: 'https://factory.example.test',
    allowedProjectIds: new Set([project.id]),
    allowedIssuerUserIds: new Set(['gp-admin']),
  };
  const authority = new ServiceCapabilityAuthority({
    storage: seed.serviceCapabilities, projects: seed.projects, policy,
  });
  return { seed, project, policy, authority };
}

describe('native service capability grant authority', () => {
  it('issues a 256-bit raw token once after exact project+issuer+intent consent and omits its digest from readback', async () => {
    const { seed, project, authority } = await scenario();
    const now = new Date('2030-01-01T00:00:00Z');
    const consentToken = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin', intent: ISSUE_AUTOMATION, now,
    });
    expect(consentToken).toMatch(/^fcc1_[A-Za-z0-9_-]{43}$/);
    const issued = await authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken, intent: ISSUE_AUTOMATION, now,
    });
    expect(issued.status).toBe('issued');
    if (issued.status !== 'issued') throw new Error('Expected exact consent grant');
    expect(issued.token).toMatch(/^fcp1_[A-Za-z0-9_-]{43}$/);
    expect(issued.grant).toMatchObject({
      orgId: 'verified-org', projectId: project.id,
      actions: ['projectAutomation.set'], workItemIds: [], enqueueProfiles: [], version: 1, revokedAt: null,
    });
    expect(issued.grant).not.toHaveProperty('tokenHash');

    const persisted = await seed.storage.ops.findOne<Record<string, unknown>>('service_capability_grants', {
      id: issued.grant.id,
    });
    expect(persisted?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(issued.token);
    expect(JSON.stringify(await authority.listGrants({ orgId: 'verified-org', projectId: project.id }))).not.toContain(
      String(persisted?.token_hash),
    );
    const duplicate = await authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken, intent: ISSUE_AUTOMATION, now,
    });
    expect(duplicate).toMatchObject({ status: 'denied', code: 'invalid_consent' });
    expect((await seed.serviceCapabilities.listGrants({ orgId: 'verified-org', projectId: project.id }))).toHaveLength(1);
  });

  it('allows exactly one concurrent issue for a single-use consent and rejects changed intent', async () => {
    const { seed, project, authority } = await scenario();
    const now = new Date('2030-01-01T00:00:00Z');
    const token = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin', intent: ISSUE_AUTOMATION, now,
    });
    expect(await authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken: token, intent: { ...ISSUE_AUTOMATION, ttlSeconds: 7200 }, now,
    })).toMatchObject({ status: 'denied', code: 'invalid_consent' });
    const outcomes = await Promise.all([1, 2].map(() => authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken: token, intent: ISSUE_AUTOMATION, now,
    })));
    expect(outcomes.map(value => value.status).sort()).toEqual(['denied', 'issued']);
    expect((await seed.serviceCapabilities.listGrants({ orgId: 'verified-org', projectId: project.id }))).toHaveLength(1);
  });

  it('validates every mutation from fresh persisted scope, records denial and fails closed if admission audit fails', async () => {
    const { seed, project, authority } = await scenario();
    const now = new Date('2030-01-01T00:00:00Z');
    const consentToken = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin', intent: ISSUE_AUTOMATION, now,
    });
    const issued = await authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken, intent: ISSUE_AUTOMATION, now,
    });
    if (issued.status !== 'issued') throw new Error('Expected exact consent grant');
    const input = {
      authorization: 'FactoryService ' + issued.token,
      action: 'projectAutomation.set' as const,
      projectId: project.id,
      requestId: '12345678-1234-4234-8234-123456789012',
      bodyFingerprint: 'a'.repeat(64),
      now: new Date(now.getTime() + 60_000),
    };
    const admitted = await authority.admit(input);
    expect(admitted.status).toBe('admitted');
    if (admitted.status !== 'admitted') throw new Error('Expected admitted mutation');
    expect(await authority.beginEffect({
      ...admitted.admission, role: 'plan',
    }, new Date(now.getTime() + 60_001))).toBe(false);
    expect(await authority.beginEffect(admitted.admission, new Date(now.getTime() + 60_001))).toBe(true);
    await authority.finish(admitted.admission, 'succeeded');
    expect(await authority.admit({ ...input, projectId: '12345678-1234-4234-8234-123456789011' })).toEqual({
      status: 'denied',
    });
    expect(await authority.admit({ ...input, action: 'workItem.enqueue', workItemId: project.id })).toEqual({
      status: 'denied',
    });
    expect(await authority.admit({ ...input, authorization: 'FactoryService not-a-token' })).toEqual({
      status: 'denied',
    });
    expect(await authority.admit({ ...input, now: new Date(now.getTime() + 3_700_000) })).toEqual({
      status: 'denied',
    });
    const audit = await seed.serviceCapabilities.listAudit({ orgId: 'verified-org', projectId: project.id });
    expect(audit.map(event => event.outcome)).toEqual(expect.arrayContaining(['admitted', 'succeeded', 'denied']));
    expect(JSON.stringify(audit)).not.toContain(issued.token);

    const mock = vi.spyOn(seed.serviceCapabilities, 'admitAndRecord').mockRejectedValueOnce(new Error('DB audit failed'));
    await expect(authority.admit(input)).rejects.toThrow('DB audit failed');
    mock.mockRestore();
  });

  it('revokes by a second fresh bound consent and continues to deny after database restart', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'factory-service-grant-'));
    const url = 'file:' + join(folder, 'factory.db');
    let first: Awaited<ReturnType<typeof scenario>> | undefined;
    let second: Awaited<ReturnType<typeof createFactoryStorageForTests>> | undefined;
    try {
      first = await scenario(url);
      const { project, authority, policy } = first;
      const now = new Date('2030-01-01T00:00:00Z');
      const issueConsent = await authority.beginConsent({
        orgId: 'verified-org', projectId: project.id, userId: 'gp-admin', intent: ISSUE_AUTOMATION, now,
      });
      const issued = await authority.issueGrant({
        orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
        consentToken: issueConsent, intent: ISSUE_AUTOMATION, now,
      });
      if (issued.status !== 'issued') throw new Error('Expected grant for revoke');
      const revokeIntent = { operation: 'revoke' as const, targetGrantId: issued.grant.id };
      const revokeConsent = await authority.beginConsent({
        orgId: 'verified-org', projectId: project.id, userId: 'gp-admin', intent: revokeIntent, now,
      });
      expect(await authority.revokeGrant({
        orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
        consentToken: revokeConsent, intent: revokeIntent, now,
      })).toBe('revoked');
      expect(await authority.revokeGrant({
        orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
        consentToken: revokeConsent, intent: revokeIntent, now,
      })).toBe('denied');

      await first.seed.storage.close();
      first = undefined;
      second = await createFactoryStorageForTests({ url, closeOnTestFinished: false });
      const recovered = new ServiceCapabilityAuthority({
        projects: second.projects, storage: second.serviceCapabilities, policy: {
          ...policy,
        },
      });
      // The reopened row must remain revoked independent of any in-memory token cache.
      expect((await second.serviceCapabilities.getGrant({
        orgId: 'verified-org', projectId: project.id, grantId: issued.grant.id,
      }))?.revokedAt).toEqual(now);
      expect(await recovered.admit({
        authorization: 'FactoryService ' + issued.token,
        action: 'projectAutomation.set',
        projectId: project.id,
        requestId: '12345678-1234-4234-8234-123456789012',
        bodyFingerprint: 'a'.repeat(64),
        now: new Date(now.getTime() + 120_000),
      })).toEqual({ status: 'denied' });
    } finally {
      await first?.seed.storage.close();
      await second?.storage.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('atomically fences admissions after revocation while retaining already-issued in-flight evidence', async () => {
    const { seed, project, authority } = await scenario();
    const now = new Date('2030-01-01T00:00:00Z');
    const consentToken = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      intent: ISSUE_AUTOMATION, now,
    });
    const issued = await authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken, intent: ISSUE_AUTOMATION, now,
    });
    if (issued.status !== 'issued') throw new Error('Expected grant');
    const mutation = {
      authorization: 'FactoryService ' + issued.token,
      action: 'projectAutomation.set' as const,
      projectId: project.id,
      requestId: 'abcdef01-1234-4234-8234-123456789012',
      bodyFingerprint: 'b'.repeat(64),
      now: new Date(now.getTime() + 1_000),
    };
    const beforeRevoke = await authority.admit(mutation);
    if (beforeRevoke.status !== 'admitted') throw new Error('Expected atomic pre-revoke admission');
    const revokeIntent = { operation: 'revoke' as const, targetGrantId: issued.grant.id };
    const revokeConsent = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      intent: revokeIntent, now: new Date(now.getTime() + 1_001),
    });
    expect(await authority.revokeGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken: revokeConsent, intent: revokeIntent, now: new Date(now.getTime() + 1_002),
    })).toBe('revoked');
    // A revocation fences new admissions; it cannot cancel an already
    // admitted in-flight effect. It must be explicitly finalized/reconciled.
    expect(await authority.admit({ ...mutation, now: new Date(now.getTime() + 1_003) }))
      .toEqual({ status: 'denied' });
    const journalBeforeOutcome = await seed.serviceCapabilities.listAudit({
      orgId: 'verified-org', projectId: project.id,
    });
    expect(journalBeforeOutcome.some(e => e.requestId === mutation.requestId && e.outcome === 'admitted')).toBe(true);
    expect(await authority.beginEffect(beforeRevoke.admission, new Date(now.getTime() + 1_004))).toBe(false);
    await authority.finish(beforeRevoke.admission, 'rejected', 'revoked_before_effect');
    const journal = await seed.serviceCapabilities.listAudit({ orgId: 'verified-org', projectId: project.id });
    expect(journal.some(e => e.requestId === mutation.requestId && e.outcome === 'denied')).toBe(true);
    expect(journal.some(e => e.requestId === mutation.requestId && e.outcome === 'rejected')).toBe(true);
    expect(JSON.stringify(journal)).not.toContain(issued.token);
  });

  it('permits only a pre-revocation durable effect start to finish after grant revocation', async () => {
    const { seed, project, authority } = await scenario();
    const now = new Date('2030-01-01T00:00:00Z');
    const issueConsent = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin', intent: ISSUE_AUTOMATION, now,
    });
    const issued = await authority.issueGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      consentToken: issueConsent, intent: ISSUE_AUTOMATION, now,
    });
    if (issued.status !== 'issued') throw new Error('Expected issue');
    const admitted = await authority.admit({
      authorization: 'FactoryService ' + issued.token,
      action: 'projectAutomation.set', projectId: project.id,
      requestId: '88888888-8888-4888-8888-888888888888', bodyFingerprint: 'c'.repeat(64),
      now: new Date(now.getTime() + 1_000),
    });
    if (admitted.status !== 'admitted') throw new Error('Expected admission');
    expect(await authority.beginEffect(admitted.admission, new Date(now.getTime() + 2_000))).toBe(true);
    expect(await authority.beginEffect(admitted.admission, new Date(now.getTime() + 3_000))).toBe(false);
    const revocation = { operation: 'revoke' as const, targetGrantId: issued.grant.id };
    const revokeConsent = await authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      intent: revocation, now: new Date(now.getTime() + 3_001),
    });
    expect(await authority.revokeGrant({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      intent: revocation, consentToken: revokeConsent, now: new Date(now.getTime() + 3_002),
    })).toBe('revoked');
    expect(await seed.serviceCapabilities.listUnsettledEffectLeases({
      orgId: 'verified-org', projectId: project.id,
    })).toHaveLength(1);
    await authority.finish(admitted.admission, 'effect_unverified', 'awaiting_independent_native_receipt');
    expect(await seed.serviceCapabilities.listUnsettledEffectLeases({
      orgId: 'verified-org', projectId: project.id,
    })).toHaveLength(1);
    // Only independently reconciled outcomes may settle an uncertain lease.
    await authority.finish(admitted.admission, 'succeeded', 'native_receipt_verified');
    expect(await seed.serviceCapabilities.listUnsettledEffectLeases({
      orgId: 'verified-org', projectId: project.id,
    })).toHaveLength(0);
    const audits = await seed.serviceCapabilities.listAudit({ orgId: 'verified-org', projectId: project.id });
    expect(audits.some(a => a.outcome === 'effect_started')).toBe(true);
    expect(audits.some(a => a.outcome === 'revoked')).toBe(true);
    expect(audits.some(a => a.outcome === 'succeeded')).toBe(true);
  });

  it('migrates a pre-service Factory DB and restores an untouched backup with grants default empty', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'factory-service-schema-upgrade-'));
    const legacyUrl = 'file:' + join(folder, 'legacy.db');
    const backupPath = join(folder, 'backup.db');
    let first: LibSQLFactoryStorage | undefined;
    let migrated: LibSQLFactoryStorage | undefined;
    let restored: LibSQLFactoryStorage | undefined;
    try {
      first = new LibSQLFactoryStorage({ id: 'legacy-factory-test', url: legacyUrl });
      const originalProjects = first.registerDomain(new FactoryProjectsStorage());
      await first.init();
      const project = await originalProjects.create({
        orgId: 'verified-org', userId: 'gp-admin', input: { name: 'Pre-capability project' },
      });
      await first.close();
      first = undefined;
      await copyFile(join(folder, 'legacy.db'), backupPath);

      migrated = new LibSQLFactoryStorage({ id: 'upgraded-factory-test', url: legacyUrl });
      const projects = migrated.registerDomain(new FactoryProjectsStorage());
      const capabilityStorage = migrated.registerDomain(new ServiceCapabilityStorage());
      await migrated.init();
      expect(await projects.get({ orgId: 'verified-org', id: project.id })).toMatchObject({
        id: project.id, name: 'Pre-capability project',
      });
      expect(await capabilityStorage.listGrants({ orgId: 'verified-org', projectId: project.id })).toEqual([]);
      expect(await capabilityStorage.listUnsettledEffectLeases({
        orgId: 'verified-org', projectId: project.id,
      })).toEqual([]);
      await migrated.close();
      migrated = undefined;

      // Recovery uses the exact pre-upgrade disk snapshot, not a schema downgrade.
      restored = new LibSQLFactoryStorage({
        id: 'restored-factory-test', url: 'file:' + backupPath,
      });
      const recoveredProjects = restored.registerDomain(new FactoryProjectsStorage());
      const recoveredCapabilities = restored.registerDomain(new ServiceCapabilityStorage());
      await restored.init();
      expect(await recoveredProjects.get({ orgId: 'verified-org', id: project.id })).toMatchObject({
        id: project.id, name: 'Pre-capability project',
      });
      expect(await recoveredCapabilities.listGrants({
        orgId: 'verified-org', projectId: project.id,
      })).toEqual([]);
    } finally {
      await first?.close();
      await migrated?.close();
      await restored?.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('does not permit cross-tenant or widened issuance intent, wrong issuer, weak key or HTTP origin', async () => {
    const { project, authority, seed } = await scenario();
    expect(authority.trustedAdminOrigin('https://factory.example.test')).toBe(true);
    expect(authority.trustedAdminOrigin('http://factory.example.test')).toBe(false);
    expect(authority.trustedAdminOrigin('https://evil.example.test')).toBe(false);
    await expect(authority.beginConsent({
      orgId: 'other-org', projectId: project.id, userId: 'gp-admin', intent: ISSUE_AUTOMATION,
    })).rejects.toThrow('project not found');
    await expect(authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'member', intent: ISSUE_AUTOMATION,
    })).rejects.toThrow('not allowed');
    await expect(authority.beginConsent({
      orgId: 'verified-org', projectId: project.id, userId: 'gp-admin',
      intent: { ...ISSUE_AUTOMATION, actions: ['workItem.enqueue'], workItemIds: [] },
    })).rejects.toThrow('not allowed');
    expect(() => new ServiceCapabilityAuthority({
      storage: seed.serviceCapabilities, projects: seed.projects,
      policy: { enabled: true, hmacKey: randomBytes(16), adminOrigin: 'https://factory.example.test',
        allowedProjectIds: new Set([project.id]), allowedIssuerUserIds: new Set(['gp-admin']) },
    })).toThrow('256 bits');
  });
});
