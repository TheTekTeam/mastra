# B1 V3 native StorageOps: WIP, not accepted

This is a **DRAFT, unmounted, default-OFF source contract**. No production
Factory import/registration, route, private GP mTLS session provider, PM V11
live epoch-chain reader, PM signer/key issuer, schema migration, or deployment
is supplied. A valid V3 packet or committed nonce never authorizes Factory
execution or lease handback.

## Proposed native operations

FactoryGpPgB1V3NativeStorageOps is a server-only StorageDomain with default
disabled constructor, no schema registration unless explicitly enabled by an
isolated test harness, and runtime PgFactoryStorage gate. It exposes:

1. revokeWithTombstone: obtains the native execution epoch row through
   withTransaction + updateAtomic, calls the server-private live GP
   session/origin/CSRF resolver under that lock, refuses stale GP proof,
   checks immutable original B1 lease, and appends the original revoke and
   generated revokeRequestId + canonical hash extension in the *same*
   transaction. No legacy tombstone retrofit.
2. mintOneUseChallenge: only after readback and rehash of the actual original
   B1 tombstone, create UUID + 256-bit nonce and maximum five-second PG-clock
   expiry under the same epoch row lock. This returns private challenge bytes
   to its injected SERVER caller. No HTTP route.
3. consumePrivateV3Nonce: under the same native epoch row lock, recheck the
   original B1 row, full canonical tombstone hash, challenge scope and clock;
   require an independently read PM V11 transition packet from a private
   provider and a pinned Ed25519 signature via the #57 inspector; then issue
   a unique challenge/revocation/nonce/scope/signed-packet consumption insert.
   The return is audit-only and never enables native execution.

All external trust providers are **absent**; no code outside this source
module constructs or registers the enabled class. The source-only constructor
throws if asked to enable without all private GP/PM providers. No V2 fallback.

## Real PostgreSQL 18 raw migration proposal, still uninstalled

The existing Factory CollectionSchema has only text, bigint, integer,
timestamp, json, boolean, and generated uuid-pk column kinds. It has **NO**
foreign-key or immutable-trigger declaration. Therefore ordinary
ensureCollections *cannot* establish physical B1 V3 authenticity or
append-only guarantees. Merely having a source TypeScript schema is not
permission to install it in production.

GP-B1-V3-PROPOSED-UP.sql is a separate exact-hash raw PostgreSQL proposal
that uses a stored generated UUID conversion of the source text revocation
ID, an exact six-field native B1 original-scope composite FK, unique
challenge/revoke/nonce/scope packet constraints and immutable UPDATE/DELETE
triggers (including the original legacy revocation). It is not referenced by
any migration dispatcher, and must never be auto-run in live Factory.

GP-B1-V3-PROPOSED-DOWN.sql is fail-closed. It first rejects rollback if any
V3 tombstone, challenge or nonce rows exist, then removes only the extension
tables/constraints/triggers; it never drops original B1 rows. Both SQL files
have literal SHA256s pinned in GP-B1-V3-PROPOSED-MANIFEST.json, checked by
verify-gp-b1-v3-proposal-hash.py.

The separate opt-in verify-gp-b1-v3-proposed-pg18.py uses only UID995 rootless
Docker on Dell, the locally cached pinned PostgreSQL 18.6 image, a random
ephemeral no-network container and unconditional cleanup. It tests actual
PG18 UP, exact-scope FK negative, immutable row triggers, restart
persistence, refusal to roll back nonempty ledgers and clean empty-ledger
DOWN in a second ephemeral database. It **does not execute Factory
StorageOps**, and its fixture is NOT a GP-authenticated live session.

From repository root, no privilege/network or live PG URI is needed:

~~~bash
python3 mastracode/factory/migrations/verify-gp-b1-v3-proposal-hash.py
FACTORY_GP_B1_V3_MIGRATION_PG18_EPHEMERAL=I_ACK_SOURCE_ONLY_EPHEMERAL \
  python3 mastracode/factory/migrations/verify-gp-b1-v3-proposed-pg18.py
~~~

## Confirmed blockers to real native acceptance

- On the isolated source head the core/PG packages have **no built dist**.
  The direct new native Vitest suite fails **before tests run**, with
  "Cannot find package '@mastra/core/storage'". Attempting
  pnpm --filter @mastra/core build:lib failed due existing unbuilt workspace
  dependencies and 2,991 lines of mostly pre-existing build diagnostics.
  No green claim.
- Actual FactoryStorageOps PG18 end-to-end tests with two independent
  Node processes, client loss/restart, original durable B1 row and PM
  signed packet are NOT yet qualified. #59 proves SQL-only model
  concurrent CAS; this PR proves raw proposed DDL semantics, not the
  actual class compatibility with its migration.
- The native Factory B1 epoch table has only string owner_epoch and
  revision, not the PM numeric current writer epoch and transition chain.
  That security-critical read must come from an independently authenticated
  PM V11 source under the PG lock; this source uses a mandatory private
  provider seam, but **no implementation exists**. No fake signer or
  caller-supplied boolean is accepted.
- Generated SQL proposals are NOT yet certified to agree with
  ensureCollections' DDL/type mapping or a future actual migration runner.
  Native enrollment needs exact-source migration hash verification, approved
  rollback and crash/race/fault injection, independent HP6 exact-head CI,
  and no-regression acceptance before any merge/activation.

**Do not merge, install the SQL, enable the class, add a route or advertise
Factory write/rebind capability on the strength of this WIP PR.**
