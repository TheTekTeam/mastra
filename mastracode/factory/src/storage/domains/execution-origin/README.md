# Factory execution origin candidates — inert B2a (PM #36)

This directory is a **source-only, unregistered storage foundation**. It has no
Factory runtime caller, HTTP route, Core callback, project handover writer, or
production migration. It neither authorizes execution nor classifies a thread
as managed, unmanaged or personal.

## Trust and identity contract

1. A future Factory server integration must resolve the BetterAuth principal
   from its **private authenticated request context**. Never accept a principal,
   organization or project claim from the request body, session metadata,
   thread ID, or a user-writable `factorySessionId` stamp.
2. The issuer looks up the server-owned `source_control_sessions` record by
   session ID and checks exact `org_id` and `user_id` against that principal,
   then checks `factory_project_id` belongs to that organization. Nullable
   projects, unsupported side/Slack origins and unverified visibility are
   quarantined as UNKNOWN.
3. Only the server generates a 256-bit random thread ID and a distinct random
   attestation anchor. The anchor is an **opaque correlation identifier, not a
   bearer credential**; knowing it never grants execution permission.
4. The transaction saves an immutable candidate with
   `pending_memory_effect` **before** any future Core thread-memory write.
   The response cannot attest that memory was persisted. Retrying the same
   `(org, session, requestId)` returns `effect_unverified`, never replays an
   ambiguous memory creation. Clone attempts require a separately verified
   parent and are denied while all B2a candidates are pending.
5. The explicit migration-only quarantine enumerates old source sessions under
   a specified organization, stores durable UNKNOWN evidence, and makes them
   ineligible for fresh candidate issuance. It is intentionally never run
   automatically in B2a, and no absence of a row is positive provenance.

The issuer accepts a `privateServerContext: unknown` only so a *future*
integration can inject an actual verified BetterAuth resolver. This package
does **not** implement that integration. Tests use an unforgeable WeakMap
fixture; copying the visible principal object does not authenticate.

## Crash and race conservatism

A crash after candidate insertion but before Core persistence leaves the
candidate pending forever. There is no TTL clearance, automatic replay or
self-promotion. Unique DB indexes prohibit a duplicate request or anchor.
Historical UNKNOWN rows are immutable per session and survive restart.
Concurrent requests can yield a DB unique/busy error; they must **never**
produce two successful candidate issuances for the same request.

The immutable issuer's `kind_at_issue=unverified` is deliberately not a
management policy decision. When a Factory project is later selected, future
Core admission must consult the **current** project epoch instead of trusting
an old candidate label.

## B2b PG memory reconciliation — still inert

The separate `FactoryOriginMemoryReconciler` is a server-private adapter
that couples a B2a candidate to **one** A0 PostgreSQL `MemoryPG.saveThread`
transaction. It is not imported into Factory bootstrap, not wired to Core or
BetterAuth, not exposed via HTTP and never enables `adoptionReady`.

- Only a future verified BetterAuth server path can call
  `issueAndWrite(privateContext, trustedMemoryWriter)`. The candidate anchor
  remains inside an `AsyncLocalStorage` context and must never be serialized
  to client code. The PG callback requires that exact one-use context; caller
  metadata, session stamps, project/thread IDs and copied principals are
  insufficient.
- The same PG transaction locks the pending origin candidate and rechecks
  exact server-owned source row, organization, owner, project, visibility,
  branch, source/side status, existing project, and historical UNKNOWN
  quarantine. It records `state=verified` **inside** the native thread
  insertion transaction. Any callback or INSERT failure rolls back both.
- `verified` means **one PG memory row was reconciled to one issued source
  candidate**. It is NOT execution admission, an active session proof,
  positive managed/unmanaged/personal classification, or a PM handover
  attestation. No B1 scope/epoch is armed or written.
- A lost response, callback failure or uncertain commit is always reported as
  `effect_unverified`; the same request is never replayed. A separate trusted
  readback must check origin and memory rows before any later action.
- Source ownership lacks a native monotonic CAS revision in frozen 0.25;
  the transaction checks the current tuple and locks it through memory
  insertion, but cannot prove an ABA sequence before that lock. Activation
  requires owner-revision fencing across *all* source owner/project mutation
  paths. A0's current thread-before-epoch lock order also requires correction
  before B1 epoch admission can be combined safely.

PG18 focused tests cover forged direct writes, candidate+memory atomic commit,
source owner/project drift, rollback, UNKNOWN quarantine, restart persistence
and same-request no-replay. They use a disposable QA database only.

**Not covered:** native Core execution/resume (A2), generic memory HTTP,
direct Gateway remote agents, legacy/durable/stored-version execution,
message/tool effects, session-start fencing or cross-process epoch
handovers. Unsupported providers and unclassified history must fail closed
for any future selected-project adoption. This B2b slice is intentionally
*not an activation-ready guard*.

## Prerequisites before any activation

- **B2b**: Verify all Factory ingress sources (human, side, Slack, API,
  queued) and bind a server-owned session/trace to Core's common
  `persistThreadRow` *before* any model/tool effect. Persist a durable
  two-sided reconciliation receipt; never derive proof from client-writable
  thread metadata.
- Ensure all personal/non-Factory paths receive independent *positive*
  authenticated origin proof. Unknown or ambiguous pre-existing sessions
  must block adoption rather than silently fall into a personal exemption.
- **A2**: Cover modern, durable, legacy and stored-version Agent
  stream/generate/resume, tool suspension, and queued wake with a native
  fail-closed execution guard. Deny every unclassified attempt.
- **B3**: Prove real PG18 cross-process restart races, reservation
  completeness, manager lease/epoch heartbeat, native drain and
  service-capability revocation fencing. Only then can PM #31 consider a
  handover attestation. This B2a work provides none of those guarantees.

Tests use isolated LibSQL and do not write to the live Factory DB. The schema
is additive and not registered with `FactoryStorage` bootstrap.
