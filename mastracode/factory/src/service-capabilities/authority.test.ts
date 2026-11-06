import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { ServiceCapabilityAuthority } from './authority.js';
import type { ServiceCapabilityIssueIntent, ServiceCapabilityPolicy } from './authority.js';

const ISSUE_AUTOMATION: ServiceCapabilityIssueIntent = {
  operation: 'issue',
  actions: ['projectAutomation.set'],
  workItemIds: [],
  ttlSeconds: 3600,
};

async function scenario(url?: string) {
  const seed = await createFactoryStorageForTests(url ? { url, closeOnTestFinished: false } : {});
  const project = await seed.projects.create({
    orgId: 'verified-org', userId: 'gp-admin', input: { name: 'HTAI pilot' },
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
      actions: ['projectAutomation.set'], workItemIds: [], version: 1, revokedAt: null,
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

    const mock = vi.spyOn(seed.serviceCapabilities, 'recordAudit').mockRejectedValueOnce(new Error('DB audit failed'));
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
