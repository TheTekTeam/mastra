# Core A2a model and native-tool checkpoints — inert

This adds two **real call-site checkpoints**, still permanently disabled:

1. `stream/aisdk/v5/execute.ts`: immediately before the provider's
   `model.doStream/doGenerate` call inside **each** `p-retry` attempt.
   The modern and durable agentic LLM steps both call this common stream
   execution helper. An admission denial is a non-retryable control-flow
   failure; it must never be re-sent as a provider request.
2. `loop/shared/steps/execute-tool-core.ts`: immediately before
   `tool.execute` in the shared modern/durable direct native tool path.
   An admission denial is rethrown (like an FGA denial), not converted into
   a model-visible recoverable tool error.

The exact `CoreEffectAdmissionGate('disabled')` is the **only runtime
instance** referenced by these call sites. It is not configurable via env,
request context, headers, user metadata, tool arguments or plugin commands.
There is no registration/enable function. A separate enforce-mode instance
used in source tests **always fails closed**, including when supplied a
forged “trusted” run or all-green capability. The advertised capability
says `adoptionReady:false` and
`comprehensiveExecutionCoverage:false`.

## Remaining bypass and trust gates

- This is **not all Core**: legacy `agent-legacy.ts`, native provider-executed
  tools, eager/background detached tools, suspended approval continuations,
  generic HTTP agent/session entrypoints, versioned agent delegation,
  side/clone sessions, queued wakes and remote Gateway effects require
  their own verified checkpoints/negative tests. A direct provider call
  outside `execute()` is not covered.
- Per-request `runId` or `threadId` is not a trustworthy Factory project
  identity. Future model/tool checkpoint must read server-private proven
  B2a/B2b origin, B1 immutable scope, project owner revision, run+attempt
  fencing and current GP PM ownership policy; client stamps cannot fill gaps.
- B1 `reserveNative` must commit its same-row epoch revision CAS before each
  irreversible model/tool effect. On error/timeout/retry, the outcome becomes
  UNKNOWN unless independent native/external readback proves it settled.
  A fresh retry must use a new bounded attempt ID, never replay an
  ambiguous effect. B1b trusted `settleWithProof` is source-only and lacks
  any installed producer.
- All source-owner, epoch, thread and lease mutations need one verified
  lock order: project epoch → source owner → thread → reservation/evidence.
  A0 PG thread guard presently locks thread before future epoch admission.
- Global adoption cannot be enabled until all paths (including unsupported
  backends) are explicitly negotiated and tested on actual PG18
  cross-process/restart. Otherwise unknown/unclassified runs must fail closed
  while unselected Factory projects preserve normal execution.

This source change neither registers a Factory guard, authorizes model/tool
work, arms an epoch, provisions a lease, deploys to Dell, nor enables PM or
MCP production writes. It is a **partial checkpoint implementation** and
must stay DRAFT and default OFF.
