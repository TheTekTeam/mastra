import type { AsyncLocalStorage } from 'node:async_hooks';

/**
 * PM #36 A2a: actual modern+durable model and shared-tool effect boundaries,
 * but RUNTIME HARD-DISABLED until a separate reviewed native epoch/lease
 * installer covers ALL modern/legacy/durable/queued/provider/remote paths.
 *
 * This module is intentionally NOT a project classifier or authorization API.
 * A caller's request context, thread metadata or claimed capability cannot
 * enable enforcement or count as a trusted Factory run identity.
 */
export const CORE_EFFECT_ADMISSION_PROTOCOL_VERSION = 1 as const;
export type CoreEffectBoundary =
  | 'model-provider-request'
  | 'shared-native-tool-execute'
  | 'legacy-model-provider-request'
  | 'legacy-native-tool-execute'
  | 'agent-preparation'
  | 'dynamic-model-resolution'
  | 'dynamic-tool-resolution'
  | 'durable-recovery'
  | 'synchronous-clone-construction'
  | 'synchronous-thread-signal';

export class CoreEffectAdmissionDeniedError extends Error {
  constructor(boundary: CoreEffectBoundary, reason = 'trusted epoch/run admission unavailable') {
    super(`CORE_EFFECT_ADMISSION_DENIED (${boundary}): ${reason}`);
    this.name = 'CoreEffectAdmissionDeniedError';
  }
}

/** Explicitly partial coverage; it must never be advertised as adoption-safe. */
export const CORE_EFFECT_ADMISSION_CAPABILITY = Object.freeze({
  version: CORE_EFFECT_ADMISSION_PROTOCOL_VERSION,
  boundaries: [
    'model-provider-request',
    'shared-native-tool-execute',
    'legacy-model-provider-request',
    'legacy-native-tool-execute',
    'agent-preparation',
    'dynamic-model-resolution',
    'dynamic-tool-resolution',
    'durable-recovery',
    'synchronous-clone-construction',
    'synchronous-thread-signal',
  ] as const,
  nativeSourceResolverInstalled: false,
  managerLeaseInstalled: false,
  comprehensiveExecutionCoverage: false,
  // No Core hook can claim these external effect paths are intercepted.
  // Future selected-project adoption must reject them until separately proven.
  unsupportedEffectSources: Object.freeze([
    'eager-provider-construction',
    'direct-remote-gateway-execution',
    'provider-executed-tools',
  ] as const),
  adoptionReady: false,
  runtimeMode: 'disabled' as const,
});

type InternalMode = 'disabled' | 'enforce';

/**
 * Consolidation proof hook ONLY: no production installer exists, and the
 * runtime capability remains hard-disabled. Tests may bind an opaque
 * server-origin object across actual Core provider/tool call stacks and
 * inject a PG adapter; request contexts can never select this gate.
 *
 * The test-only wrapper is unavailable outside NODE_ENV=test. It is not an
 * execution authority and MUST NOT be enabled in a live Factory deployment.
 */
interface TestOnlyTrustedGatewayContext {
  privateInvocation: object;
  admit: (boundary: CoreEffectBoundary, privateInvocation: object) => Promise<void>;
}
// Lazy test-only Node import: browser/edge builds must not require async_hooks.
let testOnlyManagedEffectScope: AsyncLocalStorage<TestOnlyTrustedGatewayContext> | undefined;

export async function __withTestOnlyManagedCoreGateway<T>(
  context: TestOnlyTrustedGatewayContext,
  run: () => Promise<T>,
): Promise<T> {
  if (
    process.env.NODE_ENV !== 'test' ||
    !context.privateInvocation ||
    typeof context.privateInvocation !== 'object' ||
    typeof context.admit !== 'function'
  ) {
    throw new Error('Core managed effect test bridge is unavailable outside isolated tests');
  }
  testOnlyManagedEffectScope ??= new (
    await import('node:async_hooks')
  ).AsyncLocalStorage<TestOnlyTrustedGatewayContext>();
  return testOnlyManagedEffectScope.run(Object.freeze({ ...context }), run);
}

