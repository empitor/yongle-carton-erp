// 助手对话在实例启动时定下的两样：测试用的自动确认、会话上下文的几个数。都不读环境变量。
// 自动确认只有测试经 AssistantManager 的 agent 选项能开（只测业务流程本身的测试，免得每条都手点确认）：
// 出了卡片立刻走和人点确认同一个执行函数；删除、清空照样只出卡片。生产代码和脚本都不传（tests/assistant-boundaries.test.ts 守着）。
// 会话上下文的数默认用 session-limits.ts 那一份，测试可以调小。
import { SESSION } from './session-limits.js';

export type AgentConfig = {
  autoConfirm: boolean;
  /** 会话上下文的几个数（session-limits.ts） */
  session: typeof SESSION;
};
export type AgentOptions = { autoConfirm?: boolean; session?: Partial<typeof SESSION> };

export function agentConfig(options: AgentOptions = {}): AgentConfig {
  return {
    autoConfirm: options.autoConfirm ?? false,
    session: { ...SESSION, ...options.session },
  };
}
