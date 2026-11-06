# Core A2d: inert PostgreSQL managed-effect admission contract

PM #36 / Factory draft A2d, stacked on Core A2c (#33) plus B1b verified
settlement source (#29). This is **not** a production adoption or handover
capability. Live Core remains hard-disabled and no production route, GP lease
writer, trusted run resolver, coverage attestor, or receipt producer registers
this storage domain. Normal Factory projects retain their existing behavior.

## Exact transaction boundary

The `FactoryManagedCoreEffectStorage.beginEffect()` domain is PG-only.
It requires `FactoryStorageOps.databaseNow()` bound to the **same PG
transaction client** as the epoch write-CAS. LibSQL and remote backends
deny. The future Factory server must inject a **DB-only, server-private**
trusted Core run resolver; no request/thread metadata may define org,
project, session, user, owner epoch, run or attempt. The resolver has no
default implementation. Caller-echoed identifiers deny.

1. Resolve private verified run identity. Lock/write B1
   `factory_execution_epochs` row **first** under the PG transaction.
2. Require `state=quiescing`, armed coverage version 1, exact immutable
   mapping digest and matching owner epoch. B1's native `reserveNative()`
   remains denied while quiescing.
3. Require a PG lease for that exact org/project, writer, lease ID,
   owner epoch, GP consent/policy digests, mapping digest, coverage version,
   native automation revision, active state and DB-clock unexpired TTL.
   There is no source writer for this row; isolated tests provision one.
4. Recheck native project automation flags OFF, exact revision, B1 immutable
   thread scope, B2b VERIFIED origin, source-control session owner/org/project
   and visibility, and absence of historical UNKNOWN quarantine.
5. Reject same attempt or unsettled same-run reservations. On success,
   increment the same epoch revision and append a B1 reservation with an
   exact run/attempt binding in the **same commit**.
6. No timeout clears a reservation. A lost response, process exit or
   uncertain provider/tool effect blocks re-delivery until independently
   verified `settleWithProof()` B1b receipt; no producer is yet installed.

A future lease **revoker** must acquire/write the same epoch row BEFORE
marking the lease revoked. This fences new BEGIN transactions across
processes; a BEGIN committed before revocation is an in-flight effect that
may still finish and must be reconciled. Revocation cannot cancel already
issued external effects. Tests exercise simultaneous BEGIN/revoke with
independent PostgreSQL pools and two separate OS processes.

## Boundaries and intentionally unsupported routes

Only the four model/provider or shared native tool effect boundaries can
request BEGIN: modern model, modern native tool, legacy model and legacy
native tool. The A2c earlier agent/dynamic-model/queued/durable checkpoints
are **not** authorized by this adapter. Synchronous clone/signal, external
Gateway, provider-eager network calls, generic direct SDK bypass, unsupported
memory backends and unclassified origins deny whenever a future managed
enforcement mode is considered. Source-only fixture tests do not prove
those routes comprehensively intercepted.

The consolidation adds a **test-only** private AsyncLocalStorage bridge under
`NODE_ENV=test` for real Core provider/tool/early checkpoint denial tests.
It is never installed by a live Factory service and has no production
runtimeMode setter, grant or project adoption route. Positive test results
prove only the PG transaction contract, not a runnable managed project.
B2b's memory-row provenance still does not prove a complete `LiveSessions`
inventory, authoritative PM epoch or independently drained sessions.

## Still mandatory before any managed activation

- GP-authenticated single-use consent, complete selected-project scope,
  signed/verified manager epoch and revocable PG lease issuance/heartbeat;
  PM's SQLite v8 projection alone is not PG authority.
- B2b verified-origin-to-B1 scope registration for every selected project
  thread, unknown historical quarantine and globally consistent
  **epoch -> thread -> source** lock order with two-process deadlock tests.
- A2a/b/c actual Core gateway installation with unforgeable in-process scope,
  a bounded no-async gap between BEGIN and external effect, abort/retry
  semantics and enforcement at every durable/legacy/queued/generic HTTP
  entrypoint. Deny remote Gateway and provider-eager unsupported capabilities.
- Independent terminal/no-effect receipt producer and B1b verifier; until
  then every admitted attempt is conservatively unsettled after crash.
- Production schema migration/backup/restore, versioned runtime capability
  negotiation, GP-approved HTAI pilot, exact-head CI/HP6 security review.
- No source merge, deploy, autonomous dispatch or production write grants
  implied by this draft.

Focused PG18 proof DB: disposable `factory_a2d_qa`, separate from all live
and other QA databases. The tests include stale/revoked/expired leases,
native-unpause, source drift, request spoof, uncertain replay, two-pool
contention, two-OS-process begin-vs-revoke and process-exit/restart.
