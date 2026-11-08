/**
 * PM #36 A2: INERT capability negotiation for a future all-path Core
 * before-model/before-tool effect fence. Neither Factory nor Core imports this.
 * This is a non-executable contract; it cannot arm an epoch or admit a run.
 */
export const FACTORY_CORE_PRE_EFFECT_PROTOCOL_VERSION = 1 as const;

/** Every independent public or internal entrypath must be proven, not inferred. */
export const FACTORY_CORE_REQUIRED_EFFECT_PATHS = [
  'agent.generate.modern',
  'agent.stream.modern',
  'agent.generate.legacy',
  'agent.stream.legacy',
  'agent.resume.manual',
  'agent.resume.durable',
  'agent.approve_tool',
  'controller.send_message',
  'controller.suspended_tool',
  'controller.queued_wake',
  'controller.side_session',
  'controller.clone_resume',
  'server.generic_http',
  'server.versioned_agent',
  'gateway.remote_delegate',
] as const;
export type FactoryCoreEffectPath = typeof FACTORY_CORE_REQUIRED_EFFECT_PATHS[number];

export interface FactoryCoreFenceEvidenceV1 {
  protocolVersion: typeof FACTORY_CORE_PRE_EFFECT_PROTOCOL_VERSION;
  backend: 'postgres';
  /** Trusted memory-row origin receipt, not client thread metadata. */
  originVersion: 1;
  /** Exact B1 epoch-row CAS and durable reservation version. */
  reservationVersion: 1;
  /** Actual code-level model/tool checkpoints, not ingress-only guards. */
  coveredPaths: readonly FactoryCoreEffectPath[];
  /** Independently proven same-PG transaction source-owner monotonic CAS. */
  ownerRevisionAttested: boolean;
  /** Global epoch then owner then thread lock order and cross-process proof. */
  lockOrderAttested: boolean;
  /** All unknown/failed attempts persist until independent receipt reconciliation. */
  settlementVerifierAttested: boolean;
  /** Authenticated GP-scoped PM owner epoch+lease and drain attestation. */
  managerLeaseAttested: boolean;
  /** Includes durable, legacy, versions and remote denial—not just modern Agent. */
  unsupportedProviderDenialAttested: boolean;
}

export interface FactoryCoreFenceCapability {
  readonly protocolVersion: 1;
  readonly backend: 'postgres';
  readonly adoptionReady: false;
  readonly nativeExecutionAdmissionInstalled: false;
  readonly requiredPaths: typeof FACTORY_CORE_REQUIRED_EFFECT_PATHS;
}

/** An input can describe proposed evidence, but it can NEVER self-certify it. */
export function inspectInertCoreFence(_proposed?: unknown): FactoryCoreFenceCapability {
  return Object.freeze({
    protocolVersion: FACTORY_CORE_PRE_EFFECT_PROTOCOL_VERSION,
    backend: 'postgres',
    adoptionReady: false,
    nativeExecutionAdmissionInstalled: false,
    requiredPaths: FACTORY_CORE_REQUIRED_EFFECT_PATHS,
  });
}

/**
 * Future code MUST replace this only after independent exact-head proof of
 * every model/tool path and native reservation/settlement under PG epoch CAS.
 * Keeping the admission trampoline deny-only prevents an API caller from
 * opting into partial safety based on a forged coverage manifest.
 */
export async function runWithInertCoreFence<T>(_input: unknown, _effect: () => Promise<T>): Promise<T> {
  throw new Error('CORE_EPOCH_FENCE_NOT_READY: no all-path before-effect admission or trusted PM lease');
}
