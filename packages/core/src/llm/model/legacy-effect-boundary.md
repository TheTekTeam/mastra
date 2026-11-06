# Core A2b: legacy AI SDK v4 effect checkpoints — hard disabled

PM #36 requires a genuinely common effect boundary for every managed
Factory session before **any** project handover can become active. This PR
adds only the legacy-v1 source checkpoints, stacked on the A2a modern/durable
draft.

- All four `MastraLLMV1` execution methods (`__text`, `__textObject`,
  `__stream`, `__streamObject`) pass the SDK its v1 model through a
  guardable `doGenerate/doStream` proxy. The check is **inside each provider
  invocation**, including an SDK retry and lazy-stream start, rather than
  only at the legacy Agent call site.
- The two v1 text methods that accept `ToolSet` install guardable
  `tool.execute` callbacks, checked immediately before invocation.
  Provider-defined tools with no native `execute` are unchanged.
- The only live Core A2b gate remains `runtimeMode:'disabled'`, hardcoded.
  It returns original model/tool references synchronously with no added
  Promise or microtask. An independent source-test `enforce` gate rejects
  unknown, forged or missing run context **before** provider/tool calls.
  No trusted server scope, epoch reservation, lease, enable route or
  environment toggle is installed.

## Important v4 stream delivery behavior

AI SDK v4 converts a denied `doStream` Promise into an `error` part in
`fullStream`. Its `textStream` iterator may return **successfully with
empty text** rather than throw. The negative-path test verifies the error
part and that the underlying provider was never invoked. A future Factory
operator adapter must treat `fullStream` error parts and unverified empty
streams as failed/uncertain effects, never accept empty text as proof of
success. This remains an activation blocker.

A pre-aborted signal does not consistently stop AI SDK v4 from entering its
mock provider. This PR preserves default-off timing; it does not fix SDK
abort semantics. Provider and native-tool retries need a trusted B1
reservation/new-attempt identifier and independently reconciled effects.

## Remaining explicit bypasses

This is **not comprehensive A2**. Unproven paths include provider-eager
effects outside `doGenerate/doStream`, direct `getModel()` users, provider-
executed tools, external/background tools or side effects before callbacks,
legacy direct tools invoked outside `MastraLLMV1`, generic HTTP/remote
Gateway execution, versioned delegation, queued wake, suspended/resumed
sessions, clones and non-PostgreSQL memory providers.

B2a/B2b provenance and A0 thread persistence remain inert, and the B1/B1b
durable epoch/settlement contracts have no trusted admission installer.
Before activation we require epoch→owner→thread lock order, a GP-scoped
exclusive manager lease, cross-process PG18 races/restarts, audited denial
and outcome, no replay of UNKNOWN, complete ingress matrix and genuine
independent review. Unsupported backends must fail closed for selected
managed projects, while unselected Factory work remains unaffected.

No live Factory changes, project permissions, production writes, PM leases,
epoch arming or deployment are included. Keep this PR DRAFT.
