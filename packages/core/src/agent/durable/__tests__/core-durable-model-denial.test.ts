/**
 * A real DurableAgent model iteration must never recover an epoch/admission
 * denial through model retries, error processors or fallback providers.
 * This injects only the future test gate; runtime admission remains OFF.
 */
import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitterPubSub } from '../../../events/event-emitter';
import { Agent } from '../../agent';
import { createDurableAgent } from '../create-durable-agent';

const gate = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('../../../loop/shared/core-effect-admission', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../loop/shared/core-effect-admission')>();
  return {
    ...actual,
    beforeCoreModelProviderRequest: () => {
      gate.attempts++;
      return Promise.reject(
        new actual.CoreEffectAdmissionDeniedError('model-provider-request', 'synthetic lost GP lease'),
      );
    },
  };
});

const primaryCall = vi.fn(async () => {
  throw new Error('primary model must never run');
});
const fallbackCall = vi.fn(async () => {
  throw new Error('fallback model must never run');
});
const recoverError = vi.fn(async () => ({ retry: true }));

function makeDurable(pubsub: EventEmitterPubSub) {
  const primary = new MockLanguageModelV2({ doStream: primaryCall });
  const fallback = new MockLanguageModelV2({ doStream: fallbackCall });
  const agent = new Agent({
    id: 'durable-denied-core-model',
    name: 'Durable Denied Core Model',
    instructions: 'Respond briefly.',
    model: [
      { id: 'primary', model: primary, maxRetries: 3 },
      { id: 'fallback', model: fallback, maxRetries: 3 },
    ],
    errorProcessorDefaults: false,
    errorProcessors: [{ id: 'recover-admission', processAPIError: recoverError }],
    maxProcessorRetries: 2,
  });
  return createDurableAgent({ agent, pubsub });
}

afterEach(() => {
  gate.attempts = 0;
  vi.clearAllMocks();
});

describe('A2 real DurableAgent model admission terminal denial', () => {
  it('generate fails with one admission, zero retries or fallback provider calls', async () => {
    const pubsub = new EventEmitterPubSub();
    try {
      const durable = makeDurable(pubsub);
      await expect(durable.generate('hello', { modelSettings: { maxRetries: 3 } })).rejects.toBeTruthy();
      expect(gate.attempts).toBe(1);
      expect(primaryCall).not.toHaveBeenCalled();
      expect(fallbackCall).not.toHaveBeenCalled();
      expect(recoverError).not.toHaveBeenCalled();
    } finally {
      await pubsub.close();
    }
  });

  it('stream emits terminal error rather than retrying or producing successful content', async () => {
    const pubsub = new EventEmitterPubSub();
    try {
      const durable = makeDurable(pubsub);
      const { output, cleanup } = await durable.stream('hello', { modelSettings: { maxRetries: 3 } });
      const parts: Array<{ type: string; payload?: any }> = [];
      try {
        for await (const part of output.fullStream) parts.push(part);
      } finally {
        await cleanup();
      }
      expect(parts.some(part => part.type === 'error')).toBe(true);
      expect(parts.some(part => part.type === 'step-finish' && part.payload?.stepResult?.reason === 'error')).toBe(
        true,
      );
      expect(parts.some(part => part.type === 'text-delta')).toBe(false);
      expect(gate.attempts).toBe(1);
      expect(primaryCall).not.toHaveBeenCalled();
      expect(fallbackCall).not.toHaveBeenCalled();
      expect(recoverError).not.toHaveBeenCalled();
    } finally {
      await pubsub.close();
    }
  });
});
