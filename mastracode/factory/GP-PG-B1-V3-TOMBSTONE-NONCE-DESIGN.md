# GP PostgreSQL B1 V3 tombstone and one-use nonce protocol (UNINSTALLED DESIGN)

Status: **source-only design; no schema registration, migration, runtime writer,
signed packet consumer, authenticated route, live key, or PostgreSQL acceptance**.
This must not be used as an acceptance gate or treated as installed functionality.

## Existing authoritative invariants

The native B1 reader in gp-pg-lease-issuer.ts uses a PostgreSQL epoch
updateAtomic row lock, verifies native writer/GP evidence, then writes the
immutable factory_gp_pg_handover_revocations row with a unique lease_intent_id.
That row has id UUID, org/project/lease/writer/owner-epoch text and created_at,
but NO V3 revokeRequestId, commit-time epoch revision or tombstone hash.
#57's Ed25519 inspector only validates a detached packet; even success grants
no authority. PM #80 only prepares/inspects unsigned V3 packet source. V2
preconsent/consumed cannot substitute for a V3 post-tombstone rebind.

The B1 V3 issuer MUST be constructed only by a separately qualified, explicit
feature-gated native PG service. It MUST hold the same native epoch PG row lock
before joining revocation and canonical tombstone records. A PM-supplied
revocation row, caller-held GP boolean, or public request body is never proof.

## Proposed PostgreSQL 18 DDL (NOT EXECUTED)

Illustrative DDL, not a ready-to-apply migration. Verify exact native table
names, DB roles, storage schema and transaction API on the pinned review head
before creating the migration. The historical B1 row is append-only and must
not be rewritten for V3; only fresh authentically generated rows qualify.

~~~sql
CREATE TABLE factory_gp_pg_v3_authenticated_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_revocation_row_id uuid NOT NULL UNIQUE
    REFERENCES factory_gp_pg_handover_revocations(id),
  revoke_request_id uuid NOT NULL UNIQUE,
  org_id text NOT NULL,
  factory_project_id text NOT NULL,
  lease_intent_id text NOT NULL UNIQUE,
  old_writer_owner_id text NOT NULL,
  owner_epoch text NOT NULL,
  pg_epoch_revision bigint NOT NULL CHECK (pg_epoch_revision > 0),
  committed_at_ms bigint NOT NULL CHECK (committed_at_ms > 0),
  tombstone_sha256 char(64) NOT NULL UNIQUE,
  CHECK (tombstone_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX factory_gp_pg_v3_tombstone_exact_scope
 ON factory_gp_pg_v3_authenticated_tombstones
 (org_id, factory_project_id, lease_intent_id, old_writer_owner_id, owner_epoch);

CREATE TABLE factory_gp_pg_v3_rebind_challenges (
  challenge_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  factory_project_id text NOT NULL,
  lease_intent_id text NOT NULL,
  factory_challenge_sha256 char(64) NOT NULL UNIQUE,
  tombstone_sha256 char(64) NOT NULL
    REFERENCES factory_gp_pg_v3_authenticated_tombstones(tombstone_sha256),
  issued_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  CHECK (expires_at_ms > issued_at_ms AND expires_at_ms <= issued_at_ms + 5000)
);
CREATE TABLE factory_gp_pg_v3_rebind_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL UNIQUE
    REFERENCES factory_gp_pg_v3_rebind_challenges(challenge_id),
  rebind_nonce_sha256 char(64) NOT NULL UNIQUE,
  nonce_scope_sha256 char(64) NOT NULL UNIQUE,
  revoke_request_id uuid NOT NULL UNIQUE
    REFERENCES factory_gp_pg_v3_authenticated_tombstones(revoke_request_id),
  factory_tombstone_sha256 char(64) NOT NULL,
  old_writer_owner_id text NOT NULL,
  old_writer_epoch bigint NOT NULL,
  new_writer_owner_id text NOT NULL,
  new_writer_epoch bigint NOT NULL,
  transition_chain_sha256 char(64) NOT NULL,
  signed_packet_digest char(64) NOT NULL UNIQUE,
  consumed_at_ms bigint NOT NULL,
  CHECK (new_writer_epoch > old_writer_epoch),
  CHECK (consumed_at_ms > 0)
);
~~~

Implement append-only privilege restrictions (no UPDATE or DELETE for the
runtime role), immutable row trigger and mutually checked native revocation
scope in the actual reviewed migration. DDL alone does NOT enforce integrity:
under the same lock, verify each foreign key's corresponding org/project/
lease/writer/epoch fields and check the committed hash from a Factory-generated
canonical serialization, not a caller string. All digest columns require
byte-exact lower-case 64-digit hex. PG-generated commit millisecond clock is
read from clock_timestamp(), not transaction-start now(). UUIDs are generated
server-side. A challenge belongs to the same fully scoped tombstone.

