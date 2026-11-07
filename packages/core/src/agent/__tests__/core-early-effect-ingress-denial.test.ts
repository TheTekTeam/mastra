/**
 * Synthetic, test-only admission rejection through real Core entrypoints.
 * Production gates remain hard-disabled; forged user context never enables
 * an epoch. These negatives prove entrypoint ordering before local mutation.
 */
import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Mastra } from '../../mastra';
import { RequestContext } from '../../request-context';
import { InMemoryStore } from '../../storage';
import { Agent } from '../agent';
import { createDurableAgent } from '../durable/create-durable-agent';
import { AgentThreadStreamRuntime } from '../thread-stream-runtime';
import { getSingleDummyResponseModel } from './mock-model';

const denied = vi.hoisted(() => ({
  sync: false,
  prepare: false,
  recovery: false,
  model: false,
  tool: false,
  defaults: false,
  boundaries: [] as string[],
}));

vi.mock('../../loop/shared/core-effect-admission', async importOriginal => {
  const actual = await importOriginal<typeof import('../../loop/shared/core-effect-admission')>();
  return {
    ...actual,
    CORE_EFFECT_ADMISSION_CAPABILITY: {
      ...actual.CORE_EFFECT_ADMISSION_CAPABILITY,
      get runtimeMode() {
        return denied.sync ? 'enforce' : 'disabled';
      },
    },
    assertCoreSynchronousIngress: (boundary: Parameters<typeof actual.assertCoreSynchronousIngress>[0]) => {
      if (!denied.sync) return actual.assertCoreSynchronousIngress(boundary);
      denied.boundaries.push(boundary);
      throw new actual.CoreEffectAdmissionDeniedError(boundary, 'synthetic missing trusted epoch');
    },
    beforeCoreAgentPreparation: () => {
      if (!denied.prepare) return actual.beforeCoreAgentPreparation();
      denied.boundaries.push('agent-preparation');
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('agent-preparation', 'synthetic missing GP lease'),
      );
    },
    beforeCoreDynamicModelResolution: () => {
      if (!denied.model) return actual.beforeCoreDynamicModelResolution();
      denied.boundaries.push('dynamic-model-resolution');
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('dynamic-model-resolution', 'synthetic missing GP lease'),
      );
    },
    beforeCoreDynamicToolResolution: () => {
      if (!denied.tool) return actual.beforeCoreDynamicToolResolution();
      denied.boundaries.push('dynamic-tool-resolution');
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('dynamic-tool-resolution', 'synthetic missing GP lease'),
      );
    },
    beforeCoreDynamicDefaultOptionsResolution: () => {
      if (!denied.defaults) return actual.beforeCoreDynamicDefaultOptionsResolution();
      denied.boundaries.push('dynamic-default-options-resolution');
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('dynamic-default-options-resolution', 'synthetic missing GP lease'),
      );
    },
    beforeCoreDurableRecovery: () => {
      if (!denied.recovery) return actual.beforeCoreDurableRecovery();
      denied.boundaries.push('durable-recovery');
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('durable-recovery', 'synthetic missing GP lease'),
      );
    },
  };
});

const modelFactory = vi.fn(() => new MockLanguageModelV2({ doGenerate: providerCalled }));
const toolsFactory = vi.fn(() => ({}));
const defaultOptionsFactory = vi.fn(() => ({}));
function newDynamicAgent() {
  return new Agent({
    id: 'core-a2-dynamic-resolution-negative',
    name: 'Core A2 Dynamic Resolution Negative',
    instructions: 'No dynamic factories may run after a rejected admission.',
    model: () => modelFactory(),
    tools: () => toolsFactory(),
    defaultOptions: () => defaultOptionsFactory(),
  });
}

const providerCalled = vi.fn(async () => {
  throw new Error('provider must never be called after admission denial');
});
function newAgent() {
  return new Agent({
    id: 'core-a2-entrypoint-negative',
    name: 'Core A2 Entrypoint Negative',
    instructions: 'No effect after rejected admission.',
    model: new MockLanguageModelV2({ doGenerate: providerCalled }),
  });
}

beforeEach(() => {
  denied.sync = false;
  denied.prepare = false;
  denied.recovery = false;
  denied.model = false;
  denied.tool = false;
  denied.defaults = false;
  denied.boundaries.length = 0;
  vi.clearAllMocks();
});

