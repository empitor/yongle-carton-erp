// 助手的总装配：建好各个部件（工具、注册表、附件、会话记录、确认卡片、看页面），
// 对外给出会话的增删查、一轮对话（chat，各阶段在 chat/ 下）、确认卡片的改选、确认和拒绝。
import { randomUUID } from 'node:crypto';
import type { Actor, Store } from '../core/index.js';
import { AppError, many, rows, viaEntry } from '../core/index.js';
import { AUDIT_SOURCE } from '../../shared/core/index.js';
import type { AiSettingsManager, PromptPresetManager } from '../ai/index.js';
import type { ImportManager, ImportExecutionService, ReceiptAi } from '../import/index.js';
import type { MarkService } from '../business/index.js';
import { agentBudgetConfig, type AgentBudgetLimits } from './budget.js';
import { AssistantPromptEdit } from './prompt-edit.js';
import { AssistantConversations } from './conversation.js';
import { flushRemoteDeletions } from './remote-files.js';
import { AssistantPreviews } from './previews.js';
import { AssistantPageBridge } from './page-bridge.js';
import { AssistantTools } from './tools.js';
import { AssistantAttachments } from './attachments.js';
import { AssistantToolRegistry } from './tool-registry.js';
import { AssistantOrderWorkflow } from './order-workflow.js';
import { AssistantExtraTools } from './extra-tools.js';
import type { BackupSettings } from './tools/system.js';
import { openRun } from './chat/open-run.js';
import { askModel } from './chat/model-round.js';
import { runToolCalls } from './chat/tool-step.js';
import { noteSaid } from './chat/turn-trail.js';
import { closeRun, failRun, finishRun, recoverRuns } from './chat/finish-run.js';
import { thinkingLevel } from './chat/thinking.js';
import { agentConfig, type AgentConfig, type AgentOptions } from './chat/agent-config.js';
import { WORKFLOW_WRITES } from './chat/workflow-cards.js';
import { threadView } from './thread-view.js';
import type { AssistantStateView, ThreadView } from '../../shared/assistant/index.js';

/** 会话清单的一行 */
const recentThread = rows.assistant_threads.pick({ id: true, title: true }).extend({ updatedAt: rows.assistant_threads.shape.updated_at });
/**
 * 一轮对话这个请求自己的东西（chat 的最后几个参数）：推给页面的事件、现在登录的是谁（中途换了人、改了权限就停）、
 * proxy（从公网域名进来：只能在服务器本机做的操作，一键清空，生成方案时就说明）。
 */
type ChatLive = [emit: (event: string, data: unknown) => void, liveActor: () => Actor | null, options?: { proxy?: boolean }];

