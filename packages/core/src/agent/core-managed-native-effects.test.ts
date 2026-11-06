import { MockLanguageModelV1 } from '@internal/ai-sdk-v4/test';
import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';

import { guardLegacyLanguageModel } from '../llm/model/legacy-effect-boundary';
import {
  CoreEffectAdmissionDeniedError,
  CoreEffectAdmissionGate,
  __withTestOnlyManagedCoreGateway,
  assertCoreSynchronousIngress,
} from '../loop/shared/core-effect-admission';
import { Agent } from './agent';

const opaque = Object.freeze({ nativeEffect: Symbol('server-only') });

describe('A2d source-only native Core deny matrix', () => {
  it('denies actual modern Agent.generate before native provider effect', async () => {
    let providerCalls = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        providerCalls++;
        throw new Error('Provider should not have run');
      },
    });
    const agent = new Agent({
      id: 'core-a2d-model',
      name: 'Core A2d Model',
      instructions: 'Answer.',
      model,
    });
    const visited: string[] = [];
    await expect(
      __withTestOnlyManagedCoreGateway(
        {
          privateInvocation: opaque,
          admit: async boundary => {
            visited.push(boundary);
            if (boundary === 'model-provider-request') {
              throw new CoreEffectAdmissionDeniedError(boundary, 'PG GP lease denied');
            }
          },
        },
        async () => agent.generate('hello'),
      ),
    ).rejects.toThrow();
    expect(visited).toContain('model-provider-request');
    expect(providerCalls).toBe(0);
  });

  it('denies eager model factory resolution before any provider/network effect', async () => {
    let factoryCalls = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        throw new Error('Provider should not have run');
      },
    });
    const agent = new Agent({
      id: 'core-a2d-eager',
      name: 'Core A2d Eager',
      instructions: 'Answer.',
      model: async () => {
        factoryCalls++;
        return model;
      },
    });
    await expect(
      __withTestOnlyManagedCoreGateway(
        {
          privateInvocation: opaque,
          admit: async boundary => {
            if (boundary === 'agent-preparation') {
              throw new CoreEffectAdmissionDeniedError(boundary, 'No all-path origin classification');
            }
          },
        },
        async () => agent.generate('hello'),
      ),
    ).rejects.toThrow();
    expect(factoryCalls).toBe(0);
  });

  it('denies legacy v1 actual model provider invocation using the test-only native gate', async () => {
    let legacyCalls = 0;
    const legacy = new MockLanguageModelV1({
      doGenerate: async () => {
        legacyCalls++;
        throw new Error('Legacy provider should not run');
      },
    });
    const privateGate = new CoreEffectAdmissionGate('enforce', async boundary => {
      throw new CoreEffectAdmissionDeniedError(boundary, 'PG epoch unavailable');
    });
    const guarded = guardLegacyLanguageModel(legacy, privateGate);
    await expect(guarded.doGenerate({} as never)).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    expect(legacyCalls).toBe(0);
  });

  it('denies real legacy Agent.generateLegacy at early scope boundary before provider call', async () => {
    let legacyCalls = 0;
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        legacyCalls++;
        throw new Error('Legacy provider should not run');
      },
    });
    const agent = new Agent({
      id: 'core-a2d-legacy',
      name: 'Core A2d Legacy',
      instructions: 'Answer.',
      model,
    });
    await expect(
      __withTestOnlyManagedCoreGateway(
        {
          privateInvocation: opaque,
          admit: async boundary => {
            if (boundary === 'agent-preparation') {
              throw new CoreEffectAdmissionDeniedError(boundary, 'Unverified PG lease');
            }
          },
        },
        async () => agent.generateLegacy('hello'),
      ),
    ).rejects.toThrow();
    expect(legacyCalls).toBe(0);
  });

  it('reports modern stream denial as a failure event, never an empty successful response', async () => {
    let streamCalls = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        streamCalls++;
        throw new Error('Stream provider should not run');
      },
    });
    const agent = new Agent({
      id: 'core-a2d-stream',
      name: 'Core A2d Stream',
      instructions: 'Answer.',
      model,
    });
    const parts: unknown[] = [];
    await __withTestOnlyManagedCoreGateway(
      {
        privateInvocation: opaque,
        admit: async boundary => {
          if (boundary === 'model-provider-request') {
            throw new CoreEffectAdmissionDeniedError(boundary, 'Unverified effect');
          }
        },
      },
      async () => {
        try {
          const stream = await agent.stream('hello');
          for await (const part of stream.fullStream) parts.push(part);
        } catch (error) {
          parts.push({ type: 'error', error });
        }
      },
    );
    expect(streamCalls).toBe(0);
    expect(parts).toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  it('denies synchronous queue/clone while managed test scope is present', async () => {
    await __withTestOnlyManagedCoreGateway(
      {
        privateInvocation: opaque,
        admit: async () => undefined,
      },
      async () => {
        let queued = 0;
        let cloned = 0;
        expect(() => {
          assertCoreSynchronousIngress('synchronous-thread-signal');
          queued++;
        }).toThrow(CoreEffectAdmissionDeniedError);
        expect(() => {
          assertCoreSynchronousIngress('synchronous-clone-construction');
          cloned++;
        }).toThrow(CoreEffectAdmissionDeniedError);
        expect({ queued, cloned }).toEqual({ queued: 0, cloned: 0 });
      },
    );
  });
});
