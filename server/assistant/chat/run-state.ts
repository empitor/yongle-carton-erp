// 一轮对话（一条用户消息，或一次卡片确认后的“接着办”）从开始到回复的共用状态，和各阶段要用的服务。
// chat/ 下各阶段都只引这个文件，不引 manager.ts：AssistantManager 本身就满足 ChatServices，由它把自己传进来。
// 对话层只做四件事：把话和工具发给模型、执行它调的工具、把结果原样还给它、把它的回答原样给人。
// 服务器不猜用户的意思，不按字眼放行或拦截，不改写模型的回答；安全靠权限、写入一律出确认卡片、联网网址限制、步数上限。
import type { Actor, Store } from '../../core/index.js';
import type { AiSettingsManager, ChatTool, PromptPresetManager, ToolChatMessage } from '../../ai/index.js';
import type { DeepSeekThinking } from '../../../shared/ai/index.js';
import type { AssistantAttachment } from '../../../shared/core/index.js';
import type { AssistantSpeaker, InterimSaid, PlanCard, TurnFacts, WebSource } from '../../../shared/assistant/index.js';
import type { AgentBudgetLimits, AgentExecutionBudget } from '../budget.js';
import type { AssistantTools } from '../tools.js';
import type { AssistantToolRegistry } from '../tool-registry.js';
import type { AssistantAttachments } from '../attachments.js';
import type { AssistantPromptEdit } from '../prompt-edit.js';
import type { AssistantOrderWorkflow } from '../order-workflow.js';
import type { WorkflowContext } from '../order-import-state.js';
import type { AssistantExtraTools } from '../extra-tools.js';
import type { AssistantConversations } from '../conversation.js';
import type { AssistantPreviews } from '../previews.js';
import type { AssistantPageBridge } from '../page-bridge.js';
import type { ChatInput } from './input.js';
import type { UploadedFiles } from './model-attachments.js';
import type { AgentConfig } from './agent-config.js';
import type { DirectoryCommand } from '../command-directory.js';
import type { ThreadView } from '../../../shared/assistant/index.js';

/** 一轮对话要用的服务（AssistantManager 上的同名成员）。 */
export interface ChatServices {
  readonly store: Store;
  readonly settings: AiSettingsManager;
  readonly prompts: PromptPresetManager;
  readonly budgetLimits: AgentBudgetLimits;
  readonly tools: AssistantTools;
  readonly registry: AssistantToolRegistry;
  readonly attachments: AssistantAttachments;
  readonly promptEdit: AssistantPromptEdit;
  readonly orderWorkflow: AssistantOrderWorkflow;
  readonly extras: AssistantExtraTools;
  readonly conversations: AssistantConversations;
  readonly previews: AssistantPreviews;
  readonly pageBridge: AssistantPageBridge;
  /** 会话给页面看的样子（回复结束、同一请求重发时返回）。 */
  view(id: string, who: Actor | null | undefined): ThreadView;
  /** 测试用的自动确认、命令怎么发给模型、会话上下文的数（agent-config.ts）。 */
  readonly agent: AgentConfig;
}

/** 模型要调的一个工具（名字已换回注册表名，参数是对象） */
export type ToolCall = { name: string; args: Record<string, unknown> };
/** 模型一次回复读出来的样子 */
export type ModelReply = {
  /** 正文（去掉说话人标记） */
  message: string;
  speaker?: AssistantSpeaker;
  /** 另一位补的话 */
  relay?: { speaker: AssistantSpeaker; text: string }[];
  /** 要执行的调用和各自的 tool_call_id */
  calls: { call: ToolCall; id: string }[];
  /** 有调用没执行（没这个工具、参数不是 JSON）时给模型的说明：等这条助手消息的工具结果都回完再接上 */
  note?: string;
};

