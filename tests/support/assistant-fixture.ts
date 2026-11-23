import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ProblemLog } from '../../server/core/index.js';
import { RunLog } from '../../server/system/run-log.js';
import { PromptPresetManager } from '../../server/ai/prompt-presets.js';
import { AssistantManager, type AssistantDeps } from '../../server/assistant/manager.js';
import { AssistantTools } from '../../server/assistant/tools.js';
import type { ToolContext, ToolServices } from '../../server/assistant/tools/context.js';
import type { SystemDeps } from '../../server/assistant/tools/system.js';
import { assistantDefaultPreset } from '../../server/assistant/default-prompt.js';
import { ImportExecutionService } from '../../server/import/import-execution.js';
import { ReceiptAi } from '../../server/import/receipt-ai.js';
import { defaultPromptPreset } from '../../server/import/default-prompts/sales-order.js';
import { supplierDefaultPreset } from '../../server/import/default-prompts/supplier-delivery.js';
import { testImports } from './order-import-fixture.js';
import type { AgentOptions } from '../../server/assistant/chat/agent-config.js';
import type { AgentBudgetLimits } from '../../server/assistant/budget.js';
import type { AiSettingsManager } from '../../server/ai/settings-manager.js';
import type { ToolChatMessage } from '../../server/ai/chat-tools.js';
import type { AiTransport } from '../../server/ai/transport.js';
import type { PlanCard, ThreadView } from '../../shared/assistant/index.js';
import type { PromptModuleId } from '../../shared/ai/index.js';
import { fakeAiSettings, fakeKey, scriptedResult, turnFailure, type FakeChat } from './fake-deepseek.js';
import type { ChatCall } from './fake-deepseek-wire.js';
import type { FakeToolOptions } from './fake-deepseek-tools.js';
import { actor } from './actor-fixture.js';
/** 说话、点确认的账号（没登录时是 null） */
type Who = Parameters<AssistantManager['chat']>[2];
export const secret = fakeKey;
/** 用到才建的临时目录（不用就不在磁盘上留东西） */
const unusedDir = () => join(tmpdir(), 'erp-test-unused-' + randomUUID());
/** 空的运行日志：都指向临时目录里同一个不写的文件 */
const emptyRunLog = () => new RunLog(join(tmpdir(), 'erp-test-empty-run-log', 'run.log'));
/**
 * 助手只读工具要的服务（ToolServices 都必填）：只测业务工具时用这一套虚构的——AI 设置、出错记录、识别导入在内存里
 * （识别导入的目录用到才建），账号、机器人是空的，读登录记录会报错，本机运行，运行日志是空的，读代码限在程序目录。
 * 要测哪一样就在 over 里给真的。
 */
export function toolServices(store: Store, over: Partial<ToolServices> = {}): ToolServices {
  const ai = over.ai ?? makeSettings();
  return {
    ai,
    accounts: { listAccounts: () => [] },
    loginRecords: () => {
      throw new Error('这个测试没给登录记录');
    },
    bots: { views: () => [] },
    deployment: null,
    registry: { view: () => ({ tools: [] }) },
    imports: over.imports ?? testImports({ store, directory: unusedDir(), settings: ai, database: ':memory:' }),
    problems: new ProblemLog(),
    runLog: emptyRunLog(),
    source: { root: process.cwd(), denied: [] },
    ...over,
  };
}
/** 只测业务工具的工具外壳（AssistantTools），服务见 toolServices */
export const toolsOf = (store: Store, over: Partial<ToolServices> = {}) => new AssistantTools(store, toolServices(store, over));
/** 直接调系统维护工具（tools/system.ts）时给的：业务库、一个还没有备份的备份目录、几份识别工作区 */
export function systemDeps(store: Store, workspaces: unknown[] = []): SystemDeps {
  const dir = unusedDir();
  return { store, backingUp: false, backup: { dataDir: dir, backupRoot: join(dir, 'backups') }, imports: { status: () => ({ workspaces }) } };
}
/** 直接调各业务域读写函数时的上下文 */
export function ctxOf(store: Store, over: Partial<ToolServices> = {}): ToolContext {
  const services = toolServices(store, over),
    tools = new AssistantTools(store, services);
  return { store, services, tools, ops: tools.ops, flow: tools.flow, imports: services.imports };
}

