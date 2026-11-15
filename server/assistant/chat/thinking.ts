// 思考档位：关、低、高（默认，和官方默认一样）、最高。按账号存在助手设置库（account-settings.ts），换设备也一样；
// 聊天时带了 thinking 就用这次的值并记成新的默认，没带用账号存的。一次聊天内不变（思考内容要原样回传）。
import { DEEPSEEK_THINKING_LEVELS, type DeepSeekThinking } from '../../../shared/ai/index.js';
import type { Actor } from '../../core/index.js';
import type { AssistantToolRegistry } from '../tool-registry.js';

const SETTING = 'assistant.thinking';
export const DEFAULT_THINKING: DeepSeekThinking = 'high';

export function thinkingLevel(registry: AssistantToolRegistry, actor: Actor): DeepSeekThinking {
  const saved = registry.accountSettings.get(actor.id, SETTING);
  const level = DEEPSEEK_THINKING_LEVELS.find((l) => l === saved);
  return level ?? DEFAULT_THINKING;
}

/** 这次带了档位：记成这个账号的默认，返回这次用的档位。 */
export function chooseThinking(registry: AssistantToolRegistry, actor: Actor, asked: DeepSeekThinking | undefined) {
  if (asked && asked !== thinkingLevel(registry, actor)) registry.accountSettings.set(actor.id, SETTING, asked);
  return asked ?? thinkingLevel(registry, actor);
}