/** 这一轮对话的状态：openRun 建好，各阶段共用。 */
export type ChatRun = {
  readonly id: string;
  readonly actor: Actor;
  readonly binding: string;
  readonly emit: (event: string, data: unknown) => void;
  /** proxy：从公网域名进来。只能在服务器本机做的操作（一键清空）生成方案时就说明。 */
  readonly options: { proxy?: boolean };
  readonly input: ChatInput;
  /** 这个会话能用的附件（这一轮带的和以前的） */
  readonly files: AssistantAttachment[];
  /** 停止和超时共用的中断开关。 */
  readonly controller: AbortController;
  /** 超时定时器；到点时 expired 由定时器改成 true，失败收尾按它区分“超时”和“已停止”。 */
  readonly deadline: { timer?: ReturnType<typeof setTimeout>; expired: boolean };
  /** 核对没有被停止、登录身份和权限没变，返回当前身份。 */
  readonly check: () => Actor;
  /** 流程类工具（识别、导出、唛头、收件箱……）要的这一轮的上下文 */
  readonly workflow: WorkflowContext;
  /** 发给模型的对话；各阶段往里追加，压缩是原地换掉前面一段。 */
  readonly messages: ToolChatMessage[];
  readonly turn: TurnState;
  readonly promptUsage: ReturnType<PromptPresetManager['snapshot']>['usage'];
  readonly budget: AgentExecutionBudget;
  /** 这一轮服务器实际做了什么（存进回复，页面固定位置显示） */
  readonly facts: TurnFacts;
  /** 这一轮出的确认卡片（页面画卡片用的完整内容）、可以跳转的记录链接 */
  readonly plans: PlanCard[];
  readonly links: { url: string; label: string }[];
  /** 这一轮直接导出的文件（不改单据状态的导出），页面在回复下面放下载卡片 */
  readonly exports: unknown[];
  /** 这一轮模型调命令前先说的话、联网搜到和读过的网页（按网址）：收尾存进回复给页面看（turn-trail.ts） */
  readonly interim: InterimSaid[];
  readonly sources: Map<string, WebSource>;
  /** 这一轮是谁在说（模型正文开头的标记） */
  speaker?: AssistantSpeaker;
  /** 接口报过上下文超长、已经强制压缩过一次。 */
  overflowRecovered: boolean;
};

/** 这一轮发给模型的工具和思考档位，和存进会话历史要用的位置、上传记录。 */
export type TurnState = {
  readonly thinking: DeepSeekThinking;
  /** 这一轮发给模型的工具：常用命令加三个通用工具（command-tools.ts） */
  readonly tools: ChatTool[];
  /** 发给模型的名字 → 注册表名字（通用工具就是它自己的名字） */
  readonly registryName: ReadonlyMap<string, string>;
  /** 这个账号这一轮能用的命令（目录、查用法、执行命令都按它） */
  readonly commands: readonly DirectoryCommand[];
  /** messages 开头有几条系统消息（固定提示词、本机管理员说明、日期、长期记忆）：压缩时它们永远不动。 */
  readonly headLength: number;
  /** 这一轮在 messages 里从第几条开始（用户这句话），没压缩过时收尾从这里起存进会话历史。 */
  readonly turnStart: number;
  readonly userMessageId: string;
  /** 历史里引用过的上传文件：这一轮要用同一份附件时先找里面还没到期的；压缩把历史并进这一轮的记录时并进 uploaded。 */
  readonly historyFiles: UploadedFiles;
  /** 这一轮用到的上传到 DeepSeek 的附件文件（编号 → 哪份附件、名字、到期时间），存进历史，回放时判断要不要重新上传。 */
  readonly uploaded: UploadedFiles;
  /** 这一轮里已经开始执行的调用（tool_call_id → 是查询还是会改东西的）：存进历史时，停在半路的调用按它分“没有执行”“查询中断”“结果不明” */
  readonly started: Map<string, 'read' | 'write'>;
  /** 这一轮里压缩过才有（compact-run.ts）：这一轮的记录从留下来的第一条消息存起；checkpoint 是顶替更早那一段的要点，只剪了工具结果时没有。 */
  restart?: { checkpoint?: string };
};
