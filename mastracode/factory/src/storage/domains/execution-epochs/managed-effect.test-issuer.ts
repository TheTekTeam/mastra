import { createHash } from 'node:crypto';

import type { FactoryStorageOps } from '@mastra/core/storage';
import type { PgFactoryStorage } from '@mastra/pg';

import { FACTORY_EXECUTION_EPOCHS_SCHEMA } from './base.js';
import { FACTORY_CORE_MANAGER_LEASES_SCHEMA } from './managed-effect.js';

type VerifiedTestGp = {
  orgId: string;
  gpUserId: string;
  managerWriterId: string;
  consentNonce: string;
};
/**
 * Strictly TEST-ONLY GP consent/lease fixture. The private principal resolver
 * is injected by a test runner; arbitrary JSON caller claims cannot issue
 * or revoke. No production route, export from Factory runtime or token exists.
 */
export class TestOnlyGpPgLeaseIssuer {
  constructor(
    private readonly pgStorage: PgFactoryStorage,
    private readonly verifiedGp: (privateContext: object) => VerifiedTestGp | null,
  ) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('GP lease test issuer cannot run outside isolated tests');
    }
  }

  async issue(input: {
    privateContext: object;
    projectId: string;
    ownerEpoch: string;
    leaseId: string;
    ttlSeconds: number;
  }): Promise<'issued' | 'denied'> {
    const gp = this.verifiedGp(input.privateContext);
    if (
      !gp ||
      !gp.orgId ||
      !gp.gpUserId ||
      !gp.managerWriterId ||
      !gp.consentNonce ||
      !input.projectId ||
      !input.ownerEpoch ||
      !input.leaseId ||
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > 600
    )
      return 'denied';

    return this.pgStorage.withTransaction(async (ops: FactoryStorageOps) => {
      if (!ops.databaseNow) return 'denied';
      const where = { org_id: gp.orgId, factory_project_id: input.projectId };
      let issued = false;
      // Same-row epoch CAS before any lease/project lookup or effect start;
      // this is the exact future issuer/revoker lock-order contract.
      await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, where, async epoch => {
        if (
          epoch.state !== 'quiescing' ||
          epoch.owner_epoch !== input.ownerEpoch ||
          !epoch.fence_armed ||
          epoch.coverage_version !== 1 ||
          !epoch.mapping_digest
        )
          return null;
        const project = await ops.findOne<Record<string, unknown>>('factory_projects', {
          id: input.projectId,
          org_id: gp.orgId,
        });
        if (!project || project.created_by !== gp.gpUserId || project.auto_run_enabled || project.auto_approve_plans)
          return null;
        if (await ops.findOne(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where)) return null;
        const now = await ops.databaseNow!();
        const consentDigest = createHash('sha256')
          .update(
            JSON.stringify([
              'GP-TEST-CONSENT-v1',
              gp.orgId,
              gp.gpUserId,
              input.projectId,
              input.ownerEpoch,
              input.leaseId,
              gp.managerWriterId,
              gp.consentNonce,
            ]),
          )
          .digest('hex');
        const policyDigest = createHash('sha256')
          .update(
            JSON.stringify([
              'GP-TEST-POLICY-v1',
              gp.orgId,
              input.projectId,
              input.ownerEpoch,
              project.automation_revision,
            ]),
          )
          .digest('hex');
        await ops.insertOne(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, {
          ...where,
          lease_id: input.leaseId,
          manager_writer_id: gp.managerWriterId,
          owner_epoch: input.ownerEpoch,
          gp_consent_digest: consentDigest,
          policy_digest: policyDigest,
          mapping_digest: epoch.mapping_digest,
          automation_revision: project.automation_revision,
          coverage_version: 1,
          state: 'active',
          expires_at: new Date(now.getTime() + input.ttlSeconds * 1000),
          created_at: now,
          updated_at: now,
        });
        issued = true;
        return { revision: Number(epoch.revision) + 1, updated_at: now };
      });
      return issued ? 'issued' : 'denied';
    });
  }

  async revoke(input: { privateContext: object; projectId: string; leaseId: string }): Promise<boolean> {
    const gp = this.verifiedGp(input.privateContext);
    if (!gp) return false;
    return this.pgStorage.withTransaction(async ops => {
      if (!ops.databaseNow) return false;
      const where = { org_id: gp.orgId, factory_project_id: input.projectId };
      let revoked = false;
      await ops.updateAtomic(FACTORY_EXECUTION_EPOCHS_SCHEMA.name, where, async epoch => {
        const lease = await ops.findOne<Record<string, unknown>>(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where);
        if (
          !lease ||
          lease.lease_id !== input.leaseId ||
          lease.manager_writer_id !== gp.managerWriterId ||
          lease.state !== 'active'
        )
          return null;
        await ops.updateMany(FACTORY_CORE_MANAGER_LEASES_SCHEMA.name, where, {
          state: 'revoked',
          updated_at: await ops.databaseNow!(),
        });
        revoked = true;
        return { revision: Number(epoch.revision) + 1 };
      });
      return revoked;
    });
  }
}
