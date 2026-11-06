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
export type CoreEffectBoundary = 'model-provider-request' | 'shared-native-tool-execute';

export class CoreEffectAdmissionDeniedError extends Error {
  constructor(boundary: CoreEffectBoundary, reason = 'trusted epoch/run admission unavailable') {
    super(`CORE_EFFECT_ADMISSION_DENIED (${boundary}): ${reason}`);
    this.name = 'CoreEffectAdmissionDeniedError';
  }
}

/** Explicitly partial coverage; it must never be advertised as adoption-safe. */
export const CORE_EFFECT_ADMISSION_CAPABILITY = Object.freeze({
  version: CORE_EFFECT_ADMISSION_PROTOCOL_VERSION,
  boundaries: ['model-provider-request', 'shared-native-tool-execute'] as const,
  nativeSourceResolverInstalled: false,
  managerLeaseInstalled: false,
  comprehensiveExecutionCoverage: false,
  adoptionReady: false,
  runtimeMode: 'disabled' as const,
});

type InternalMode = 'disabled' | 'enforce';

/**
 * The Core effect gate is a tiny path-level trampoline. Future production
 * enforcement must obtain an unforgeable server-owned run scope, reserve B1
 * under PG epoch CAS before effect, and reconcile an independent settlement
 * receipt. Until then even an enforce-mode test gate DENIES all requests.
 */
export class CoreEffectAdmissionGate {
  readonly #mode: InternalMode;

  constructor(mode: InternalMode = 'disabled') {
    this.#mode = mode;
  }

  async beforeEffect(boundary: CoreEffectBoundary, _untrustedContext?: unknown): Promise<void> {
    if (this.#mode === 'disabled') return;
    throw new CoreEffectAdmissionDeniedError(boundary);
  }
}

// The only gate reached by Core's live effect call-sites is permanently
// disabled in this draft. No exported register/enable function or env toggle.
const runtimeGate = new CoreEffectAdmissionGate(CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode);

export function beforeCoreModelProviderRequest(): Promise<void> | undefined {
  // No await/microtask while disabled: preserve the preexisting provider
  // invocation and already-aborted tool timing contracts exactly.
  if (CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode === 'disabled') return undefined;
  return runtimeGate.beforeEffect('model-provider-request');
}

export function beforeCoreNativeToolExecute(): Promise<void> | undefined {
  if (CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode === 'disabled') return undefined;
  return runtimeGate.beforeEffect('shared-native-tool-execute');
}
