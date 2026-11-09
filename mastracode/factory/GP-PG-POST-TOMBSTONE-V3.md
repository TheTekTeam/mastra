# Factory post-tombstone PM writer rebind v3 — source-only contract

This is an **unmounted, non-authorising prototype** paired with the source-only
[Project Manager v11/v3 design](https://github.com/TheTekTeam/factory-project-manager/pull/80).
It must **not** be enabled in the running Factory or used as a completion receipt.

## Delivered in this slice

- gp-pg-post-tombstone-v3.ts strictly inspects the **new** domain-separated
  PM_TO_FACTORY_PRIVATE_GP_REBIND_V3 plus NUL canonical Ed25519 packet with a
  server-held pinned public key and key ID.
- It rejects wrong version, audience, phase, key, factory challenge, original
  organisation/project/repository/App/consent/manifest/lease scope, old/new writer epochs,
  transition chain digest, real tombstone digest, rebind nonce, non-canonical signatures
  and expired or future-dated proof against Factory's supplied database time.
- Every comparison is to an expected Factory-side value, not an asserted value in
  the untrusted packet. Test coverage uses genuine Ed25519 signatures.
- A successfully inspected signature returns **authorizesFactoryWrites:false**.
  The module is not imported or registered by Factory production source.

## Deliberately NOT delivered and therefore activation blockers

1. **Authentic B1 tombstone.** Draft Factory #49's current immutable revocation row
   stores leaseIntentId, original writer and owner epoch, but not the unique
   revokeRequestId or a canonical factoryTombstoneSha256. A v3 issuer must write
   these fields from a genuinely authenticated GP mTLS revoke under the **same**
   PostgreSQL epoch lock. Do not derive them from an HTTP body, generic revoked
   lease state, mutable log, guessed timestamp or cached sidecar.
2. **One-use Factory challenge and nonce CAS.** A new owner-private PG ledger must
   uniquely bind Factory UUID challenge, challenge digest, rebind nonce,
   project/org/lease, old/new writer epoch and packet digest, with unique indexes,
   bounded expiry, and committed consume in the same B1 updateAtomic lock as
   tombstone + current native state reads. No in-memory set or signature-only
   replay check qualifies.
3. **Current writer proof.** PM #80 implements an offline-only v11 immutable
   writer-transition chain; no live PM signer exists. Factory must independently
   pin and recheck the new writer owner/epoch, complete old-to-new transition
   chain and native B1 scope before accepting any PM v3 packet.
4. **Pinned mTLS/private entrypoint.** A new explicit v3 endpoint, with mutual
   certificate pin and fixed payload framing, must be independently qualified.
   V2 preconsent/consumed must remain unchanged; no v2 fallback after revoke.
5. **Authenticated GP session.** PM must sign only after fresh real GP
   HTTPS Origin/cookie/CSRF/one-use session nonce verification, durable v8/v9
   consent/revocation checks, zero unsettled intents, and owner-private v11
   writer CAS under BEGIN IMMEDIATE.
6. **Real tests and release acceptance.** PG18 cross-process one-use, race,
   expiry-during-lock, restart, TLS, wrong-project, stale-head, missing tombstone,
   duplicate nonce and loss-of-ACK tests plus independent HP6 exact-head
   code/security review and rollback evidence. The isolated pure-module tests
   here are not substitute production evidence.

The actual Factory A→B→MCP chain and #39→#40→#44→#45→#46→#48→#49
must qualify in their own exact-head order first. This file is a contract
checkpoint, not acceptance or a migration specification.

Rollback of this source-only PR is a normal revert. Since no service or schema
is installed, there is no operational state to roll back. Never silently apply
a future PG migration to live state without a backup and forward-compatible
recovery plan.
