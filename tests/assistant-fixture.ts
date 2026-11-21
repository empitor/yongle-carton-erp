import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { AssistantManager } from '../server/assistant/manager.js';
import { AssistantTools } from '../server/assistant/tools.js';
import type { ToolContext, ToolServices } from '../server/assistant/tools/context.js';
import { assistantDefaultPreset } from '../server/ai/default-prompts/assistant.js';
import type { AgentOptions } from '../server/assistant/chat/agent-config.js';
import type { AgentBudgetLimits } from '../server/assistant/budget.js';
import type { AiSettingsManager } from '../server/ai/settings-manager.js';
import type { ToolChatMessage } from '../server/ai/chat-tools.js';
import type { AiTransport } from '../server/ai/transport.js';
import type { PlanCard, ThreadView } from '../shared/assistant/index.js';
import { fakeAiSettings, fakeKey, scriptedResult, turnFailure, type FakeChat } from './fake-deepseek.js';
import type { ChatCall } from './fake-deepseek-wire.js';
import { actor } from './actor-fixture.js';
/** 说话、点确认的账号（没登录时是 null） */
type Who = Parameters<AssistantManager['chat']>[2];
export const secret = fakeKey;
export function ctxOf(store: Store, services: ToolServices = {}, imports?: ToolContext['imports']): ToolContext {
  const tools = new AssistantTools(store);
  tools.connect(services);
  if (imports) tools.attachImports(imports);
  return { store, services, tools, ops: tools.ops, flow: tools.flow, imports };
}

/** 存好假密钥、接上假 DeepSeek 的设置管理器；chat 返回模型这一轮的回复（对象会被转成 JSON 正文）。 */
export function makeSettings(chat?: FakeChat) {
  return fakeAiSettings({ chat }).settings;
}
/**
 * 把助手问模型的那一步（settings.completeChatTools）换成测试给的函数，不经过假 DeepSeek 的 HTTP：
 * 函数拿到这次发给模型的消息和中止信号，返回脚本回答（{ message, toolCalls… }，见 fake-deepseek.ts）或抛错。
 */
export function scriptModel(
  settings: AiSettingsManager,
  next: (messages: ToolChatMessage[], signal?: AbortSignal) => unknown,
) {
  settings.completeChatTools = async (messages, tools, signal) => scriptedResult(await next(messages, signal), tools);
}

/** 推给页面的事件内容都是对象（进度、正文片段、工具、效果……） */
export const eventData = z.record(z.string(), z.unknown());

type FixtureOptions = {
  /** 不给就和真实的一样（写入只出确认卡片，等人点）；只测业务流程本身的测试用 autoConfirmAssistant（自动确认） */
  agent?: AgentOptions;
  budget?: Partial<AgentBudgetLimits>;
  /** 自己写模型替身（不用 replies 排队）；requests、calls() 只记 replies 那种 */
  chat?: FakeChat;
  /** 接在已有的库上（测重开库） */
  store?: Store;
  /** 在假 DeepSeek 前面插一层（自己造流、拦住请求） */
  wrap?: (t: AiTransport) => AiTransport;
};
/**
 * 助手夹具：假 DeepSeek（fake）按 replies 依次回答，排完了说一句默认的话；内存库、内存提示词库。
 * say(会话, 话, 附加字段?, 账号?) 发一句话，事件记进 events；restart() 模拟程序重启（同一个库上重新建一个助手）。
 */
export function assistantFixture(replies: unknown[] = [], options: FixtureOptions = {}) {
  const requests: ChatCall[] = [],
    events: [string, Record<string, unknown>][] = [];
  const { settings, fake } = fakeAiSettings({
    wrap: options.wrap,
    chat:
      options.chat ??
      ((body, call) => {
        requests.push(call);
        // 没给回答时：这一轮有调用没做成，替身就把服务器交给它的原因说出来（真模型会用自己的话转述）
        const failure = turnFailure(body);
        return replies.shift() || { message: failure ? '没做成：' + failure : '已查询到服务器实际结果。', toolCalls: [] };
      }),
  });
  const store = options.store ?? new Store(':memory:'),
    prompts = new PromptPresetManager(':memory:', assistantDefaultPreset),
    opened: AssistantManager[] = [],
    open = () => {
      const opening = new AssistantManager(store, settings, prompts, { agent: options.agent, budget: options.budget });
      opened.push(opening);
      return opening;
    };
  let manager = open();
  return {
    store,
    settings,
    prompts,
    fake,
    replies,
    requests,
    events,
    get manager() {
      return manager;
    },
    /** 程序重启：同一个库上重新建一个助手（上一个不再用，可能还卡在半路） */
    restart() {
      manager = open();
    },
    calls: () => requests.length,
    input: (text: string, requestId: string, context?: unknown) => ({ requestId, text, context }),
    /** 发一句话，返回这一轮结束后的会话 */
    say: (threadId: string, text: string, extra: Record<string, unknown> = {}, who: Who = actor) =>
      manager.chat(threadId, { requestId: randomUUID(), text, ...extra }, who, 's', (e, d) => events.push([e, eventData.parse(d)]), () => who),
    close() {
      for (const m of opened) m.registry.close();
      store.close();
      settings.close();
      prompts.close();
    },
  };
}

/**
 * 开了自动确认的助手夹具：出了确认卡片立刻替人点确认（走和人点确认同一个执行函数；删除、清空照样只出卡片）。
 * 给只测业务流程本身的测试用；“不点确认就不落库”等界限集中在 tests/assistant-boundaries.test.ts。
 */
export const autoConfirmAssistant = (replies: unknown[] = []) => assistantFixture(replies, { agent: { autoConfirm: true } });

/** 最后一条回复里的第 index 张卡片；没有就让测试失败 */
export function lastCard(view: ThreadView, index = 0) {
  const plan = view.messages.at(-1)?.plans?.[index];
  if (!plan) throw new Error(`最后一条回复里没有第 ${index + 1} 张卡片`);
  return plan;
}
const digestSchema = z.looseObject({ args: z.looseObject({ deletionDigest: z.string().optional() }).optional() });
/** 删除卡片上的删除摘要（确认删除时要原样交回）；别的卡片没有 */
export const cardDigest = (plan: PlanCard) => digestSchema.parse(plan).args?.deletionDigest;
/** 人在确认卡片上点确认：最后一条回复里的第 index 张卡片（默认第一张）。返回执行结果。 */
export async function confirmCard(f: { manager: AssistantManager }, view: ThreadView, index = 0, who: Who = actor, binding = 'session') {
  const plan = lastCard(view, index);
  const digest = cardDigest(plan);
  return f.manager.execute(plan.id, { acknowledged: true, ...(digest ? { deletionDigest: digest } : {}) }, who, binding);
}