describe('A2 actual early Core ingress denial before local mutation', () => {
  it('preserves a normal-function defaults receiver, synchronous return and real generate/stream calls', async () => {
    let agent: Agent<any, any, any, any>;
    const receivers: unknown[] = [];
    agent = new Agent({
      id: 'core-a2-defaults-receiver',
      name: 'Core A2 Defaults Receiver',
      instructions: 'Preserve legacy defaults semantics.',
      model: getSingleDummyResponseModel('v2'),
      defaultOptions: function (this: unknown) {
        receivers.push(this);
        return { maxSteps: 7 };
      },
    });
    const direct = agent.getDefaultOptions();
    expect(direct).not.toBeInstanceOf(Promise);
    expect(direct).toMatchObject({ maxSteps: 7 });
    const generation = await agent.generate('ordinary function defaults');
    expect(generation.text).toContain('Dummy response');
    const stream = await agent.stream('ordinary function defaults');
    for await (const _part of stream.fullStream) {
      /* drain */
    }
    expect(receivers).toEqual([agent, agent, agent]);
  });

  it('preserves async normal-function defaults receiver and direct/generate/stream resolution', async () => {
    let agent: Agent<any, any, any, any>;
    const receivers: unknown[] = [];
    agent = new Agent({
      id: 'core-a2-async-defaults-receiver',
      name: 'Core A2 Async Defaults Receiver',
      instructions: 'Preserve async defaults semantics.',
      model: getSingleDummyResponseModel('v2'),
      defaultOptions: async function (this: unknown) {
        receivers.push(this);
        return { maxSteps: 8 };
      },
    });
    await expect(agent.getDefaultOptions()).resolves.toMatchObject({ maxSteps: 8 });
    await agent.generate('async ordinary function defaults');
    const stream = await agent.stream('async ordinary function defaults');
    for await (const _part of stream.fullStream) {
      /* drain */
    }
    expect(receivers).toEqual([agent, agent, agent]);
  });

  it('preserves synchronous exception timing from a normal-function defaults callback', () => {
    const thrown = new Error('ordinary defaults failure');
    let agent: Agent<any, any, any, any>;
    agent = new Agent({
      id: 'core-a2-throwing-defaults-receiver',
      name: 'Core A2 Throwing Defaults Receiver',
      instructions: 'Preserve thrown defaults errors.',
      model: getSingleDummyResponseModel('v2'),
      defaultOptions: function (this: unknown) {
        expect(this).toBe(agent);
        throw thrown;
      },
    });
    expect(() => agent.getDefaultOptions()).toThrow(thrown);
  });

  it('preserves exactly one strict getter read for legacy threadless and threaded nonstrict registration', async () => {
    for (const threaded of [false, true]) {
      const runtime = new AgentThreadStreamRuntime();
      const reads = vi.fn(() => false);
      const registrationOptions = {
        get strict() {
          return reads();
        },
      };
      const options = threaded ? { memory: { thread: 't', resource: 'r' } } : {};
      const result = runtime.registerRun(
        { id: `legacy-parity-${threaded}` } as any,
        {
          runId: `legacy-parity-run-${threaded}`,
          status: 'running',
          fullStream: new ReadableStream(),
          _waitUntilFinished: async () => undefined,
        } as any,
        options as any,
        undefined,
        registrationOptions as any,
      );
      await result;
      expect(reads).toHaveBeenCalledTimes(1);
      runtime.resetForTests();
    }
  });

  it('preserves legacy strict getter throw ordering after stream option inspection', () => {
    for (const threaded of [false, true]) {
      const runtime = new AgentThreadStreamRuntime();
      const effects: string[] = [];
      const options = Object.defineProperty(threaded ? { memory: { thread: 't', resource: 'r' } } : {}, 'abortSignal', {
        get() {
          effects.push('abortSignal');
          return undefined;
        },
      });
      const registrationOptions = {
        get strict() {
          effects.push('strict');
          throw new Error('legacy strict getter thrown');
        },
      };
      expect(() =>
        runtime.registerRun(
          { id: `legacy-throw-${threaded}` } as any,
          { runId: `legacy-throw-run-${threaded}` } as any,
          options as any,
          undefined,
          registrationOptions as any,
        ),
      ).toThrow('legacy strict getter thrown');
      expect(effects).toEqual(['abortSignal', 'strict']);
      runtime.resetForTests();
    }
  });
  it('blocks actual getModel, getLLM and getModelList resolution before dynamic model factories', async () => {
    const agent = newDynamicAgent();
    denied.model = true;
    await expect(agent.getModel()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(agent.getLLM()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(agent.getModelList()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(denied.boundaries).toEqual([
      'dynamic-model-resolution',
      'dynamic-model-resolution',
      'dynamic-model-resolution',
    ]);
    expect(modelFactory).not.toHaveBeenCalled();
    expect(toolsFactory).not.toHaveBeenCalled();
    expect(defaultOptionsFactory).not.toHaveBeenCalled();
    expect(providerCalled).not.toHaveBeenCalled();
  });

  it('blocks getToolsForExecution, convertTools and listTools before defaults, assigned-tool and model factories', async () => {
    const agent = newDynamicAgent();
    denied.tool = true;
    await expect(agent.getToolsForExecution({ requestContext: new RequestContext() })).rejects.toThrow(
      /CORE_EFFECT_ADMISSION_DENIED/,
    );
    // Test the second installed call site directly; this is private TS API
    // but a runtime function reached by the normal tool assembly pipeline.
    await expect(
      (agent as any).convertTools({ requestContext: new RequestContext(), methodType: 'generate' }),
    ).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(agent.listTools()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(denied.boundaries).toEqual([
      'dynamic-tool-resolution',
      'dynamic-tool-resolution',
      'dynamic-tool-resolution',
    ]);
    expect(defaultOptionsFactory).not.toHaveBeenCalled();
    expect(toolsFactory).not.toHaveBeenCalled();
    expect(modelFactory).not.toHaveBeenCalled();
    expect(providerCalled).not.toHaveBeenCalled();
  });

  it('blocks eager dynamic default-options factory on direct access and real generate/stream', async () => {
    const agent = newDynamicAgent();
    const storage = new InMemoryStore();
    void new Mastra({ agents: { 'core-a2-dynamic-resolution-negative': agent }, storage });
    const readStore = vi.spyOn(storage, 'getStore');
    readStore.mockClear();
    denied.defaults = true;
    await expect(agent.getDefaultOptions()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(agent.generate('must not call dynamic defaults')).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(agent.stream('must not call dynamic defaults')).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(denied.boundaries).toEqual([
      'dynamic-default-options-resolution',
      'dynamic-default-options-resolution',
      'dynamic-default-options-resolution',
    ]);
    expect(readStore).not.toHaveBeenCalled();
    expect(defaultOptionsFactory).not.toHaveBeenCalled();
    expect(toolsFactory).not.toHaveBeenCalled();
    expect(modelFactory).not.toHaveBeenCalled();
    expect(providerCalled).not.toHaveBeenCalled();
  });

  it('propagates real generate and stream model-selection denials without provider or model factories', async () => {
    const agent = new Agent({
      id: 'core-a2-model-generation-negative',
      name: 'Core A2 Model Generation Negative',
      instructions: 'No effects.',
      model: () => modelFactory(),
    });
    denied.model = true;
    await expect(agent.generate('must not resolve model')).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(agent.stream('must not resolve model')).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(denied.boundaries).toEqual(['dynamic-model-resolution', 'dynamic-model-resolution']);
    expect(modelFactory).not.toHaveBeenCalled();
    expect(providerCalled).not.toHaveBeenCalled();
  });
  it('blocks real queued and directly sent signals before touching agent or scheduling wake', () => {
    const runtime = new AgentThreadStreamRuntime();
    const agent = { getMastraInstance: vi.fn(), generate: vi.fn(), stream: vi.fn() } as any;
    const target = { resourceId: 'resource', threadId: 'thread' };
    const signal = { type: 'user-message', contents: 'must not queue' } as any;
    denied.sync = true;
    expect(() => runtime.queueSignal(agent, signal, target as any)).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(() => runtime.sendSignal(agent, signal, target as any)).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(denied.boundaries).toEqual(['synchronous-thread-signal', 'synchronous-thread-signal']);
    expect(agent.getMastraInstance).not.toHaveBeenCalled();
    expect(agent.generate).not.toHaveBeenCalled();
    expect(agent.stream).not.toHaveBeenCalled();
  });

  it('blocks real non-strict registration before threadless finalizer or prepared output inspection', () => {
    const runtime = new AgentThreadStreamRuntime();
    const agent = { id: 'negative-registration' } as any;
    const finished = vi.fn(async () => undefined);
    const getAbortSignal = vi.fn(() => new AbortController().signal);
    const streamOptions = Object.defineProperty({}, 'abortSignal', {
      get: getAbortSignal,
      enumerable: true,
    });
    const output = { runId: 'unregistered', _waitUntilFinished: finished } as any;
    denied.sync = true;
    expect(() => runtime.registerRun(agent, output, streamOptions as any)).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(() =>
      runtime.registerRun(agent, output, {
        memory: { thread: 'thread', resource: 'resource' },
      } as any),
    ).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(getAbortSignal).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(denied.boundaries).toEqual([
      'synchronous-nonstrict-thread-registration',
      'synchronous-nonstrict-thread-registration',
    ]);
  });

  it('blocks real Agent fork and generation plus queued stream resume before provider or preparation', async () => {
    const agent = newAgent();
    const rawConfig = vi.spyOn(agent, 'toRawConfig');
    const runtime = new AgentThreadStreamRuntime();
    const resume = vi.fn(async () => {
      throw new Error('resume callback must not execute');
    });
    denied.sync = true;
    expect(() => agent.__fork()).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    denied.prepare = true;
    await expect(agent.generate('must not execute')).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(runtime.queueStreamResume('run-rejected', resume)).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(rawConfig).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(providerCalled).not.toHaveBeenCalled();
    expect(denied.boundaries).toEqual(['synchronous-clone-construction', 'agent-preparation', 'agent-preparation']);
  });

  it('blocks registered DurableAgent single and bulk recovery before reading snapshots or invoking provider', async () => {
    const durable = createDurableAgent({ agent: newAgent() });
    const storage = new InMemoryStore();
    const readStore = vi.spyOn(storage, 'getStore');
    // A fully registered agent has a real storage backend: without the
    // injected gate, these APIs could discover and mutate durable workflows.
    void new Mastra({ agents: { 'core-a2-entrypoint-negative': durable as any }, storage });
    readStore.mockClear();
    denied.recovery = true;
    await expect(durable.recover('missing-durable-run')).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    await expect(durable.recoverActiveRuns()).rejects.toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(readStore).not.toHaveBeenCalled();
    expect(providerCalled).not.toHaveBeenCalled();
    expect(denied.boundaries).toEqual(['durable-recovery', 'durable-recovery']);
  });
});
