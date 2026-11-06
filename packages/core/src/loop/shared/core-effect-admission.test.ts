import { describe, expect, it } from 'vitest';

import {
  CORE_EFFECT_ADMISSION_CAPABILITY,
  CoreEffectAdmissionDeniedError,
  CoreEffectAdmissionGate,
  beforeCoreModelProviderRequest,
  beforeCoreNativeToolExecute,
  beforeCoreAgentPreparation,
  beforeCoreDynamicModelResolution,
  beforeCoreDynamicToolResolution,
  beforeCoreDurableRecovery,
  assertCoreSynchronousIngress,
  CoreSynchronousIngressGate,
} from './core-effect-admission';

describe('A2a hard-disabled shared Core effect checkpoints (PM #36)', () => {
  it('is not adoption-ready and cannot be enabled by request claims', async () => {
    expect(CORE_EFFECT_ADMISSION_CAPABILITY).toMatchObject({
      version: 1,
      runtimeMode: 'disabled',
      adoptionReady: false,
      comprehensiveExecutionCoverage: false,
      nativeSourceResolverInstalled: false,
    });
    expect(Object.isFrozen(CORE_EFFECT_ADMISSION_CAPABILITY)).toBe(true);
    expect(CORE_EFFECT_ADMISSION_CAPABILITY.unsupportedEffectSources).toEqual([
      'eager-provider-construction',
      'direct-remote-gateway-execution',
      'provider-executed-tools',
      'non-strict-thread-registration',
    ]);
    expect(Object.isFrozen(CORE_EFFECT_ADMISSION_CAPABILITY.unsupportedEffectSources)).toBe(true);
    expect(beforeCoreModelProviderRequest()).toBeUndefined();
    expect(beforeCoreNativeToolExecute()).toBeUndefined();
    expect(beforeCoreAgentPreparation()).toBeUndefined();
    expect(beforeCoreDynamicModelResolution()).toBeUndefined();
    expect(beforeCoreDynamicToolResolution()).toBeUndefined();
    expect(beforeCoreDurableRecovery()).toBeUndefined();
    expect(() => assertCoreSynchronousIngress('synchronous-clone-construction')).not.toThrow();
    expect(() => assertCoreSynchronousIngress('synchronous-thread-signal')).not.toThrow();
  });

  it('enforce-mode requires unavailable trusted run/epoch proof before model effect', async () => {
    const gate = new CoreEffectAdmissionGate('enforce');
    let providerCalled = false;
    await expect(
      (async () => {
        await gate.beforeEffect('model-provider-request', {
          runId: 'client-forged',
          ownerEpoch: 'guessed',
          projectId: 'HTAI',
          trusted: true,
          allPathsCovered: true,
        });
        providerCalled = true;
      })(),
    ).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    expect(providerCalled).toBe(false);
  });

  it('enforce-mode denies tool, resume and no-context claims before effect', async () => {
    const gate = new CoreEffectAdmissionGate('enforce');
    for (const claim of [null, undefined, {}, { source: 'server', trusted: true }]) {
      let executed = false;
      await expect(
        (async () => {
          await gate.beforeEffect('shared-native-tool-execute', claim);
          executed = true;
        })(),
      ).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
      expect(executed).toBe(false);
    }
  });

  it('synchronous clone/queue fences deny before mutation when no durable epoch can be checked', () => {
    const gate = new CoreSynchronousIngressGate('enforce');
    const queueState = { accepted: 0, clones: 0 };
    expect(() => {
      gate.assert('synchronous-thread-signal');
      queueState.accepted += 1;
    }).toThrow(CoreEffectAdmissionDeniedError);
    expect(() => {
      gate.assert('synchronous-clone-construction');
      queueState.clones += 1;
    }).toThrow(CoreEffectAdmissionDeniedError);
    expect(() => gate.assert('synchronous-nonstrict-thread-registration')).toThrow(CoreEffectAdmissionDeniedError);
    expect(queueState).toEqual({ accepted: 0, clones: 0 });
  });

  it('enforce-mode rejects eager model/tool resolution, recovery and untrusted public ingress', async () => {
    const gate = new CoreEffectAdmissionGate('enforce');
    for (const boundary of [
      'agent-preparation',
      'dynamic-model-resolution',
      'dynamic-tool-resolution',
      'durable-recovery',
      'synchronous-clone-construction',
      'synchronous-thread-signal',
      'synchronous-nonstrict-thread-registration',
    ] as const) {
      let irreversibleEffect = false;
      await expect(
        (async () => {
          await gate.beforeEffect(boundary, { resourceId: 'forged', ownerEpoch: 'client-claim' });
          irreversibleEffect = true;
        })(),
      ).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
      expect(irreversibleEffect).toBe(false);
    }
  });
});
