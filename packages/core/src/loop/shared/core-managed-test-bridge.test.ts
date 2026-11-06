import { describe, expect, it } from 'vitest';

import {
  CORE_EFFECT_ADMISSION_CAPABILITY,
  CoreEffectAdmissionDeniedError,
  CoreEffectAdmissionGate,
  __withTestOnlyManagedCoreGateway,
  assertCoreSynchronousIngress,
  beforeCoreAgentPreparation,
  beforeCoreDurableRecovery,
  beforeCoreDynamicModelResolution,
  beforeCoreDynamicToolResolution,
  beforeCoreModelProviderRequest,
  beforeCoreNativeToolExecute,
} from './core-effect-admission';

describe('PM #36 A2d disabled-by-default Core↔trusted PG gateway test seam', () => {
  it('passes only server-private test scope to model/tool and early Core checkpoints', async () => {
    const secret = Object.freeze({ internal: Symbol('server-only-test-run') });
    const verified = new WeakSet<object>([secret]);
    const boundaries: string[] = [];
    const adapter = async (boundary: string, passed: object) => {
      if (!verified.has(passed)) throw new Error('No server-issued run scope');
      boundaries.push(boundary);
    };
    expect(beforeCoreModelProviderRequest()).toBeUndefined();
    expect(CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode).toBe('disabled');
    await __withTestOnlyManagedCoreGateway(
      {
        privateInvocation: secret,
        admit: adapter,
      },
      async () => {
        await beforeCoreAgentPreparation();
        await beforeCoreDynamicModelResolution();
        await beforeCoreDynamicToolResolution();
        await beforeCoreDurableRecovery();
        await beforeCoreModelProviderRequest();
        await beforeCoreNativeToolExecute();
        expect(() => assertCoreSynchronousIngress('synchronous-clone-construction')).toThrow(
          CoreEffectAdmissionDeniedError,
        );
        expect(() => assertCoreSynchronousIngress('synchronous-thread-signal')).toThrow(CoreEffectAdmissionDeniedError);
      },
    );
    expect(boundaries).toEqual([
      'agent-preparation',
      'dynamic-model-resolution',
      'dynamic-tool-resolution',
      'durable-recovery',
      'model-provider-request',
      'shared-native-tool-execute',
    ]);
    expect(beforeCoreNativeToolExecute()).toBeUndefined();
  });

  it('denies forged identities and prevents model/tool effect when test PG adapter rejects', async () => {
    const authorized = Object.freeze({ owner: Symbol('test-owner') });
    const denied = Object.freeze({ run: 'client-forged' });
    const admit = async (_boundary: string, privateInvocation: object) => {
      if (privateInvocation !== authorized) {
        throw new CoreEffectAdmissionDeniedError('model-provider-request', 'missing GP epoch proof');
      }
    };
    await expect(
      __withTestOnlyManagedCoreGateway(
        {
          privateInvocation: denied,
          admit,
        },
        async () => {
          await beforeCoreModelProviderRequest();
          throw new Error('Provider must never run');
        },
      ),
    ).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    const legacyGate = new CoreEffectAdmissionGate('enforce', async boundary => {
      if (boundary !== 'legacy-model-provider-request') {
        throw new CoreEffectAdmissionDeniedError(boundary);
      }
      await admit(boundary, denied);
    });
    await expect(legacyGate.beforeEffect('legacy-model-provider-request')).rejects.toBeInstanceOf(
      CoreEffectAdmissionDeniedError,
    );
    expect(CORE_EFFECT_ADMISSION_CAPABILITY.adoptionReady).toBe(false);
  });
});