export class AssistantManager {
  readonly pageBridge = new AssistantPageBridge();
  readonly budgetLimits: AgentBudgetLimits;
  readonly agent: AgentConfig;
  readonly tools: AssistantTools;
  readonly attachments: AssistantAttachments;
  readonly registry: AssistantToolRegistry;
  readonly promptEdit: AssistantPromptEdit;
  orderWorkflow?: AssistantOrderWorkflow;
  readonly extras: AssistantExtraTools;
  readonly previews: AssistantPreviews;
  connectExtras(options: { marks?: MarkService; receiptAi?: ReceiptAi; backup?: BackupSettings }) {
    Object.assign(this.extras, options);
  }
  connectImports(imports: ImportManager, execution: ImportExecutionService) {
    this.extras.imports = imports;
    this.promptEdit.managers.set('sales-order', imports.promptPresets);
    this.tools.attachImports(imports);
    this.orderWorkflow = new AssistantOrderWorkflow(this.store, imports, execution, this.attachments);
  }
  readonly conversations: AssistantConversations;
  isBusy(id: string) {
    return this.conversations.busy.has(id);
  }
  constructor(
    readonly store: Store,
    readonly settings: AiSettingsManager,
    readonly prompts: PromptPresetManager,
    options: {
      toolSettingsFile?: string;
      budget?: Partial<AgentBudgetLimits>;
      /** 测试用的自动确认、会话上下文的数（chat/agent-config.ts） */
      agent?: AgentOptions;
    } = {},
  ) {
    this.agent = agentConfig(options.agent);
    this.budgetLimits = agentBudgetConfig(options.budget);
    this.tools = new AssistantTools(store);
    this.promptEdit = new AssistantPromptEdit(store, prompts);
    this.registry = new AssistantToolRegistry(options.toolSettingsFile, () => !!this.orderWorkflow);
    this.attachments = new AssistantAttachments(store);
    this.extras = new AssistantExtraTools(store, this.attachments);
    this.conversations = new AssistantConversations(store, this.attachments);
    // 流程类卡片确认后的执行：这时没有正在进行的对话，现建一份流程上下文（不发页面事件、不能中途停）
    this.previews = new AssistantPreviews(store, this.tools, this.registry, this.conversations, (plan, actor, _binding, threadId, previewId) => {
      const entry = WORKFLOW_WRITES[plan.tool];
      if (!entry || !('run' in entry)) throw new AppError('这类方案不能这样执行。', 409);
      return entry.run(
        this,
        {
          threadId,
          actor,
          requestId: previewId,
          files: this.attachments.select(threadId, [], true, actor),
          check: () => actor,
          signal: new AbortController().signal,
          emit: () => {},
        },
        plan.args,
      );
    });
    recoverRuns(store, this.conversations, this.previews);
  }
  /** 语音走 DeepSeek：填了密钥才能用。 */
  speechAvailable() {
    return this.settings.status().ready;
  }
  private require(who: Actor | null | undefined) {
    if (!who) throw new AppError('请先登录管理账号。', 401);
    return who;
  }
  state(who: Actor | null | undefined): AssistantStateView {
    const actor = this.require(who);
    return {
      speechAvailable: this.speechAvailable(),
      // 思考档位按账号存，聊天时带 thinking 改
      thinking: thinkingLevel(this.registry, actor),
      ai: this.settings.status(),
      tools: this.registry.view(actor).tools,
      toolRevision: this.registry.view().revision,
      canManageTools: actor.role === 'super_admin',
      threads: many(
        this.store.db,
        recentThread,
        'SELECT id,title,updated_at AS updatedAt FROM assistant_threads WHERE user_id=? ORDER BY updated_at DESC LIMIT 100',
        actor.id,
      ),
    };
  }
  create(who: Actor | null | undefined) {
    const actor = this.require(who),
      id = randomUUID(),
      now = new Date().toISOString();
    this.store.db
      .prepare('INSERT INTO assistant_threads(id,user_id,title,document,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, actor.id, '新会话', '{}', now, now);
    return this.view(id, actor);
  }
  view(id: string, who: Actor | null | undefined): ThreadView {
    return threadView(this, id, this.require(who));
  }
  clear(id: string, who: Actor | null | undefined) {
    const actor = this.require(who);
    this.conversations.clear(id, actor);
    void this.deleteRemoteFiles(actor);
    return this.view(id, actor);
  }
  removeThread(id: string, who: Actor | null | undefined) {
    const actor = this.require(who);
    this.conversations.removeThread(id, actor);
    void this.deleteRemoteFiles(actor);
  }
  /** 删一份附件：本地删掉，传到 DeepSeek 的那份跟着删。 */
  removeAttachment(id: string, who: Actor | null | undefined) {
    const removed = this.attachments.remove(id, who);
    void this.deleteRemoteFiles(this.require(who));
    return removed;
  }
  private remoteDeletion: Promise<unknown> = Promise.resolve();
  /**
   * 把这个账号记下了、还没删成的 DeepSeek 文件都删一遍（remote-files.ts）：删附件、清空会话、删会话之后，和每一轮对话开头各调一次；
   * 一个一个排着来，调不通的留着下次再试，不抛错。
   */
  deleteRemoteFiles(actor: Actor) {
    return (this.remoteDeletion = this.remoteDeletion.then(() =>
      flushRemoteDeletions(this.store, actor.id, (fileId) => this.settings.deleteFile(fileId)).catch(() => undefined),
    ));
  }
  cancel(id: string, who: Actor | null | undefined) {
    const actor = this.require(who);
    this.conversations.thread(id, actor);
    this.conversations.busy.get(id)?.abort();
  }
  /**
   * 一轮对话：把话和工具发给模型 → 执行它调的工具 → 结果原样还给它 → 它不再调工具时，正文原样给人。
   * 开头在 open-run，问模型在 model-round，执行工具在 tool-step，收尾在 finish-run。
   * 一轮最多问模型 maxSteps 次、最多执行 maxSteps 个命令（同一个数）；到了上限再问最后一次、不许调工具，让它自己说明做到哪、卡在哪。
   * openRun 出错时还没开始回复，不进下面的收尾。
   */
  async chat(
    id: string,
    raw: unknown,
    who: Actor | null | undefined,
    binding: string,
    ...live: ChatLive
  ): Promise<ThreadView> {
    const [emit, liveActor, options = {}] = live;
    // 助手这个入口：这一轮办的事审计都记成“助手”（工具拿到的账号都从这里和 liveActor 来）
    const opened = openRun(this, {
      id,
      raw,
      actor: viaEntry(this.require(who), AUDIT_SOURCE.assistant),
      binding,
      emit,
      liveActor: () => viaEntry(liveActor(), AUDIT_SOURCE.assistant),
      options,
    });
    if ('replayed' in opened) return opened.replayed;
    // 上次没删成的 DeepSeek 文件（当时接口调不通）、聊天里确认删掉的会话带的文件：这时再试一次，不等它
    void this.deleteRemoteFiles(opened.actor);
    const run = opened;
    try {
      const { maxSteps } = this.budgetLimits;
      for (let step = 0; step < maxSteps && run.facts.tools.length < maxSteps; step++) {
        const reply = await askModel(this, run, step);
        if (!reply.calls.length && !reply.note) return finishRun(this, run, reply, false);
        // 调命令前先说的话：页面上留着，不让下一次回复的字冲掉
        noteSaid(this, run, reply);
        await runToolCalls(this, run, reply);
      }
      return finishRun(this, run, await askModel(this, run, maxSteps, true), true);
    } catch (e) {
      return failRun(this, run, e);
    } finally {
      closeRun(this, run);
    }
  }
  /** 人在删除确认卡片上改“库存怎么处理”，规则见 previews.ts。 */
  changeDeletionPolicy(id: string, raw: unknown, who: Actor | null | undefined, binding: string) {
    return this.previews.changeDeletionPolicy(id, raw, who, binding);
  }
  /** 人在确认卡片上点“确认执行”，规则见 previews.ts 的 commit。review 由聊天接口填：是否从代理入口进来、是否已核验本人密码。 */
  execute(
    id: string,
    raw: unknown,
    who: Actor | null | undefined,
    binding: string,
    review: { proxy?: boolean; passwordVerified?: boolean } = {},
  ) {
    return this.previews.commit(id, raw, viaEntry(who, AUDIT_SOURCE.assistant), binding, review);
  }
  /** 人在确认卡片上点“不执行”：方案作废。 */
  reject(id: string, who: Actor | null | undefined, binding: string) {
    return this.previews.reject(id, who, binding);
  }
}
