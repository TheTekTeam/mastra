# Core A2c: early ingress and eager resolver checkpoints — default OFF

This source-only draft extends A2a modern/durable and A2b legacy model/tool
boundaries. It **does not activate** Factory adoption or provide a trusted
project/epoch authority.

## Verified source route inventory

| Route or effect source                                              | A2c checkpoint                                                                                                                       | Proven limit                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Generic HTTP `agents.ts`, `responses.ts`, A2A and workflow-builder  | They delegate to public `Agent.generate/stream`, now checked before default options, dynamic scope/model, memory or tool preparation | HTTP authentication/handler prework and alternate custom adapters are outside this Core hook          |
| `Agent.generate/stream/network/generateLegacy/streamLegacy`         | Async deny-only admission before run/default/model/processor preparation                                                             | No trusted B2 origin/GP lease, so future enforced mode denies unknown                                 |
| `DurableAgent.generate/stream/resume/recover/recoverActiveRuns`     | Async deny-only before workflow claim, cold snapshot rehydration, or provider setup                                                  | Durable internal/remote workflow backends still need complete run admission evidence                  |
| Dynamic model resolution `resolveModelSelection/resolveModelConfig` | Before user-supplied model selectors/factories, including direct Agent `getModel/getLLM` callers                                     | Agent construction and direct external/provider API calls bypass this                                 |
| Tool assembly `getToolsForExecution/convertTools`                   | Before default/tool source factories (modern and durable paths)                                                                      | A separate tool provider may execute outside Core                                                     |
| Core queued `queueSignal/#sendSignal`                               | **Synchronous deny-only** before local queue/delivery mutation in future enforce mode                                                | No synchronous PG transaction/epoch proof; future managed mode cannot admit this API without redesign |
| Queue resume `queueStreamResume`                                    | Async early deny before installing a resume tail; queued new starts re-enter `.stream`                                               | Queue origin, crash recovery and lease provenance not yet verified                                    |
| `Agent.__fork/DurableAgent.__fork`                                  | Synchronous deny-only before constructing a version/side clone in future enforce mode                                                | An authenticated pre-issued reservation is required for any positive adoption                         |

The only runtime instance is still `disabled`: all early async helpers return
`undefined` synchronously, so code conditionally avoids `await`; the
synchronous gates return immediately. No new Promise, timer, registry, env
toggle, project grant or storage write is introduced on existing traffic.
Separate enforce-mode test gates reject forged context and leave effect counters
at zero.

## Critical remaining blockers

- **Unmanaged legacy lease fail-open:** idle `sendSignal` and non-strict
  `registerRun` retain their historical optimistic behavior under pubsub lease
  failure (availability over duplicate-run risk). Changing that globally would
  break existing clients; the legacy behavior has an explicit regression test.
  Both entry points have a future enforce-mode synchronous denial before local
  mutation, but neither is a positive selected-project admission path. PM-owned
  projects require B1 transactional PG epoch/reservation and trusted
  run/thread/project binding at _every effect_, never this optimistic lease.
- **No positive synchronous queue/clone proof:** these routes are intentionally
  denied in hypothetical enforce mode. To support selected-project handover,
  move their admission to a transaction-capable async ingress or require a
  server-issued immutable reservation verified at effect start; do not merely
  add a request-context flag.
- **Provider-eager or out-of-Core effects:** a model/tool constructor can run
  outside these Agent methods; remote Gateway, external/worker API calls,
  provider-executed tools, direct model methods and custom adapters are not
  intercepted universally. `CORE_EFFECT_ADMISSION_CAPABILITY.unsupportedEffectSources`
  explicitly inventories eager-provider construction, direct remote Gateway
  execution and provider-executed tools. The inventory does not intercept them:
  selected-project management must reject these capabilities until separately
  proven rather than treating an early Agent checkpoint as comprehensive coverage.
- **Incomplete ownership/settlement:** B2a/B2b source origin and A0 PG
  thread hooks are not activated; B1/B1b epoch and receipt settlement have no
  accepted GP-owned lease writer, cross-process restart/ABA proof or global
  epoch→owner→thread lock-order enforcement. UNKNOWN effects cannot be
  replayed/auto-cleared.
- **Legacy stream outcome:** A2b proved AI SDK v4 can deliver a denied provider
  request as a `fullStream` error part while `textStream` ends without
  throwing. Operator consumers must treat that as failure, never empty success.

A2c has no live Factory deployment, GP consent, HTTP service credential,
write enable, lease arming or autonomous adoption. Keep this PR **DRAFT**,
stacked on A2b, until route inventory, PG18 cross-process failure tests,
independent HP6 exact-head review and all operator acceptance gates succeed.
