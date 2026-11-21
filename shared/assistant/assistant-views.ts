// 助手接口回给页面的几种样子（接口表 assistant-api.ts 用），和消息 document 列的结构（服务端写入、读出、给页面都按它）。
// 只能是 JSON 原样来回的值：各命令自己的结果、卡片上改之前改之后的样子这类不定形的部分写成 JsonView。
import { z } from 'zod';
import type { AiStatus, DeepSeekThinking } from '../ai/index.js';
import type { AssistantAttachment } from '../core/index.js';
import { assistantSpeakers } from './assistant-personas.js';
import type { InterimSaid, TurnFacts, WebSource } from './assistant-task.js';

/** JSON 能原样来回的值（对象里可以有可选字段，序列化时去掉） */
export type JsonView = string | number | boolean | null | readonly JsonView[] | { readonly [key: string]: JsonView | undefined };
/** 校验一个值是 JSON（zod 的 json：没有 undefined、函数、日期这类） */
export const jsonValue = z.json();

/**
 * 助手导出的一份文件：单据导出交回的导出状态（shared/documents 的 DocumentExportStatus）里页面下载、显示要用的几项。
 * 回复事件流的下载（effect 的 file）、消息里的导出文件（exports 的每一项）、导出卡片执行结果的 file 都是它，页面按这份结构认。
 * 共用-助手引不到 shared/documents，照那边的样子写在这里；别的键原样留着。
 */
export const exportFileSchema = z.looseObject({
  exportId: z.string(),
  url: z.string(),
  sha256: z.string(),
  filename: z.string(),
  markOrdered: z.boolean(),
  markShipped: z.boolean(),
});

const speaker = z.enum(assistantSpeakers);
const turnFacts: z.ZodType<TurnFacts, TurnFacts> = z.object({
  tools: z.array(z.string()),
  reads: z.number(),
  cards: z.array(z.object({ id: z.string(), label: z.string() })),
  executed: z.array(z.object({ label: z.string(), memoryId: z.number().optional() })),
  failed: z.array(z.object({ label: z.string(), message: z.string() })),
});
/** 调命令前先说的一段话（存在消息里，回复时也单独推给页面：事件流的 said） */
export const interimSaid: z.ZodType<InterimSaid, InterimSaid> = z.object({ speaker: speaker.optional(), text: z.string() });
const webSource: z.ZodType<WebSource, WebSource> = z.object({
  title: z.string(),
  url: z.string(),
  date: z.string().optional(),
  read: z.boolean().optional(),
});
/** 确认卡片：编号、命令、标题；别的（参数、改之前改之后、删除的说明标记……）各命令不同，原样是 JSON */
export const planCardSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    label: z.string(),
    /** 服务器算好的、卡片上逐行给人看的内容 */
    summary: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  })
  .catchall(jsonValue);
export type PlanCard = z.output<typeof planCardSchema>;

/** 消息 document 里原样给页面看的字段 */
const shownFields = {
  /** 谁说的：模型可能写代号或中文名，读的时候由 readSpeaker 认 */
  speaker: jsonValue.optional(),
  relay: z.array(z.object({ speaker, text: z.string() })).optional(),
  interim: z.array(interimSaid).optional(),
  sources: z.array(webSource).optional(),
  facts: turnFacts.optional(),
  links: z.array(z.object({ url: z.string(), label: z.string() })).optional(),
  /** 直接导出的文件（单据导出的导出状态，页面按 exportFileSchema 认），页面放下载卡片 */
  exports: z.array(jsonValue).optional(),
  promptUsage: z.object({ id: z.string(), name: z.string(), revision: z.number(), hash: z.string() }).optional(),
  requestId: z.string().optional(),
  /** 到了步数上限、模型自己说明做到哪的回复 */
  limit: z.literal(true).optional(),
  error: z.literal(true).optional(),
  card: z.object({ id: z.string(), decision: z.string() }).optional(),
  /** 用户说这句话时页面上选中的记录 */
  context: z.object({ page: z.string(), module: z.string().optional(), id: z.number().optional() }).optional(),
};
const shownMessage = z.object(shownFields);

/**
 * 消息的 document 列（assistant_messages.document）：服务端 conversation.ts 的 message 写（参数类型是 z.input），
 * 读出来给页面看（thread-view.ts）。hidden 的不显示；turn 是这一轮的原样记录，chat/session-history.ts 写、只给模型回放，
 * 结构在那里，这里不校验、不给页面。
 */
