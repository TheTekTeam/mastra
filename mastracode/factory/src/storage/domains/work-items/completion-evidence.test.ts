import { describe, expect, it } from 'vitest';

import {
  issueCompletionDigest,
  issueCompletionPayloadSchema,
  parseIssueCompletionReceipt,
} from './completion-evidence.js';

const payload = {
  ok: true,
  source: 'independent_native_issue_completion_readback',
  kind: 'issue_completion',
  schemaVersion: 1,
  projectId: 'e184905a-bda5-4adb-8a4a-af64602dcda3',
  workItemId: '11111111-1111-4111-8111-111111111111',
  workItemRevision: 7,
  sourceRepository: 'TheTekTeam/HTAI',
  sourceIssueNumber: 42,
  sourceVersion: 'factory_0_25_issue_v1',
  sourceSnapshotId: 'd'.repeat(64),
  pullRequestNumber: 67,
  headSha: 'a'.repeat(40),
  reviewerIdentity: 'modelspend-reviewer',
  reviewHeadSha: 'a'.repeat(40),
  ciHeadSha: 'a'.repeat(40),
  mergeSha: 'b'.repeat(40),
  nativeEffectId: '22222222-2222-4222-8222-222222222222',
  acceptedAt: '2026-11-06T13:30:00.000Z',
  finalEffectState: 'completed',
  executionVerified: true,
  independentNativeCompletion: true,
} as const;

function receipt(overrides: Record<string, unknown> = {}) {
  const candidate = { ...payload, ...overrides };
  return { ...candidate, proofDigest: issueCompletionDigest(candidate as typeof payload) };
}

describe('immutable native issue completion evidence schema', () => {
  it('accepts only its closed versioned canonical payload and checksum', () => {
    const exact = receipt();
    expect(issueCompletionPayloadSchema.safeParse(payload).success).toBe(true);
    expect(parseIssueCompletionReceipt(exact)).toEqual(exact);
    expect(issueCompletionDigest(Object.fromEntries(Object.entries(payload).reverse()) as typeof payload))
      .toBe(exact.proofDigest);
    expect(parseIssueCompletionReceipt({ ...exact, unverified: true })).toBeNull();
  });

  it('rejects forged proof digest and divergent review/CI head', () => {
    expect(parseIssueCompletionReceipt({ ...receipt(), proofDigest: '0'.repeat(64) })).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ reviewHeadSha: 'c'.repeat(40) }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ ciHeadSha: 'c'.repeat(40) }))).toBeNull();
  });

  it('rejects unpinned source version, snapshot and native work-item revision', () => {
    expect(parseIssueCompletionReceipt(receipt({ sourceVersion: 'github_issue_updated_at' }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ sourceSnapshotId: 'not-a-sha256' }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ workItemRevision: 0 }))).toBeNull();
  });

  it('rejects unsigned completion assertions and mismatched reviewer', () => {
    expect(parseIssueCompletionReceipt(receipt({ executionVerified: false }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ independentNativeCompletion: false }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ reviewerIdentity: 'other-bot' }))).toBeNull();
  });

  it('rejects malformed repository, issue, effect and immutable field omissions', () => {
    expect(parseIssueCompletionReceipt(receipt({ sourceRepository: 'HTAI' }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ sourceIssueNumber: -1 }))).toBeNull();
    expect(parseIssueCompletionReceipt(receipt({ nativeEffectId: 'not-a-uuid' }))).toBeNull();
    const missing = receipt();
    delete (missing as Record<string, unknown>).mergeSha;
    expect(parseIssueCompletionReceipt(missing)).toBeNull();
  });
});
