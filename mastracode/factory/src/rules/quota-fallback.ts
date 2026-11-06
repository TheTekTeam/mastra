import type { FactoryQuotaSource } from '../storage/domains/work-items/base.js';

/**
 * A native policy resolver is the only authority that may nominate another
 * provider. No resolver is installed by default. It must verify current
 * project policy, capability, credential entitlement and exact branch/PR head
 * before issuing a grant; the dispatcher independently fences stored identity.
 */
export interface FactoryQuotaFallbackRequest {
  orgId: string;
  factoryProjectId: string;
  workItemId: string;
  workItemRevision: number;
  bindingId: string;
  threadId: string;
  branch: string;
  source: FactoryQuotaSource;
}

export interface FactoryQuotaFallbackGrant {
  orgId: string;
  factoryProjectId: string;
  workItemId: string;
  workItemRevision: number;
  bindingId: string;
  threadId: string;
  branch: string;
  modelId: string;
  credentialScope: 'factory' | 'user';
  ownerUserId: string;
  /** The native resolver checked this Factory's explicit opt-in policy. */
  projectPolicyApproved: true;
  /** The run role and required tools fit the candidate model. */
  capabilityVerified: true;
  /** An existing, valid credential in the same exclusive scope is available. */
  credentialVerified: true;
  /** The original repository/PR head was re-read and remains unchanged. */
  headVerified: true;
  /** The already-authorised provider is healthy, within quota and entitled without metered spend. */
  existingEntitlementVerified: true;
}

export type FactoryQuotaFallbackResolver = (
  request: FactoryQuotaFallbackRequest,
) => Promise<FactoryQuotaFallbackGrant | null>;

/** Fail closed on stale or incomplete grants, even from an injected resolver. */
export function validatedQuotaFallback(
  request: FactoryQuotaFallbackRequest,
  grant: FactoryQuotaFallbackGrant | null,
): string | null {
  if (!grant ||
      grant.projectPolicyApproved !== true ||
      grant.capabilityVerified !== true ||
      grant.credentialVerified !== true ||
      grant.headVerified !== true ||
      grant.existingEntitlementVerified !== true) return null;
  for (const key of ['orgId', 'factoryProjectId', 'workItemId', 'workItemRevision',
    'bindingId', 'threadId', 'branch'] as const) {
    if (grant[key] !== request[key]) return null;
  }
  if (grant.credentialScope !== request.source.credentialScope ||
      grant.ownerUserId !== request.source.ownerUserId) return null;
  const separator = grant.modelId.indexOf('/');
  if (separator <= 0 || separator === grant.modelId.length - 1) return null;
  const provider = grant.modelId.slice(0, separator);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider) ||
      provider === request.source.providerId ||
      grant.modelId === request.source.modelId) return null;
  return grant.modelId;
}
