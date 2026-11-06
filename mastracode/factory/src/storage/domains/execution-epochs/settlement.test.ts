import { randomUUID } from 'node:crypto';

import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.js';
import {
  FACTORY_EXECUTION_EPOCHS_SCHEMA, FACTORY_EXECUTION_RESERVATIONS_SCHEMA,
  FACTORY_EXECUTION_SETTLEMENTS_SCHEMA, FactoryExecutionEpochStorage,
} from './base.js';
import type { TrustedEffectReceipt } from './base.js';

const qaUrl = process.env.B1B_PG_URL;
const PROOFS: CollectionSchema = {
  name: 'qa_b1b_independent_proofs',
  columns: {
    id: { type: 'uuid-pk' }, receipt_id: { type: 'text' },
    verified_payload: { type: 'json' }, producer_id: { type: 'text' },
    created_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'qa_b1b_proof_receipt_unique', columns: ['receipt_id'] }],
};
type ProofRow = { receipt_id: string; producer_id: string; verified_payload: TrustedEffectReceipt };
const resolveTrusted = async (ops: FactoryStorageOps, receiptId: string) => {
  const row = await ops.findOne<ProofRow>(PROOFS.name, { receipt_id: receiptId });
  // Only an independently owned test ledger qualifies. Callers cannot pass
  // a proof body to settleWithProof, and unknown producers fail closed.
  return row?.producer_id === 'trusted-qa-producer' ? row.verified_payload : null;
};

function open(kind: 'libsql' | 'pg', withResolver = true) {
  const storage = kind === 'pg'
    ? new PgFactoryStorage({ connectionString: qaUrl! })
    : new LibSQLFactoryStorage({ id: 'epoch-settlement-' + randomUUID(), url: ':memory:' });
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const epochs = storage.registerDomain(new FactoryExecutionEpochStorage(withResolver ? resolveTrusted : undefined));
  return { storage, projects, epochs, async init() {
    await storage.init(); await storage.ensureCollections([PROOFS]);
  }, async close() { await storage.close(); } };
}

async function seed(f: ReturnType<typeof open>) {
  const nonce = randomUUID();
  const orgId = 'org-' + nonce, userId = 'user-' + nonce;
  const project = await f.projects.create({ orgId, userId, input: { name: 'HTAI-' + nonce } });
  const scope = {
    orgId, projectId: project.id,
    sessionId: 'session-' + nonce, resourceId: 'resource-' + nonce, threadId: 'thread-' + nonce,
  };
  expect(await f.epochs.provisionUnarmed({ orgId, projectId: project.id })).toBe('created');
  expect(await f.epochs.bindThread(scope)).toBe('bound');
  // Future attestor is absent. This is a test-only positive arm after DB setup;
  // no runtime API can arm a project from B1b code.
  await f.storage.withTransaction(ops => ops.updateAtomic(
    FACTORY_EXECUTION_EPOCHS_SCHEMA.name, { org_id: orgId, factory_project_id: project.id },
    () => ({ fence_armed: true, coverage_version: 1, mapping_digest: 'test-only-attestation' }),
  ));
  const admitted = await f.epochs.reserveNative({
    ...scope, runId: 'run-' + nonce, attemptId: 'attempt-' + nonce, phase: 'start',
  });
  expect(admitted.status).toBe('reserved');
  if (admitted.status !== 'reserved') throw new Error('missing QA reservation');
  return { ...scope, ...admitted, runId: 'run-' + nonce, attemptId: 'attempt-' + nonce, phase: 'start' as const };
}

