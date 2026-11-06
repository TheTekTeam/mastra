# PM #53 — PostgreSQL handover lease issuer source-only stage

Status: **DEFAULT OFF / NOT REGISTERED / NO LIVE KEYS OR ROUTES / NO ADOPTION.**

This separate Factory-side domain implements actual PostgreSQL transactions
for signed GP handover issue and revoke, but no production Factory instance
registers it. The service must supply all server-private trusted callbacks
before `enabled:true` is possible. The class rejects non-PG storage.

## Transaction ordering and proof

- A private invocation resolver supplies the exact selected Factory org and
  project; untrusted HTTP JSON is never a GP identity or scope.
- PostgreSQL B1 `factory_execution_epochs` project row `updateAtomic` is the
  **first PG row lock**. The exact same row serializes native `beginEffect`,
  lease issuance and GP revocation, across independent PG connections and OS
  processes. No PM or Factory row lock is taken before this epoch lock.
- Within that transaction the issuer verifies a **real Ed25519 signature**
  using a Factory-pinned public key, domain-separated canonical v1 packet,
  ten-second audience/key/issuer/selected-scope binding and PG
  `clock_timestamp()` (also rechecked immediately before commit).
- Independently verified GP HTTPS session, single-use v9 consent, unrevoked
  status, selected project, live PM singleton writer/epoch/heartbeat/pause and
  policy are required from an authenticated private PM authority readback.
  The required callback has **no production implementation in this PR**.
- The issuer locks the `factory_projects` row via native `updateAtomic` and
  confirms both automation flags are OFF at the exact signed revision.
- It independently traverses the actual PG project→GitHub connection→single
  repository link→numeric repository→installation chain. A separate
  authenticated current GitHub App installation grant must prove numeric
  owner/repository/installation identity before and after network reads.
  The grant callback is **not implemented for production**.
- B1 armed quiescing/mapping/coverage and externally verified same-transaction
  full native drain are required; B1 reservations must all be settled and the
  org's UNKNOWN origin quarantine must be empty. No TTL auto-clears UNKNOWN.
- The signed GP request, nonce, manifest, challenge, lease intent and owner/
  writer/authority epoch are unique PostgreSQL replay/ABA records. A lease
  insert and B1 epoch revision write commit atomically.
- GP revoke first writes a permanent PostgreSQL tombstone against the exact
  lease intent while holding the epoch lock, **even if issuance has not
  happened yet**. It revokes any active matching lease in the same transaction.
  A later issue cannot overtake or undo the tombstone. An effect already
  durably begun before revocation may finish/reconcile; it is not cancelled.

## Still required before production

1. Install a strongly authenticated, revocation-aware PM→Factory private
   bridge and owner-held Ed25519 key lifecycle (rotation, binding, audit).
2. Implement real injected PM writer/consent session resolver, Factory native
   session drain readback and independent GitHub App installation roster
   verifier. Test fixtures return synthetic claims, **not production proof**.
3. Prove every source-control link/relink mutation shares the relevant epoch
   or project/link lock order; an uncoordinated concurrent relink could change
   a binding after a read. Until proven, keep adoption disabled.
4. Add audited exact renewed consent/lease generation and safe re-handover
   after revocation/expiry. This initial issuer refuses any existing project
   lease record rather than overwriting it.
5. Install the private Core B2/B1 run resolver and complete provider-eager
   pre-network, remote Gateway typed one-use admission, generic HTTP,
   durability, queue/clone and actual effect receipt coverage. Unsupported
   paths continue to DENY in managed mode.
6. Complete independent PG18 two-OS-process barrier, crash/UNKNOWN, native
   project automation CAS, rollback/backup/restore and HTAI-only controlled
   acceptance. No production source merge or rollout grants writes.

The existing #40 `TestOnlyGpPgLeaseIssuer` remains untouched and test-only.
This separate class is not imported by service startup or HTTP routes. The
source may merge only after #39→#40 exact-head gates and HP6 independent review.
