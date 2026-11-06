import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/agent';

// Injectable *test-only* modern provider denial. Real runtime's A2 admission
// capability is still hard-disabled: this verifies its actual SDK p-retry +
// Agent.generate/stream call chains fail closed when the future trusted gate
// rejects, before the network/provider function is entered.
const admission = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('./core-effect-admission', async importOriginal => {
  const actual = await importOriginal<typeof import('./core-effect-admission')>();
  return {
    ...actual,
    beforeCoreModelProviderRequest: () => {
      admission.attempts++;
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('model-provider-request', 'synthetic missing trusted PG epoch'),
      );
    },
  };
});

const providerGenerate = vi.fn(async () => ({
  rawCall: { rawPrompt: null, rawSettings: {} },
  warnings: [],
  finishReason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  content: [{ type: 'text' as const, text: 'must never appear' }],
}));
const providerStream = vi.fn(async () => {
  throw new Error('provider stream must never execute');
});
const fallbackGenerate = vi.fn(async () => {
  throw new Error('fallback generate must never execute');
});
const fallbackStream = vi.fn(async () => {
  throw new Error('fallback stream must never execute');
});
const errorProcessor = vi.fn(async () => ({ retry: true }));
function makeAgent() {
  return new Agent({
    id: 'denied-model-provider-agent',
    name: 'Denied Model Provider Agent',
    instructions: 'Answer the user.',
    model: new MockLanguageModelV2({
      doGenerate: providerGenerate,
      doStream: providerStream,
    }),
    errorProcessorDefaults: false,
  });
}
function makeAdversarialAgent() {
  return new Agent({
    id: 'denied-model-with-recovery-agent',
    name: 'Denied Model with Recovery Agent',
    instructions: 'Answer the user.',
    model: [
      {
        id: 'primary',
        model: new MockLanguageModelV2({ doGenerate: providerGenerate, doStream: providerStream }),
        maxRetries: 3,
      },
      {
        id: 'fallback',
        model: new MockLanguageModelV2({ doGenerate: fallbackGenerate, doStream: fallbackStream }),
        maxRetries: 3,
      },
    ],
    errorProcessorDefaults: false,
    errorProcessors: [{ id: 'retry-admission', processAPIError: errorProcessor }],
    maxProcessorRetries: 3,
  });
}
afterEach(() => {
  admission.attempts = 0;
  vi.clearAllMocks();
});

describe('A2 actual Agent modern model admission through provider retry boundary', () => {
  it('Agent.generate admission denial is terminal despite retrying error processor and fallback model', async () => {
    await expect(makeAdversarialAgent().generate('hello', { modelSettings: { maxRetries: 3 } })).rejects.toBeTruthy();
    expect(admission.attempts).toBe(1);
    expect(errorProcessor).not.toHaveBeenCalled();
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
    expect(fallbackGenerate).not.toHaveBeenCalled();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it('Agent.stream admission denial cannot be processed or failed over to another model', async () => {
    const result = await makeAdversarialAgent().stream('hello', { modelSettings: { maxRetries: 3 } });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(parts.some(part => part.type === 'error')).toBe(true);
    expect(parts.some(part => part.type === 'text-delta')).toBe(false);
    expect(admission.attempts).toBe(1);
    expect(errorProcessor).not.toHaveBeenCalled();
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
    expect(fallbackGenerate).not.toHaveBeenCalled();
    expect(fallbackStream).not.toHaveBeenCalled();
  });
  it('Agent.generate with retry budget 3 never invokes model or schedules retry', async () => {
    const agent = makeAgent();
    await expect(
      agent.generate('hello', {
        modelSettings: { maxRetries: 3 },
      }),
    ).rejects.toBeTruthy();
    expect(admission.attempts).toBe(1);
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
  });
  it('Agent.stream with retry budget 3 emits terminal error, never model content/effect', async () => {
    const agent = makeAgent();
    const result = await agent.stream('hello', {
      modelSettings: { maxRetries: 3 },
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(parts.some(part => part.type === 'error')).toBe(true);
    expect(parts.some(part => part.type === 'text-delta')).toBe(false);
    expect(parts.some(part => part.type === 'tool-result')).toBe(false);
    expect(admission.attempts).toBe(1);
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
  });
});
