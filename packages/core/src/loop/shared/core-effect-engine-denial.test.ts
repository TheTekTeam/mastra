import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { Agent } from '../../agent/agent';
import { globalRunRegistry } from '../../agent/durable/run-registry';
import { createDurableToolCallStep } from '../../agent/durable/workflows/steps/tool-call';
import { RequestContext } from '../../request-context';
import { createTool } from '../../tools';
import { PUBSUB_SYMBOL } from '../../workflows/constants';
import { createToolCallStep } from '../workflows/agentic-execution/tool-call-step';
import { CoreEffectAdmissionDeniedError } from './core-effect-admission';

// Inject only in this test module. Production capability remains hard-disabled;
// the real shared executeToolCall invokes this at the irreversible tool boundary.
vi.mock('./core-effect-admission', async importOriginal => {
  const real = await importOriginal<typeof import('./core-effect-admission')>();
  return {
    ...real,
    beforeCoreNativeToolExecute: () =>
      Promise.reject(new real.CoreEffectAdmissionDeniedError('shared-native-tool-execute', 'test-only denied epoch')),
  };
});
vi.mock('../../agent/durable/utils/resolve-runtime', async () => ({
  restoreRequestContext: (
    await vi.importActual<typeof import('../../agent/durable/utils/resolve-runtime')>(
      '../../agent/durable/utils/resolve-runtime',
    )
  ).restoreRequestContext,
  resolveTool: vi.fn(),
  toolRequiresApproval: vi.fn().mockResolvedValue(false),
  rebuildRunToolsFromMastra: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../agent/durable/stream-adapter', () => ({
  emitChunkEvent: vi.fn().mockResolvedValue(undefined),
  emitSuspendedEvent: vi.fn().mockResolvedValue(undefined),
}));

const runId = 'core-effect-denial-engine-run';
const messages = { get: { input: { aiV5: { model: () => [] } }, response: { db: () => [] }, all: { db: () => [] } } };
const toolExecute = vi.fn().mockResolvedValue({ unsafeEffect: true });
const publisher = { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), flush: vi.fn() };
afterEach(() => {
  globalRunRegistry.delete(runId);
  vi.clearAllMocks();
});

describe('A2 fatal tool admission propagates through both real engine steps', () => {
  it('modern engine tool step rejects, never serializes error or invokes native tool', async () => {
    const step = createToolCallStep({
      tools: { notify: { execute: toolExecute } },
      messageList: messages,
      controller: { enqueue: vi.fn() },
      runId,
      streamState: { serialize: () => '' },
    } as any);
    const inputData = { toolCallId: 'tool-1', toolName: 'notify', args: {} };
    const action = (step as any).execute({
      inputData,
      runId,
      workflowId: 'modern-engine',
      mastra: {},
      requestContext: new RequestContext(),
      state: {},
      setState: vi.fn(),
      retryCount: 2,
      tracingContext: {},
      getInitData: vi.fn(),
      getStepResult: vi.fn(),
      suspend: vi.fn(),
      bail: vi.fn(),
      abort: vi.fn(),
      engine: 'default',
      abortSignal: new AbortController().signal,
      validateSchemas: false,
    });
    await expect(action).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it('durable engine tool step rejects, never emits recoverable tool-error or calls tool', async () => {
    globalRunRegistry.set(runId, {
      tools: { notify: { id: 'notify', execute: toolExecute } },
      model: {},
    } as any);
    const step = createDurableToolCallStep();
    const action = (step as any).execute({
      inputData: { toolCallId: 'tool-2', toolName: 'notify', args: {} },
      mastra: { getLogger: () => undefined },
      requestContext: new Map(),
      suspend: vi.fn(),
      resumeData: undefined,
      getInitData: () => ({
        runId,
        agentId: 'agent-1',
        options: { requireToolApproval: false },
        state: { threadId: 'thread-1', resourceId: 'resource-1', threadExists: true, memoryConfig: undefined },
      }),
      [PUBSUB_SYMBOL]: publisher,
    });
    await expect(action).rejects.toBeInstanceOf(CoreEffectAdmissionDeniedError);
    expect(toolExecute).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

function toolCallingModel() {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: 'tool-calls',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      content: [{ type: 'tool-call', toolCallId: 'model-call-1', toolName: 'notify', input: '{}' }],
      warnings: [],
    }),
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'response-1', modelId: 'mock-model-id', timestamp: new Date(0) },
        { type: 'tool-call', toolCallId: 'model-call-1', toolName: 'notify', input: '{}', providerExecuted: false },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } },
      ]),
    }),
  });
}
function toolCallingAgent() {
  return new Agent({
    id: 'denial-agent',
    name: 'Denial Agent',
    instructions: 'Call notify.',
    model: toolCallingModel(),
    tools: {
      notify: createTool({
        id: 'notify',
        inputSchema: z.object({}),
        description: 'irreversible notification',
        execute: toolExecute,
      }),
    },
    errorProcessorDefaults: false,
  });
}
describe('A2 model-driven real Agent.generate and Agent.stream fatal denial', () => {
  it('real generate cannot treat denied native tool effect as a success', async () => {
    const agent = toolCallingAgent();
    await expect(agent.generate('notify now', { maxSteps: 2, modelSettings: { maxRetries: 0 } })).rejects.toThrow();
    expect(toolExecute).not.toHaveBeenCalled();
  });
  it('real stream publishes failure, never a successful tool result on denial', async () => {
    const agent = toolCallingAgent();
    const stream = await agent.stream('notify now', { maxSteps: 2, modelSettings: { maxRetries: 0 } });
    const parts = [];
    for await (const part of stream.fullStream) parts.push(part);
    expect(parts.some(part => part.type === 'error')).toBe(true);
    expect(parts.some(part => part.type === 'tool-result')).toBe(false);
    expect(toolExecute).not.toHaveBeenCalled();
  });
});