## Required transaction and lock order

1. **GP-authenticated native B1 revoke**: acquire native Factory epoch row
   via the same updateAtomic/SELECT FOR UPDATE path as issuance and beginEffect.
   Reject untrusted role, expired GP session, stale approval, wrong writer,
   absent explicit revoke request, or epoch mismatch. Validate the original
   lease and current PG writer under the epoch lock.
2. Insert original immutable B1 revocation and its new V3 tombstone extension
   **atomically in the same PostgreSQL transaction**. Derive revokeRequestId,
   originalRevocationRowId, DB commit clock and epoch revision on server.
   Canonicalize the ten-field tuple with
   FACTORY_GP_PG_B1_AUTHENTICATED_REVOKE_V3 + NUL domain separator and SHA256.
   If any insert aborts, neither record commits.
3. Only after committed tombstone, Factory privately creates a scoped one-use
   challenge with server-held 5-second maximum expiry and a persisted digest.
   It MUST NOT reuse an existing challenge ID or accept caller-provided nonce.
4. For rebind, acquire **native Factory epoch row first** (no PM or Factory
   storage lock beforehand). Fetch actual B1 revocation, V3 extension, challenge
   and current native writer from PG under lock. Require the exact committed
   tombstone hash and unconsumed, not-expired challenge (DB clock).
5. Over pinned and independently authenticated mTLS, verify PM V3 Ed25519
   signature with an enrolled pinned keyId, strict packet fields/bytes, audience,
   fresh TTL <=5s, matching Factory challenge, one-time nonce digest, current
   new-writer epoch, and full old-to-new epoch transition chain anchored in
   PM's authoritative V11 ledger. No V2 fallback, fake signer, shared secret,
   caller-injected key or unverifiable chain.
6. Within the SAME PG epoch-locked transaction, insert exactly one
   factory_gp_pg_v3_rebind_consumptions row. Unique challenge_id, nonce,
   nonce_scope, revoke_request_id and signed_packet_digest are database CAS
   barriers across concurrent requests/restarts. On unique conflict, rollback
   and return a uniformly non-authorizing replay response. Check expiry again
   immediately before insert against PG clock_timestamp().
7. Commit then emit an audit-only non-authorizing receipt. A separately
   reviewed native fence handback and end-to-end acceptance is necessary
   before any rebind could authorize Factory execution. Never issue a lease
   solely because signature or nonce was accepted.

## Replay, race and failure matrix (REQUIRED, NOT RUN HERE)

- PG18 two simultaneous sessions race for same challenge/nonce: EXACTLY one
  insert and commit, one conflict/reject, same epoch lock ordering; no double
  rebind or double lease.
- Replay after process crash/restart, repackaging packet, rotating signer,
  or preserving identical signature: same challenge, nonce or revokeRequestId
  cannot be consumed again.
- Tombstone mismatch: no real original B1 row, wrong orig ID, wrong project,
  wrong org, wrong lease, wrong writer/epoch, wrong timestamp, wrong revision,
  copied hash, mutated revokeRequestId or retrofitted legacy v1 tombstone
  all fail without a consumption write.
- Stale owner/challenge, expiry at exactly DB deadline, future clock, invalid
  keyId, wrong mTLS client, expired GP authority, duplicate chain hop,
  missing transition and V2 packet all fail closed.
- Writer changes between preflight and PG epoch lock: reject and retry from
  authenticated GP policy, never cached evidence.
- Inject failures before original revocation, between original and extension,
  before consumption insert, and immediately before commit. Assert atomicity,
  no split states and immutable ledger after restart.

Qualification requires fresh isolated ephemeral PostgreSQL 18.6 per-run
database/container, pinned digest, no production DB socket, exact source SHA,
real multi-session concurrency and crash/replay negative tests, local harness
cleanup in finally, strict TypeScript and independent exact-head HP6 review.
#240's rootless Docker harness is source-only and not currently generalized
or independently accepted for this new slice; do not reuse its test evidence.

## Current implemented boundary

gp-pg-b1-rebind-v3-protocol.ts provides deterministic, exact-field,
domain-separated **proposed digest functions only** and rejects accessors,
extra fields and malformed numeric/identity values. These pure functions do
NOT query PG, authenticate GP, verify mTLS, run CAS, install migrations or
consume anything. Its frozen capability declares ALL live controls false.

Activation prerequisite chain remains HP6 #240 -> A #41 -> B #32 -> MCP #25,
then Factory #39/#40/#44/#45/#46/#48/#49/#57 -> this design; paired PM #80
must independently qualify runtime signer with protected keys and proof of
current writer epoch. No branch in this stack is authority to merge/release
the downstream code.