async function addProof(f: ReturnType<typeof open>, s: Awaited<ReturnType<typeof seed>>,
  changes: Partial<TrustedEffectReceipt> = {}, producerId = 'trusted-qa-producer') {
  const receiptId = 'receipt-' + randomUUID();
  const proof: TrustedEffectReceipt = {
    receiptId, orgId: s.orgId, projectId: s.projectId, sessionId: s.sessionId,
    resourceId: s.resourceId, threadId: s.threadId,
    runId: s.runId, attemptId: s.attemptId, phase: s.phase,
    epochRevision: s.revision, proofDigest: 'sha256-test-' + randomUUID(),
    producerId, proofKind: 'definitive_no_effect', allExternalEffectsReconciled: true,
    ...changes,
  };
  await f.storage.ops.insertOne(PROOFS.name, {
    receipt_id: receiptId, verified_payload: proof, producer_id: producerId,
    created_at: new Date(),
  });
  return receiptId;
}

describe('B1b inert verified settlement CAS on LibSQL', () => {
  it('never settles from process exit, a claimed proof, or absent trusted resolver', async () => {
    const f = open('libsql', false);
    await f.init();
    try {
      const s = await seed(f);
      await f.epochs.markUncertain({ orgId: s.orgId, projectId: s.projectId, reservationId: s.reservationId });
      expect(await f.epochs.settleWithProof({
        orgId: s.orgId, projectId: s.projectId, reservationId: s.reservationId, receiptId: 'user-claim',
      })).toBe('not_ready');
      expect(await f.epochs.reserveNative({
        orgId: s.orgId, projectId: s.projectId, sessionId: s.sessionId,
        resourceId: s.resourceId, threadId: s.threadId, runId: s.runId,
        attemptId: 'new-attempt', phase: 'resume',
      })).toEqual({ status: 'duplicate' });
      expect(await f.epochs.tryQuiesce({
        orgId: s.orgId, projectId: s.projectId, expectedRevision: 1, ownerEpoch: 'gp-owner',
      })).toBe('blocked');
    } finally { await f.close(); }
  });

  it('rejects stale/cross-org/uncertain receipts and settles only exact independently verified proof', async () => {
    const f = open('libsql');
    await f.init();
    try {
      const s = await seed(f);
      const forged = await addProof(f, s, { threadId: 'wrong-thread' });
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: forged })).toBe('needs_reconciliation');
      const uncertain = await addProof(f, s, { allExternalEffectsReconciled: false });
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: uncertain })).toBe('needs_reconciliation');
      const untrusted = await addProof(f, s, {}, 'untrusted-producer');
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: untrusted })).toBe('needs_reconciliation');
      const correct = await addProof(f, s);
      expect(await f.epochs.settleWithProof({ orgId: 'other-org', projectId: s.projectId,
        reservationId: s.reservationId, receiptId: correct })).toBe('not_ready');
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: correct })).toBe('settled');
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: correct })).toBe('already_settled');
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: forged })).toBe('conflict');
      expect(await f.storage.ops.findMany(FACTORY_EXECUTION_SETTLEMENTS_SCHEMA.name, {
        reservation_id: s.reservationId,
      })).toHaveLength(1);
      expect(await f.epochs.tryQuiesce({ orgId: s.orgId, projectId: s.projectId,
        expectedRevision: 1, ownerEpoch: 'gp-owner' })).toBe('conflict');
      expect(await f.epochs.tryQuiesce({ orgId: s.orgId, projectId: s.projectId,
        expectedRevision: 2, ownerEpoch: 'gp-owner' })).toBe('quiescing');
      // Simulate contradictory restored/corrupt status with a retained receipt:
      // the prior ledger alone must not claim the reservation is settled.
      await f.storage.ops.updateMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name,
        { id: s.reservationId }, { state: 'unknown' });
      expect(await f.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
        reservationId: s.reservationId, receiptId: correct })).toBe('needs_reconciliation');
    } finally { await f.close(); }
  });
});