export const storedMessageSchema = z.object({
  ...shownFields,
  plans: z.array(planCardSchema).optional(),
  /** 卡片确认、拒绝后的“接着办”：不显示 */
  hidden: z.literal(true).optional(),
  turn: z.unknown().optional(),
});

/**
 * 卡片现在的状态（服务端 chat/card-changes.ts 的 cardStates 算，存进一轮记录的也是它们）：
 * 已执行、执行没成、发出去了结果不明、作废（人点了不执行）、过期、等确认
 */
export const cardStateNames = ['executed', 'failed', 'unknown', 'cancelled', 'expired', 'waiting'] as const;
export type CardStateName = (typeof cardStateNames)[number];

/** 会话里给页面看的一条消息：卡片标上现在的状态（chat/card-changes.ts 的 cardStates） */
export type MessageView = z.output<typeof shownMessage> & {
  id: string;
  role: string;
  text: string;
  at: string;
  plans?: (PlanCard & { state: CardStateName | undefined })[];
  attachments: AssistantAttachment[];
};

/** 会话里的一份识别任务（server/assistant/order-import-state.ts 的 Task，去掉只给服务器用的 observed） */
export type WorkflowTaskView = {
  id: string;
  workspaceId: string;
  fileName: string;
  fileHash: string;
  state: string;
  updatedAt: string;
  error?: string;
  attachmentId?: string;
  fromInbox?: true;
  recognitionRequest?: string;
  focusLine?: number;
  /** 正式导入的预览、识别或导入的结果：各种任务样子不同 */
  preview?: JsonView;
  previewRequest?: string;
  previewRevision?: number;
  result?: JsonView;
};
/** 这个会话里的识别任务和当前是哪一份 */
export type WorkflowView = { activeId?: string; tasks: WorkflowTaskView[] };

/** 打开会话、回复结束、同一请求重发时回的会话（server/assistant/thread-view.ts） */
export type ThreadView = {
  id: string;
  title: string;
  orderWorkflow: WorkflowView | undefined;
  messages: MessageView[];
  pendingAttachments: AssistantAttachment[];
  previousAttachments: AssistantAttachment[];
  busy: boolean;
  ai: AiStatus;
};

/** 工具的参数结构（zod 生成的 JSON Schema）：最外层是对象，字段表、必填项看得出来，别的原样 */
const toolParametersShape = z
  .object({ properties: z.record(z.string(), jsonValue).optional(), required: z.array(z.string()).optional() })
  .catchall(jsonValue);
type ToolParameters = z.output<typeof toolParametersShape>;
/** 校验用 toolParametersShape，交出去的是原来那个对象：字段先后不变，发给模型的工具定义逐字节不变 */
export const toolParametersSchema = z.custom<ToolParameters>((v) => toolParametersShape.safeParse(v).success, '不是参数结构');

/** 工具清单里的一条（server/assistant/tool-registry.ts 的 view） */
export type ToolView = {
  name: string;
  description: string;
  risk: string;
  kind: 'read' | 'business' | 'workflow';
  pluginId: string;
  module: string;
  /** 参数结构（JSON Schema） */
  parameters: ToolParameters;
  enabled: boolean;
  pluginEnabled: boolean;
  toolEnabled: boolean;
  permitted: boolean;
  permissions: string[];
  permissionNote: string;
  permissionReason: string;
  usable: boolean;
  unavailableReasons: string[];
  status: string;
};
export type ToolsView = { revision: number; tools: ToolView[] };
/** 工具清单页：多带每个工具最后一次执行的情况、能不能启停 */
export type ToolsPage = ToolsView & {
  canManage: boolean;
  tools: (ToolView & { lastExecution: { state: string; at: string } | null })[];
};
export type PluginView = { id: string; name: string; description: string; enabled: boolean; tools: ToolView[] };
export type PluginsView = { revision: number; plugins: PluginView[] };

/** 助手窗口打开时要的：语音能不能用、思考档位、AI 配置状态、工具、最近的会话 */
export type AssistantStateView = {
  speechAvailable: boolean;
  thinking: DeepSeekThinking;
  ai: AiStatus;
  tools: ToolView[];
  toolRevision: number;
  canManageTools: boolean;
  threads: { id: string; title: string; updatedAt: string }[];
};