function beforeRuntimeBoundary(boundary: CoreEffectBoundary): Promise<void> | undefined {
  const tested = testOnlyManagedEffectScope?.getStore();
  if (tested) return tested.admit(boundary, tested.privateInvocation);
  if (CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode === 'disabled') return undefined;
  return runtimeGate.beforeEffect(boundary);
}

/**
 * The Core effect gate is a tiny path-level trampoline. Future production
 * enforcement must obtain an unforgeable server-owned run scope, reserve B1
 * under PG epoch CAS before effect, and reconcile an independent settlement
 * receipt. Until then even an enforce-mode test gate DENIES all requests.
 */
export class CoreEffectAdmissionGate {
  readonly #mode: InternalMode;
  readonly #testOnlyAdapter?: (boundary: CoreEffectBoundary) => Promise<void>;

  constructor(mode: InternalMode = 'disabled', testOnlyAdapter?: (boundary: CoreEffectBoundary) => Promise<void>) {
    if (testOnlyAdapter && process.env.NODE_ENV !== 'test') {
      throw new Error('Managed Core test gateway cannot be installed outside isolated tests');
    }
    this.#mode = mode;
    this.#testOnlyAdapter = testOnlyAdapter;
  }

  async beforeEffect(boundary: CoreEffectBoundary, _untrustedContext?: unknown): Promise<void> {
    if (this.#mode === 'disabled') return;
    if (this.#testOnlyAdapter) return this.#testOnlyAdapter(boundary);
    throw new CoreEffectAdmissionDeniedError(boundary);
  }
}

// The only gate reached by Core's live effect call-sites is permanently
// disabled in this draft. No exported register/enable function or env toggle.
const runtimeGate = new CoreEffectAdmissionGate(CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode);

export function beforeCoreModelProviderRequest(): Promise<void> | undefined {
  // No await/microtask while disabled: preserve the preexisting provider
  // invocation and already-aborted tool timing contracts exactly.
  return beforeRuntimeBoundary('model-provider-request');
}

export function beforeCoreNativeToolExecute(): Promise<void> | undefined {
  return beforeRuntimeBoundary('shared-native-tool-execute');
}

/**
 * A2c early source checkpoints intercept eager agent/default/model/tool
 * resolvers before their user-supplied factories run. The runtime gate remains
 * hard-disabled. Future support must provide a trusted B2 origin and B1 epoch
 * reservation; request claims cannot authorize these calls.
 */
export function beforeCoreAgentPreparation(): Promise<void> | undefined {
  return beforeRuntimeBoundary('agent-preparation');
}

export function beforeCoreDynamicModelResolution(): Promise<void> | undefined {
  return beforeRuntimeBoundary('dynamic-model-resolution');
}

export function beforeCoreDynamicToolResolution(): Promise<void> | undefined {
  return beforeRuntimeBoundary('dynamic-tool-resolution');
}

export function beforeCoreDurableRecovery(): Promise<void> | undefined {
  return beforeRuntimeBoundary('durable-recovery');
}

/**
 * Synchronous clone/queue APIs cannot await a PostgreSQL epoch reservation.
 * Until an authenticated pre-issued reservation protocol is accepted, they
 * must DENY (not schedule a late asynchronous check) whenever future managed
 * admission is enabled. No registration/enable path exists in this draft.
 */
export class CoreSynchronousIngressGate {
  readonly #mode: InternalMode;

  constructor(mode: InternalMode = 'disabled') {
    this.#mode = mode;
  }

  assert(boundary: 'synchronous-clone-construction' | 'synchronous-thread-signal'): void {
    if (this.#mode === 'disabled') return;
    throw new CoreEffectAdmissionDeniedError(boundary, 'synchronous route has no verified epoch reservation');
  }
}

// Deliberately no setter, request override, register() or env toggle.
const runtimeSynchronousIngressGate = new CoreSynchronousIngressGate(CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode);

export function assertCoreSynchronousIngress(
  boundary: 'synchronous-clone-construction' | 'synchronous-thread-signal',
): void {
  // A future managed lease cannot be reserved synchronously, including test
  // contexts. Fail before enqueue/clone mutation; never schedule a late check.
  if (testOnlyManagedEffectScope?.getStore()) throw new CoreEffectAdmissionDeniedError(boundary);
  runtimeSynchronousIngressGate.assert(boundary);
}
