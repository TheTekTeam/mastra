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
afterEach(() => {
  admission.attempts = 0;
  vi.clearAllMocks();
});

describe('A2 actual Agent modern model admission through provider retry boundary', () => {
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