/**
 * 三个提示词模块各自的管理器（正式由装配 createPromptManagers 打开）：给了的用给的，没给的现建在内存里，默认内容和正式的一样。
 * 现建的由调用方关（关了给的那几个也没关系：测试结束前不会再用）。
 */
export function promptTable(given: Partial<Record<PromptModuleId, PromptPresetManager>> = {}): Record<PromptModuleId, PromptPresetManager> {
  return {
    'sales-order': given['sales-order'] ?? new PromptPresetManager(':memory:', defaultPromptPreset),
    'supplier-delivery': given['supplier-delivery'] ?? new PromptPresetManager(':memory:', supplierDefaultPreset),
    assistant: given.assistant ?? new PromptPresetManager(':memory:', assistantDefaultPreset),
  };
}

/**
 * 建助手要的全套依赖（AssistantDeps 都必填）：业务库、AI 设置给定，三个提示词模块、到货识别、识别导入和正式导入现建在内存里，
 * 只读工具的服务见 toolServices，备份目录、工具设置库都是用到才有的；over 换掉其中几样。close() 关掉现建的。
 */
export function assistantDeps(store: Store, ai: AiSettingsManager, over: Partial<AssistantDeps> = {}) {
  const prompts = over.prompts ?? promptTable();
  const receiptAi = over.receiptAi ?? new ReceiptAi(store, ai, prompts['supplier-delivery']);
  const imports =
    over.imports ?? testImports({ store, directory: unusedDir(), settings: ai, promptPresets: prompts['sales-order'], receiptAi, database: ':memory:' });
  const { registry: _registry, ...services } = toolServices(store, { ai, imports });
  const dir = unusedDir();
  const deps: AssistantDeps = {
    ...services,
    store,
    prompts,
    receiptAi,
    execution: new ImportExecutionService(store, imports),
    backup: { dataDir: dir, backupRoot: join(dir, 'backups') },
    toolSettingsFile: ':memory:',
    ...over,
  };
  return {
    deps,
    close() {
      if (!over.imports) imports.close();
      if (!over.prompts) for (const manager of Object.values(prompts)) manager.close();
      services.problems.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
  /** 假 DeepSeek 的联网搜索、读网页这类接口怎么回（对话和联网用的是同一个 AI 设置） */
  web?: Pick<FakeToolOptions, 'search' | 'pages'>;
  /** 换掉建助手的几样依赖（见 assistantDeps），比如要测的出错记录、备份目录 */
  deps?: Partial<AssistantDeps>;
};
/**
 * 助手夹具：假 DeepSeek（fake）按 replies 依次回答，排完了说一句默认的话；内存库、内存提示词库。
 * say(会话, 话, 附加字段?, 账号?) 发一句话，事件记进 events；restart() 模拟程序重启（同一个库上重新建一个助手）。
 */
export function assistantFixture(replies: unknown[] = [], options: FixtureOptions = {}) {
  const requests: ChatCall[] = [],
    events: [string, Record<string, unknown>][] = [];
  const { settings, fake } = fakeAiSettings({
    ...options.web,
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
    built = assistantDeps(store, settings, options.deps),
    prompts = built.deps.prompts.assistant,
    opened: AssistantManager[] = [],
    open = () => {
      const opening = new AssistantManager(built.deps, { agent: options.agent, budget: options.budget });
      opened.push(opening);
      return opening;
    };
  let manager = open();
  return {
    store,
    settings,
    prompts,
    /** 建助手用的全套依赖（三个提示词模块的表、识别导入……） */
    deps: built.deps,
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
      built.close();
      store.close();
      settings.close();
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
