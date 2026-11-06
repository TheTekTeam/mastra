import { describe, expect, it } from 'vitest';

import type { FactoryQuotaFallbackGrant, FactoryQuotaFallbackRequest } from './quota-fallback.js';
import { validatedQuotaFallback } from './quota-fallback.js';

const request: FactoryQuotaFallbackRequest = {
  orgId: 'org-1',
  factoryProjectId: 'factory-1',
  workItemId: 'work-1',
  workItemRevision: 12,
  bindingId: 'binding-1',
  threadId: 'thread-1',
  branch: 'factory/issue-1',
  source: {
    providerId: 'anthropic',
    modelId: 'anthropic/claude-opus',
    credentialScope: 'user',
    ownerUserId: 'user-1',
    bindingId: 'binding-1',
    branch: 'factory/issue-1',
    workItemRevision: 12,
  },
};
const grant: FactoryQuotaFallbackGrant = {
  orgId: request.orgId,
  factoryProjectId: request.factoryProjectId,
  workItemId: request.workItemId,
  workItemRevision: request.workItemRevision,
  bindingId: request.bindingId,
  threadId: request.threadId,
  branch: request.branch,
  modelId: 'openai/gpt-6',
  credentialScope: 'user',
  ownerUserId: 'user-1',
  projectPolicyApproved: true,
  capabilityVerified: true,
  credentialVerified: true,
  headVerified: true,
  existingEntitlementVerified: true,
};

describe('native provider fallback grant fencing', () => {
  it('accepts an exact, authorised subscription-compatible alternate', () => {
    expect(validatedQuotaFallback(request, grant)).toBe('openai/gpt-6');
  });

  it.each([
    ['missing', null],
    ['wrong organisation', { orgId: 'org-2' }],
    ['wrong Factory project', { factoryProjectId: 'factory-2' }],
    ['wrong work item', { workItemId: 'work-2' }],
    ['stale card revision', { workItemRevision: 11 }],
    ['stale binding', { bindingId: 'binding-2' }],
    ['wrong thread', { threadId: 'thread-2' }],
    ['changed branch', { branch: 'factory/other' }],
    ['cross-scope credential', { credentialScope: 'factory' }],
    ['other credential owner', { ownerUserId: 'user-2' }],
    ['same provider', { modelId: 'anthropic/claude-haiku' }],
    ['malformed model', { modelId: 'gpt-6' }],
    ['unauthorised project policy', { projectPolicyApproved: false }],
    ['unsupported capability', { capabilityVerified: false }],
    ['unverified credential', { credentialVerified: false }],
    ['changed PR head', { headVerified: false }],
    ['unverified paid entitlement', { existingEntitlementVerified: false }],
  ])('denies %s', (_label, override) => {
    expect(validatedQuotaFallback(
      request,
      override === null ? null : { ...grant, ...override } as FactoryQuotaFallbackGrant,
    )).toBeNull();
  });
});
