# B1b independently verified native reservation settlement (PM #36)

This is an **unregistered, default-OFF** follow-up to inert B1 (#23). Factory
runtime does not construct `FactoryExecutionEpochStorage` with a receipt
resolver, expose `settleWithProof` via any route, arm native epochs or enable
project management. Production and service write grants remain unchanged.

## State and trust boundary

A durable B1 reservation is tied to exact
`(org,project,session,resource,thread,run,attempt,phase,epochRevision)`.
`reserved|running|suspended|unknown` all block project handover.
A timeout, process exit, stale heartbeat or elapsed TTL **never** settles it.
A different attempt ID on the same run remains denied while any earlier
attempt is unsettled, even after a process restart.

`settleWithProof({orgId,projectId,reservationId,receiptId})` accepts only a
**locator**. It does not accept a proof document, outcome flag, GP identity,
epoch or run claim from its caller. The resolver is injected through a
server-private constructor and must return an independently persisted,
immutable terminal receipt from the authoritative native effect ledger.
With no resolver (the default), settlement returns `not_ready`.

The injected receipt must bind every reservation identity field, exact
`epochRevision`, unique receipt ID, nonempty digest and trusted producer.
It may be either:

- `definitive_no_effect` (independent proof no irreversible effect began); or
- `terminal_effect` (independent readback verified terminal native effect).

Both require `allExternalEffectsReconciled=true` from the trusted producer.
A successful model response alone cannot settle a possibly executed external
tool or a remote/Gateway ambiguous side effect. Unknown/conflicting claims
return `needs_reconciliation` and retain the reservation.

## Atomicity and ordering

Within one FactoryStorage transaction, the method:

1. Locates exact org/project reservation and verifies immutable trusted
   proof. It refuses a changed receipt for an already settled attempt.
2. **Writes/CASes the project epoch row first**, bumping its monotonic
   revision. This serializes with concurrent `reserveNative` and
   `tryQuiesce` under PG READ COMMITTED.
3. CASes that exact reservation state to `settled`; on a stale update it
   throws to roll back the epoch increment.
4. Appends an immutable unique reservation↔receipt digest/producer row
   in `factory_execution_settlements`. Uniqueness forbids reuse of a receipt
   for another reservation. Transaction failure rolls back both status and
   evidence. Re-requesting the same receipt is an idempotent readback only.

An already quiescing epoch may accept terminal settlement evidence for a
previous native run; this does **not** reopen native dispatch or grant PM
ownership. B1 has no true exclusive handover lease or verified Core A2 hook.

The future Core adapter must obey the global lock order
**epoch → immutable source owner → thread advisory/row → reservation/evidence**.
A0 currently locks thread before a future epoch callback; this must be
redesigned and independently proven before enabling any combined guard.

## Migration, rollback and tests

The settlement ledger is an additive FactoryStorage collection. It is
created by this unregistered domain's `init` only. Existing reservations
retain their states; old readers tolerate the unused new table. No
migration rewrites prior UNKNOWN rows or invents proof.

If rolling back to code without B1b, preserve the settlement table and
reservation states; do not truncate proof evidence. A migration from a
pre-B1b snapshot must recreate the new table without reclassifying old
attempts. A damaged or missing settlement receipt leaves the reservation
blocking until independently reconciled.

Tests use disposable LibSQL and dedicated loopback PostgreSQL 18 database
`factory_b1b_qa`, never the installed Factory DB. Focused cases prove:

- No resolver/process-exit/unknown-state shortcut; fresh same-run attempt
  denied while previous UNKNOWN.
- Wrong owner/thread, cross-org, unreconciled external effect and untrusted
  producer fail closed.
- Exact proof settles once, stale epoch quiescence CAS rejected, unique
  append-only receipt remains.
- Two independent PostgreSQL pools racing distinct settlement receipts
  commit exactly one; settling races stale quiescence; two fresh attempts on
  one run admit at most one; close/reopen preserves UNKNOWN.

Remaining activation gates: actual trusted native effect producer and receipt
readback; provider/tool-specific external effect reconciliation; two **OS
process** crash barriers and backup/restore; Core modern/legacy/durable/
versioned/queued all-path A2 effect hook and positive provenance; owner ABA
revision, global lock ordering; native drain and GP PM lease/epoch attestation.
No change here enables HTAI handover or service capability grants.
