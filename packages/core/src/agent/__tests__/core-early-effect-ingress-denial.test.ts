/**
 * Synthetic, test-only admission rejection through real Core entrypoints.
 * Production gates remain hard-disabled; forged user context never enables
 * an epoch. These negatives prove entrypoint ordering before local mutation.
 */
import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Mastra } from '../../mastra';
import { InMemoryStore } from '../../storage';
import { Agent } from '../agent';
import { createDurableAgent } from '../durable/create-durable-agent';
import { AgentThreadStreamRuntime } from '../thread-stream-runtime';

const denied = vi.hoisted(() => ({
  sync: false, prepare: false, recovery: false, boundaries: [] as string[],
}));

vi.mock('../../loop/shared/core-effect-admission', async importOriginal => {
  const actual = await importOriginal<typeof import('../../loop/shared/core-effect-admission')>();
  return {
    ...actual,
    assertCoreSynchronousIngress: (boundary: Parameters<typeof actual.assertCoreSynchronousIngress>[0]) => {
      if (!denied.sync) return actual.assertCoreSynchronousIngress(boundary);
      denied.boundaries.push(boundary);
      throw new actual.CoreEffectAdmissionDeniedError(boundary, 'synthetic missing trusted epoch');
    },
    beforeCoreAgentPreparation: () => {
      if (!denied.prepare) return actual.beforeCoreAgentPreparation();
      denied.boundaries.push('agent-preparation');
      return Promise.reject(new actual.CoreEffectAdmissionDeniedError('agent-preparation', 'synthetic missing GP lease'));
    },
    beforeCoreDurableRecovery: () => {
      if (!denied.recovery) return actual.beforeCoreDurableRecovery();
      denied.boundaries.push('durable-recovery');
      return Promise.reject(new actual.CoreEffectAdmissionDeniedError('durable-recovery', 'synthetic missing GP lease'));
    },
  };
});

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
  denied.boundaries.length = 0;
  vi.clearAllMocks();
});

describe('A2 actual early Core ingress denial before local mutation', () => {
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
      get: getAbortSignal, enumerable: true,
    });
    const output = { runId: 'unregistered', _waitUntilFinished: finished } as any;
    denied.sync = true;
    expect(() => runtime.registerRun(agent, output, streamOptions as any)).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
    expect(() => runtime.registerRun(agent, output, {
      memory: { thread: 'thread', resource: 'resource' },
    } as any)).toThrow(/CORE_EFFECT_ADMISSION_DENIED/);
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
    expect(denied.boundaries).toEqual([
      'synchronous-clone-construction', 'agent-preparation', 'agent-preparation',
    ]);
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
