import { describe, expect, it } from 'vitest';

import {
  CORE_EFFECT_ADMISSION_CAPABILITY,
  CoreEffectAdmissionDeniedError,
  CoreEffectAdmissionGate,
  beforeCoreModelProviderRequest,
  beforeCoreNativeToolExecute,
} from './core-effect-admission';

describe('A2a hard-disabled shared Core effect checkpoints (PM #36)', () => {
  it('is not adoption-ready and cannot be enabled by request claims', async () => {
    expect(CORE_EFFECT_ADMISSION_CAPABILITY).toMatchObject({
      version: 1, runtimeMode: 'disabled', adoptionReady: false,
      comprehensiveExecutionCoverage: false, nativeSourceResolverInstalled: false,
    });
    expect(Object.isFrozen(CORE_EFFECT_ADMISSION_CAPABILITY)).toBe(true);
    expect(beforeCoreModelProviderRequest()).toBeUndefined();
    expect(beforeCoreNativeToolExecute()).toBeUndefined();
  });

  it('enforce-mode requires unavailable trusted run/epoch proof before model effect', async () => {
    const gate = new CoreEffectAdmissionGate('enforce');
    let providerCalled = false;
    await expect((async () => {
      await gate.beforeEffect('model-provider-request', {
        runId: 'client-forged', ownerEpoch: 'guessed', projectId: 'HTAI',
        trusted: true, allPathsCovered: true,
      });
      providerCalled = true;
    })()).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    expect(providerCalled).toBe(false);
  });

  it('enforce-mode denies tool, resume and no-context claims before effect', async () => {
    const gate = new CoreEffectAdmissionGate('enforce');
    for (const claim of [null, undefined, {}, { source: 'server', trusted: true }]) {
      let executed = false;
      await expect((async () => {
        await gate.beforeEffect('shared-native-tool-execute', claim);
        executed = true;
      })()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
      expect(executed).toBe(false);
    }
  });
});
