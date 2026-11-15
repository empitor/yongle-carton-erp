import { z } from 'zod';
import { exportFileSchema, interimSaid, readSpeaker, type AssistantSpeaker, type InterimSaid } from '../../shared/assistant/index';

/*
 * 一次回复的事件流里各种事件带的内容（服务端 server/assistant/chat/、page-bridge.ts、order-import-state.ts 发的）。
 * 事件流不走接口表，读到的是 unknown，按事件种类在这里认：页面要看的项列出来，服务端不一定带的写可选，别的键不管。
 * 注意 zod 4 里对象的 z.unknown() 键也是必填的，可能没有的要写 .optional()（tests/assistant-page-reads-server.test.ts 用服务端真实发的事件守着）。
 * 最后的 result（整份会话）由读事件流的 readEventStream 交回；page_command 的内容由执行它的 assistant-page.ts 认。
 */

/** 模型进度（shared/ai 的 AiProgress，加上重发第几次、第几轮） */
const progressEvent = z.object({
  stage: z.string().optional(),
  attempt: z.number().optional(),
  receivedChars: z.number().optional(),
  reasoningChars: z.number().optional(),
});
/** 排队（server/ai/work-queue.ts 的 QueueState） */
const queueEvent = z.object({ state: z.string().optional(), position: z.number().optional() });
/** 命令开始跑、跑完：叫法由服务器给（“联网搜索：……”） */
const toolEvent = z.object({ state: z.string().optional(), label: z.string().optional() });
/** 让页面跟着做的事：下载文件（导出好的文件，exportFileSchema）、刷新、跳到某页 */
const effectEvent = z.object({
  type: z.string().optional(),
  file: exportFileSchema.optional(),
  workspaceId: z.string().optional(),
  module: z.unknown().optional(),
  url: z.unknown().optional(),
});
const speakerEvent = z.object({ speaker: z.unknown().optional() });
const draftEvent = z.object({ text: z.string() });
const reasoningEvent = z.object({ round: z.number().optional(), text: z.string().optional() });
const errorEvent = z.object({ message: z.string().optional() });

export type ChatProgress = z.output<typeof progressEvent>;
export type ChatEffect = z.output<typeof effectEvent>;
export type ExportFile = z.output<typeof exportFileSchema>;

/** 认一条事件的内容。服务端和页面同版本发布，对不上就是出了错：说清楚、停下这次回复（读事件流的地方会重新载入核实） */
function read<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error('助手回复里有一条消息的内容对不上，请重新载入历史核实执行结果。');
  return parsed.data;
}

export const chatEvent = {
  progress: (d: unknown): ChatProgress => read(progressEvent, d),
  queue: (d: unknown) => read(queueEvent, d),
  tool: (d: unknown) => read(toolEvent, d),
  effect: (d: unknown): ChatEffect => read(effectEvent, d),
  /** 谁在说：模型可能写代号或中文名，认不出是 undefined */
  speaker: (d: unknown): AssistantSpeaker | undefined => readSpeaker(read(speakerEvent, d).speaker),
  draft: (d: unknown) => read(draftEvent, d).text,
  said: (d: unknown): InterimSaid => read(interimSaid, d),
  reasoning: (d: unknown) => read(reasoningEvent, d),
  error: (d: unknown) => read(errorEvent, d).message,
};

/**
 * 认一份导出好的文件（消息里的导出文件、导出卡片执行结果里的 file，和事件流 effect 的 file 同一份结构）。
 * 对不上说清楚：文件没下载，单据状态也没改。
 */
export function readExportFile(value: unknown): ExportFile {
  const parsed = exportFileSchema.safeParse(value);
  if (!parsed.success) throw new Error(exportFileMismatch);
  return parsed.data;
}
/** 导出文件的信息对不上时的说法（聊天记录里那张下载卡片也用它） */
export const exportFileMismatch = '导出文件的信息对不上，文件没有下载、单据状态没改；请到单据导出里重新导出。';
