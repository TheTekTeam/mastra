import type { LanguageModelV1, ToolSet } from '@internal/ai-sdk-v4';

import { CORE_EFFECT_ADMISSION_CAPABILITY, CoreEffectAdmissionGate } from '../../loop/shared/core-effect-admission';

/**
 * A2b opt-in legacy AI SDK v4 checkpoints.
 *
 * A request-scoped before-call check is insufficient: the SDK retries its
 * model's doGenerate/doStream and may initiate stream work after __stream
 * returns synchronously. Intercept the actual provider methods and tool
 * callbacks instead. There is deliberately no runtime enabler or trusted
 * run-scope resolver in this draft.
 */
const liveGate = new CoreEffectAdmissionGate(CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode);

export function guardLegacyLanguageModel<Model extends LanguageModelV1>(
  model: Model,
  gate: CoreEffectAdmissionGate = liveGate,
): Model {
  // Preserve exact provider identity, eager/stream timing and abort behavior
  // when disabled. In particular, no Promise or extra microtask is introduced.
  if (gate === liveGate && CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode === 'disabled') return model;

  return new Proxy(model, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if ((key !== 'doGenerate' && key !== 'doStream') || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await gate.beforeEffect('legacy-model-provider-request');
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function guardLegacyToolSet<Tools extends ToolSet>(
  tools: Tools,
  gate: CoreEffectAdmissionGate = liveGate,
): Tools {
  if (gate === liveGate && CORE_EFFECT_ADMISSION_CAPABILITY.runtimeMode === 'disabled') return tools;

  // Keep the SDK-visible schema, metadata and tool names; intercept only
  // executable callbacks, not tool definitions or provider-only tools.
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (!tool || typeof tool.execute !== 'function') return [name, tool];
      const execute = tool.execute;
      return [
        name,
        {
          ...tool,
          execute: async (...args: unknown[]) => {
            await gate.beforeEffect('legacy-native-tool-execute');
            return Reflect.apply(execute, tool, args);
          },
        },
      ];
    }),
  ) as Tools;
}
