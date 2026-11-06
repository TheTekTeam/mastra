# PostgreSQL thread persistence guard v1 — default OFF (PM #36 A0)

This is a **source-only protocol**, not Factory project handover authorization.
The v1 callback is optional on `PostgresStore` and runs in the **same
PostgreSQL transaction** as a thread save, update, copy/clone, resource move,
or delete. When it throws, the native mutation rolls back. With no callback
the existing native write path remains unchanged.

`PostgresStore.getThreadPersistenceGuardCapability()` identifies the exact
PG memory backend and reports its version, callback presence and covered
operations. **`adoptionReady` is hardcoded `false` in this slice.** A
callback can be a no-op, so simply installing one is not proof of
authenticated origin, complete Core coverage or cross-process session drain.

A future Factory-only activation must supply a server-owned callback that:

- obtains origin from verified BetterAuth/server-private execution context,
  not from client IDs, `resourceId`, metadata stamps, or a request-supplied
  `factorySessionId`;
- reads B2a candidate and immutable session/source owner revision inside the
  transaction, independently verifies Core memory persistence, and locks the
  selected project's B1 epoch row in that same PG transaction;
- fails closed on missing/uncertain/stale proof, source row changes, untrusted
  clones, revoked PM ownership or an unsupported backend. It must NOT assume
  unclassified/personal by absence;
- binds a stable attempt/run ID and native reservation epoch. No TTL
  automatically clears an uncertain memory creation or execution.

The PG implementation serializes same-ID guarded save/upsert attempts with a
transaction-level advisory lock and locks an existing thread row before
admission. Guarded clone/copy locks and revalidates its source within the
message-copy transaction and refuses an existing destination. Transfers lock
their source row in the native transaction. Run fences still check in the
guarded transaction. These locks prevent admission evidence from drifting
between a check and the corresponding thread write.

For Dell's Factory runtime, `PgFactoryStorage` wraps one PG pool and
`getMastraStorage()` returns a `PostgresStore` sharing that pool. A future
opt-in host may configure a `PostgresStore` with this callback and pass
that same store to `PgFactoryStorage({ store })`. The current
`PgFactoryStorage({ connectionString })` live setup does **not** install
this callback, and this PR does not modify Factory bootstrap.

## Still missing before management adoption

- B2b trusted Core thread-persistence reconciliation and all Factory ingress
  registrations, including current/recovered/clone/side/Slack sessions.
- Core A2 pre-model/tool execution admission for modern, legacy, durable,
  stored-version and queued/resumed paths. **Thread writes are not model or
  tool executions.**
- Full selected-project **message** write, deletion and other memory mutation
  policy; this v1 hook covers thread lifecycle operations listed above.
- Positive personal/unmanaged provenance for every remaining path; historical
  UNKNOWN must block adoption.
- A runtime capability negotiation that rejects LibSQL, external Gateway
  agent memory paths, missing/no-op policy or stale source/owner epoch.
  `adoptionReady:false` ensures this PR alone cannot satisfy that gate.
- Cross-process startup/lease/restart evidence and independent acceptance
  before any handover writer or production deployment.

Focused tests use a *separate disposable PG18 QA database*. They prove
transaction rollback, no-guard compatibility, client-stamp rejection via a
test-only private context predicate, clone/move/update/delete denial, and
two-PG-connection epoch/source contention. No live Factory configuration,
credentials, database, or scheduling state is changed.
