import { simulateReadableStream } from '@internal/ai-sdk-v4';
import { MockLanguageModelV1 } from '@internal/ai-sdk-v4/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import {
  CORE_EFFECT_ADMISSION_CAPABILITY,
  CoreEffectAdmissionDeniedError,
  CoreEffectAdmissionGate,
} from '../../loop/shared/core-effect-admission';
import { RequestContext } from '../../request-context';
import { guardLegacyLanguageModel, guardLegacyToolSet } from './legacy-effect-boundary';
import { MastraLLMV1 } from './model';

const runtimeArgs = {
  messages: [{ role: 'user' as const, content: 'Call the provider' }],
  requestContext: new RequestContext(),
  tracingContext: {},
  maxRetries: 0,
};

function makeModel(effect: { generate: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> }) {
  return new MockLanguageModelV1({
    doGenerate: async props => {
      effect.generate(props);
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        text: 'provider output',
      };
    },
    doStream: async props => {
      effect.stream(props);
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-delta', textDelta: 'provider output' },
            {
              type: 'finish',
              finishReason: 'stop',
              logprobs: undefined,
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
      };
    },
  });
}

describe('A2b legacy v1 SDK provider/tool effect boundaries (PM #36)', () => {
  it('keeps the default-off model and tool identities (no eager or microtask delay)', async () => {
    const effects = { generate: vi.fn(), stream: vi.fn() };
    const model = makeModel(effects);
    const tools = { effect: { description: 'Effectful', parameters: z.object({}), execute: async () => 'done' } };

    expect(CORE_EFFECT_ADMISSION_CAPABILITY).toMatchObject({
      runtimeMode: 'disabled',
      adoptionReady: false,
      comprehensiveExecutionCoverage: false,
    });
    expect(guardLegacyLanguageModel(model)).toBe(model);
    expect(guardLegacyToolSet(tools)).toBe(tools);

    const legacy = new MastraLLMV1({ model });
    const text = await legacy.__text(runtimeArgs);
    expect(text.text).toBe('provider output');
    const stream = legacy.__stream(runtimeArgs);
    let streamed = '';
    for await (const part of stream.textStream) streamed += part;
    expect(streamed).toContain('provider output');
    expect(effects.generate).toHaveBeenCalledTimes(1);
    expect(effects.stream).toHaveBeenCalledTimes(1);
  });

  it('rejects every provider retry before doGenerate, including forged scope claims', async () => {
    const effects = { generate: vi.fn(), stream: vi.fn() };
    const model = guardLegacyLanguageModel(makeModel(effects), new CoreEffectAdmissionGate('enforce'));
    const legacy = new MastraLLMV1({ model });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(legacy.__text(runtimeArgs)).rejects.toThrow();
    }
    expect(effects.generate).not.toHaveBeenCalled();
    await expect(model.doGenerate({ prompt: [], mode: { type: 'regular' } } as any)).rejects.toBeInstanceOf(
      CoreEffectAdmissionDeniedError,
    );
    expect(effects.generate).not.toHaveBeenCalled();
  });

  it('rejects lazy legacy streams before the first doStream and on repeated consumption', async () => {
    const effects = { generate: vi.fn(), stream: vi.fn() };
    const model = guardLegacyLanguageModel(makeModel(effects), new CoreEffectAdmissionGate('enforce'));
    const legacy = new MastraLLMV1({ model });

    const stream = legacy.__stream(runtimeArgs);
    const parts = [];
    for await (const part of stream.fullStream) parts.push(part);
    // AI SDK v4 surfaces a rejected doStream as an error part, not necessarily
    // a throwing textStream iterator. Consumers must fail closed on this part.
    expect(parts.some(part => part.type === 'error')).toBe(true);
    expect(parts.some(part => part.type === 'text-delta')).toBe(false);
    await expect(model.doStream({ prompt: [], mode: { type: 'regular' } } as any)).rejects.toBeInstanceOf(
      CoreEffectAdmissionDeniedError,
    );
    expect(effects.stream).not.toHaveBeenCalled();
  });

  it('rejects legacy native tool callbacks without running them or accepting caller context', async () => {
    const execute = vi.fn(async () => 'irreversible result');
    const tool = { description: 'Effectful', parameters: z.object({}), execute };
    const wrapped = guardLegacyToolSet({ effect: tool }, new CoreEffectAdmissionGate('enforce'));

    expect(wrapped.effect.parameters).toBe(tool.parameters);
    await expect(wrapped.effect.execute({} as any, {} as any)).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not alter SDK v4 behavior when the legacy call starts with an aborted signal', async () => {
    const effects = { generate: vi.fn(), stream: vi.fn() };
    const originalModel = makeModel(effects);
    const legacy = new MastraLLMV1({ model: guardLegacyLanguageModel(originalModel) });
    const signal = AbortSignal.abort(new Error('aborted'));
    // AI SDK v4 currently invokes this mock provider despite a pre-aborted
    // signal. A2b must not change default-off legacy behavior or claim it fixes abort.
    const result = await legacy.__text({ ...runtimeArgs, abortSignal: signal });
    expect(result.text).toBe('provider output');
    expect(effects.generate).toHaveBeenCalledTimes(1);
  });
});
