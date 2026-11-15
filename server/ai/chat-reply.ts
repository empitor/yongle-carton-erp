import { z } from 'zod';

/**
 * 对话接口（/chat/completions）回答里我们认的几栏。整包回答和流式的每一块都是这个样子，
 * 只是消息在 message（整包）或 delta（流式）里。认不出的栏当作没有，别的栏丢掉；
 * 正文、思考、工具调用怎么拼、什么算出错在 chat-exchange.ts。
 */

/** 可有可无的文字栏：不是文字的当作没有 */
const optionalText = z.string().optional().catch(undefined);

/** 工具调用的一块：流式时第一块带 id、函数名，后面的块只续 arguments；index 指是第几个调用 */
const toolCallChunkSchema = z
  .object({
    index: z.number().optional().catch(undefined),
    id: optionalText,
    function: z.object({ name: optionalText, arguments: optionalText }).catch({}),
  })
  .catch({ function: {} });
export type ToolCallChunk = z.output<typeof toolCallChunkSchema>;

/** 一条消息里的增量或整条内容；不是对象的当作空 */
const replyPartSchema = z
  .object({
    content: optionalText,
    reasoning_content: optionalText,
    refusal: optionalText,
    title: optionalText,
    /** 旧式的函数调用：我们从不请求，收到就按协议错误处理 */
    function_call: z.unknown().optional(),
    tool_calls: z.array(toolCallChunkSchema).optional().catch(undefined),
  })
  .catch({});
export type ReplyPart = z.output<typeof replyPartSchema>;

const replyChoiceSchema = z
  .object({
    delta: replyPartSchema.optional(),
    message: replyPartSchema.optional(),
    finish_reason: z.unknown().optional(),
  })
  .catch({});
export type ReplyChoice = z.output<typeof replyChoiceSchema>;

/** 整包回答；不是对象的按“返回的内容格式不对”处理 */
export const chatReplySchema = z.object({
  id: optionalText,
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
  choices: z.array(replyChoiceSchema).catch([]),
});
export type ChatReply = z.output<typeof chatReplySchema>;

/** 流式的一块：不是对象的当作什么都没带 */
export const chatChunkSchema = chatReplySchema.catch({ choices: [] });
