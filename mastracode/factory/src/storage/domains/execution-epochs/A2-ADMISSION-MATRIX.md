# Core A2 execution admission — default-off P0 contract (PM #36)

This is a **source-only, disabled scaffold**, stacked on inert B1/B2a/A0/B2b.
`pre-effect-capability.ts` is not registered or exported from Factory bootstrap.
Every requested effect is rejected by `runWithInertCoreFence`, and
`adoptionReady=false` remains immutable even when an untrusted caller supplies
an all-green capability document. This does not protect live Factory execution;
it is a proposed contract for a subsequent comprehensive native integration.

## Actual 0.25 ingress / effect matrix

| Entrypoint | Source owner or thread provenance | Effect path / current gap |
| --- | --- | --- |
| Agent modern `generate` | `packages/core/src/agent/agent.ts:9629` | Delegates durable at 9649; otherwise workflow model/tool; no B1 reserve at model boundary. |
| Agent modern `stream` | `agent.ts:10443` | Delegates durable at 10463; stream-until-idle continuation reenters; no central native fence. |
| Agent legacy `generateLegacy/streamLegacy` | Agent older V1 API | Separate LLM workflow and run logic; modern-hook-only would miss them. |
| Agent `resumeStream`, approval/decline | `agent.ts:10816,11261,11599` | Durable delegate, suspended tool and rehydrated snapshot can trigger an effect without initial creation. |
| Agent stored versions | server resolves versioned agent | Delegation may instantiate independent Agent/LLM; must negotiate the exact backend and guard per invocation. |
| AgentController session creation | `agent-controller.ts:526` | `createSession` is NOT sufficient: cached and reconstructed sessions, switch/rebind, deferred thread creation. |
| Session `sendMessage` | `session.ts:5380` | Native model/tool path, but source IDs/tags may be caller-provided; requires B2b trusted source + stable run binding. |
| Suspended tool / approval | `session.ts:5855,5976` | Approval and `respondToToolSuspension` may resume a tool effect without a fresh model request. |
| Queued wake / subscription | Factory `rules/dispatcher.ts`; `tools/deliver.ts`, `integrations/subscription-session.ts` | Can wake existing session after restart; process-local LiveSessions is not durable evidence. |
| Side/clone sessions | `SessionThread` create/clone; Factory side/Slack/subscription paths | B2a currently quarantines side/Slack. A0 guards PG thread writes only, not model/tool effects. |
| Generic Core HTTP | `/memory/threads`, agent/session routes | User-writable thread ID/metadata cannot attest project; direct Agent/Memory APIs may bypass Factory Controller. |
| External Gateway model | GatewayAgent/remote provider | Remote memory/tool effect is outside PG transaction and unsupported for selected-project adoption until a trustworthy remote fence exists. |

The list is a **bypass inventory**, not a claim that every path is instrumented.
A future implementation must trace to each actual model-send / tool-call /
suspension-resume side-effect boundary (including nested subagents and
tool-generated messages), use the same private verified run identity, and
prove negative coverage per path. Merely checking route/controller creation,
the first `Agent.stream()` call or `MemoryPG.saveThread()` is inadequate.

## Mandatory positive run classification

1. A verified BetterAuth/Factory source issuer creates B2a pending origin
   before memory effect. The B2b PG callback records one memory row and source
   tuple atomically; `verified` is a **memory receipt only**.
2. All ingress including personal, generic HTTP, side/Slack, clone, queued
   and versioned must be independently classified as
   `managed_project | unmanaged_project | personal` from server-owned facts.
   An absent source row or a caller-supplied classification is **UNKNOWN**,
   never silently personal.
3. The immutable thread/session/resource mapping must be looked up from B1
   under real org/project owner revision, not from request metadata. A stable
   native `runId` is bound to that mapping; a new attemptId for an already
   active/UNKNOWN run must not create a second effect.
4. For managed-project native start/resume, Core's before-model/before-tool
   path calls B1 `reserveNative` immediately before irreversible effect,
   waiting for its same-row epoch CAS to commit. `tryQuiesce` must conflict
   with new reservations, while existing reservations block exclusive handover.
   Never hold a PG transaction open across network model/tool invocation.
5. For PM-owned effects, current GP-approved manager lease, handover owner
   epoch, native drain and separate service grant must be checked transactionally.
   B1 `quiescing` alone never means exclusive PM ownership. No PM owner/lease
   writer exists in these drafts.
6. Fail closed if memory backend lacks the exact PG capability, if Core hook
   coverage is partial, if source owner changed, if the lease is stale, if
   session mapping is UNKNOWN, or if a remote effect cannot be fenced.

## Lock order and crash correctness

Before activation establish **one total order** for all threads/processes:
project epoch row (write/CAS) → immutable source-owner row → thread advisory /
thread row → reservation/effect receipt. A0 currently takes thread/advisory
locks **before** its future epoch callback; integrating B1 directly would
invert order and can deadlock. Redesign the A0 callback transaction around
an epoch-first reservation stage, then prove two independent PG18
connections/OS processes with actual start-vs-quiesce, clone/move-vs-epoch,
revoke-before-effect and crash barriers. A deadlock/timeout must fail closed
and preserve UNKNOWN; no TTL-based automatic clearance.

The reservation must be durable **before** model/tool effect. A timeout,
process exit, dropped streaming response, provider reset or ambiguous tool
error changes reservation to UNKNOWN, never settled. No duplicate session
starts or autonomous retry while an earlier attempt might still have effect.

## Separate B1 verified-settlement CAS contract (NOT implemented)

B1 presently has `reserveNative`, `tryQuiesce`, `markUncertain`,
`getEpoch`, but **no trusted settle method**. Therefore every reservation
stays blocking by design. A future additive schema/version must include:

- Immutable `(org, project, session, thread, run, attempt, phase,
  epochRevision)` binding plus a uniquely indexed effect/receipt ID,
  `receiptDigest`, evidence producer identity, proof kind, observed run
  revision and monotonic evidence sequence.
- Append-only admission, begin, effect-outcome and reconciliation audit with
  no changed-intent reuse. An UNKNOWN reservation cannot be overwritten
  merely because time elapsed or a process exited.
- `settleWithProof` obtains project epoch first, then reservation in a single
  PG transaction. It must verify the exact immutable binding and the trusted,
  **independent** terminal effect/readback receipt (including external tool
  uncertainty), compare expected reservation state/version, append immutable
  evidence, and CAS to `settled`. A stale, revoked, cross-project, mismatched
  or ambiguous receipt must return `needs_reconciliation` without clearing.
- Settling a prior native effect may occur while an epoch is quiescing only
  after independent proof; it cannot create new native work or alter the PM
  owner lease. Reconcile across restart from DB evidence, never LiveSessions'
  process-local map or a caller claim. Include two-connection races where a
  new attempt ID on the same run competes with unsettled prior work.
- Data migration/restore preserves every historical unsettled/UNKNOWN record
  and stores the schema/proof version. Old readers ignore additive columns;
  rollback cannot discard unknown effects.

A stateful Core A2 implementation cannot claim autonomous HTAI handover or
PM #31 service grant readiness until all these gates pass. No source in this
A2 draft enables project adoption, schedules a job, provisions a lease,
registers a callback, or changes the live Dell Factory.