(qaUrl ? describe : describe.skip)('B1b real PG18 independent-connection settlement', () => {
  it('competing receipts settle a reservation once; append evidence remains unique', async () => {
    const a = open('pg'); await a.init();
    const b = open('pg'); await b.init();
    try {
      const s = await seed(a);
      const one = await addProof(a, s);
      const two = await addProof(a, s);
      const out = await Promise.allSettled([one, two].map(receiptId =>
        (receiptId === one ? a : b).epochs.settleWithProof({
          orgId: s.orgId, projectId: s.projectId, reservationId: s.reservationId, receiptId,
        })));
      const results = out.map(r => r.status === 'fulfilled' ? r.value : 'error');
      expect(results.filter(x => x === 'settled')).toHaveLength(1);
      expect(await a.storage.ops.findMany(FACTORY_EXECUTION_SETTLEMENTS_SCHEMA.name,
        { reservation_id: s.reservationId })).toHaveLength(1);
      expect(await a.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name,
        { id: s.reservationId })).toMatchObject([{ state: 'settled' }]);
    } finally { await b.close(); await a.close(); }
  });

  it('serializes fresh same-run attempts and stale quiescence across two PG pools', async () => {
    const a = open('pg'); await a.init();
    const b = open('pg'); await b.init();
    try {
      const s = await seed(a);
      const receipt = await addProof(a, s);
      const [settle, staleQuiesce] = await Promise.all([
        a.epochs.settleWithProof({ orgId: s.orgId, projectId: s.projectId,
          reservationId: s.reservationId, receiptId: receipt }),
        b.epochs.tryQuiesce({ orgId: s.orgId, projectId: s.projectId,
          expectedRevision: 1, ownerEpoch: 'gp-owner' }),
      ]);
      expect(settle).toBe('settled');
      expect(['blocked', 'conflict']).toContain(staleQuiesce);
      // A new attempt ID may be scheduled only after the previous run was
      // independently settled. Two concurrent starts with the same runId
      // must still allow at most one new effect.
      const nextBase = {
        orgId: s.orgId, projectId: s.projectId, sessionId: s.sessionId,
        resourceId: s.resourceId, threadId: s.threadId, runId: s.runId,
        phase: 'resume' as const,
      };
      const [first, second] = await Promise.all([
        a.epochs.reserveNative({ ...nextBase, attemptId: 'next-A-' + randomUUID() }),
        b.epochs.reserveNative({ ...nextBase, attemptId: 'next-B-' + randomUUID() }),
      ]);
      expect([first, second].filter(x => x.status === 'reserved')).toHaveLength(1);
      expect([first, second].filter(x => x.status !== 'reserved')).toHaveLength(1);
      const reservations = await a.storage.ops.findMany<{ state: string }>(
        FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name,
        { org_id: s.orgId, factory_project_id: s.projectId, run_id: s.runId });
      expect(reservations.filter(x => x.state !== 'settled')).toHaveLength(1);
      const current = await a.epochs.getEpoch({ orgId: s.orgId, projectId: s.projectId });
      expect(await b.epochs.tryQuiesce({ orgId: s.orgId, projectId: s.projectId,
        expectedRevision: current!.revision, ownerEpoch: 'gp-owner' })).toBe('blocked');
    } finally { await b.close(); await a.close(); }
  });

  it('UNKNOWN survives reconnect; same-run fresh attempt denied until trustworthy reconciliation', async () => {
    const a = open('pg'); await a.init();
    const s = await seed(a);
    await a.epochs.markUncertain({ orgId: s.orgId, projectId: s.projectId,
      reservationId: s.reservationId });
    await a.close();
    const b = open('pg'); await b.init();
    try {
      expect(await b.epochs.reserveNative({
        orgId: s.orgId, projectId: s.projectId, sessionId: s.sessionId,
        resourceId: s.resourceId, threadId: s.threadId, runId: s.runId,
        attemptId: 'fresh-after-crash', phase: 'resume',
      })).toEqual({ status: 'duplicate' });
      expect(await b.epochs.tryQuiesce({
        orgId: s.orgId, projectId: s.projectId, expectedRevision: 1, ownerEpoch: 'gp-owner',
      })).toBe('blocked');
      expect(await b.storage.ops.findMany(FACTORY_EXECUTION_RESERVATIONS_SCHEMA.name,
        { id: s.reservationId })).toMatchObject([{ state: 'unknown' }]);
    } finally { await b.close(); }
  });
});
