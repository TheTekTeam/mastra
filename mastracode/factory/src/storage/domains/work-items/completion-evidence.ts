/**
 * Source-only wire contract for independently attested GitHub issue completion.
 *
 * This canonical digest detects accidental row corruption; it is NOT a
 * signature, review approval, or verification of GitHub/HP6 state.
 * A route must additionally run its authenticated independent verifier
 * before returning a successful receipt.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid();
const sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);

export const issueCompletionPayloadSchema = z
  .object({
    ok: z.literal(true),
    source: z.literal('independent_native_issue_completion_readback'),
    kind: z.literal('issue_completion'),
    schemaVersion: z.literal(1),
    projectId: uuid,
    workItemId: uuid,
    workItemRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sourceRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    sourceIssueNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sourceVersion: z.string().min(1).max(256),
    sourceSnapshotId: z.string().min(1).max(256),
    pullRequestNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    headSha: sha40,
    reviewerIdentity: z.literal('modelspend-reviewer'),
    reviewHeadSha: sha40,
    ciHeadSha: sha40,
    mergeSha: sha40,
    nativeEffectId: uuid,
    acceptedAt: z.string().datetime(),
    finalEffectState: z.literal('completed'),
    executionVerified: z.literal(true),
    independentNativeCompletion: z.literal(true),
  })
  .strict()
  .refine(value => value.headSha === value.reviewHeadSha && value.headSha === value.ciHeadSha, {
    message: 'Review and CI must bind to the exact PR head',
  });

export const issueCompletionReceiptSchema = issueCompletionPayloadSchema.safeExtend({
  proofDigest: sha64,
});

export type IssueCompletionPayload = z.infer<typeof issueCompletionPayloadSchema>;
export type IssueCompletionReceipt = z.infer<typeof issueCompletionReceiptSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Digest is over the exact, closed, versioned payload excluding proofDigest. */
export function issueCompletionDigest(payload: IssueCompletionPayload): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/** No partial/legacy/unknown fields and no checksum mismatch are accepted. */
export function parseIssueCompletionReceipt(value: unknown): IssueCompletionReceipt | null {
  const parsed = issueCompletionReceiptSchema.safeParse(value);
  if (!parsed.success) return null;
  const { proofDigest, ...payload } = parsed.data;
  return issueCompletionDigest(payload) === proofDigest ? parsed.data : null;
}
