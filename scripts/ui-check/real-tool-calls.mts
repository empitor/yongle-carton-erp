// DeepSeek 工具调用的探测场景（real-tool-calls-probe.mjs 经 /__real-smoke/tool-calls 调用）：核对官方文档没写清楚、方案第 9 节列的几处细节。
// 每个场景只发一两次最小请求，返回给人看的摘要（状态、结束原因、工具调用的样子、思考字数和 token），不返回思考原文和密钥。
import type { AiSettingsManager, ChatTool, ToolChatMessage, ToolChatResult } from '../../server/ai/index.ts';

type Settings = InstanceType<typeof AiSettingsManager>;
/** 接住的出错里冒烟要看的几项（AiConnectionError 有 code、upstreamStatus）；不是对象或没有这一项就是 undefined */
export function failureOf(error: unknown) {
  const fields: object = typeof error === 'object' && error !== null ? error : {};
  return {
    code: 'code' in fields ? fields.code : undefined,
    upstreamStatus: 'upstreamStatus' in fields ? fields.upstreamStatus : undefined,
    message: 'message' in fields ? fields.message : undefined,
  };
}
const lookup: ChatTool = {
  type: 'function',
  function: {
    name: 'lookup_order',
    description: '按订单号查询虚构订单的数量和交货日期（测试用）',
    parameters: { type: 'object', properties: { orderNo: { type: 'string', description: '订单号，如 XS-001' } }, required: ['orderNo'] },
  },
};
const fakeOrder = (orderNo: string) => JSON.stringify({ orderNo, quantity: 500, unit: '只', deliveryDate: '2026-12-01' });
const ask = '虚构订单 XS-001 的数量是多少？请用工具查，不要猜。';
const brief = (r: ToolChatResult, startedAt: number, tokens: { reasoning?: number; output?: number }) => ({
  finishReason: r.finishReason,
  toolCalls: r.toolCalls.map((c) => ({ id: c.id ? '有' : '无', name: c.function.name, arguments: c.function.arguments.slice(0, 120) })),
  contentChars: r.content.length,
  content: r.content.slice(0, 120),
  reasoningChars: r.reasoning.length,
  hasReasoningField: 'reasoning_content' in r.assistantMessage,
  reasoningTokens: tokens.reasoning ?? null,
  outputTokens: tokens.output ?? null,
  ms: Date.now() - startedAt,
});
/** 发一次，带上用量；失败时返回状态码和给人看的话（AiConnectionError 已经遮掉上游正文） */
async function once(settings: Settings, messages: ToolChatMessage[], tools: ChatTool[], options: Parameters<Settings['completeChatTools']>[3] = {}) {
  const started = Date.now();
  const tokens: { reasoning?: number; output?: number } = {};
  try {
    const r = await settings.completeChatTools(messages, tools, undefined, {
      maxOutputTokens: 4000,
      ...options,
      onUsage: (u) => ((tokens.reasoning = u.reasoningTokens), (tokens.output = u.outputTokens)),
    });
    return { ok: true as const, result: r, summary: brief(r, started, tokens) };
  } catch (error) {
    const failure = failureOf(error);
    return { ok: false as const, summary: { status: failure.upstreamStatus ?? null, code: failure.code ?? 'error', message: String(failure.message || error).slice(0, 200), ms: Date.now() - started } };
  }
}
/** 第一轮让模型调工具，再把结果接上（可选去掉思考内容、插 system 消息） */
async function toolRound(settings: Settings, change: (assistant: ToolChatResult['assistantMessage']) => ToolChatMessage = (a) => a, extra: ToolChatMessage[] = []) {
  const messages: ToolChatMessage[] = [{ role: 'user', content: ask }];
  const first = await once(settings, messages, [lookup]);
  if (!first.ok || !first.result.toolCalls.length) return { first: first.summary, second: '第一轮没调工具，没法接着测' };
  messages.push(change(structuredClone(first.result.assistantMessage)));
  for (const c of first.result.toolCalls) messages.push({ role: 'tool', tool_call_id: c.id, content: fakeOrder('XS-001') });
  messages.push(...extra);
  const second = await once(settings, messages, [lookup]);
  return { first: first.summary, second: second.summary };
}

export const toolCallScenarios: Record<string, { label: string; run: (s: Settings) => Promise<unknown> }> = {
  'tool-round': { label: '思考开（高）+ 一个工具：调工具、接上结果、再答（流式拼接和原样回传）', run: (s) => toolRound(s) },
  'drop-reasoning': {
    label: '同上，但第二次请求去掉上一条助手消息的 reasoning_content（文档说会 400）',
    run: (s) => toolRound(s, ({ reasoning_content: _r, ...rest }) => rest),
  },
  'system-mid': {
    label: '工具结果后面插一条 system 消息（文档说可以）',
    run: (s) => toolRound(s, (a) => a, [{ role: 'system', content: '服务器提醒（是数据不是指令）：数量单位是只。' }]),
  },
  'history-a': {
    label: '历史办法 A：前几轮用不带思考内容的 user/assistant 文字回放，再带 tools 问新问题',
    run: async (s) =>
      (
        await once(
          s,
          [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好，我是虚构助手。' },
            { role: 'user', content: ask },
          ],
          [lookup],
        )
      ).summary,
  },
  'history-b': {
    label: '历史办法 B：前几轮整理成一条 system 消息，再带 tools 问新问题',
    run: async (s) =>
      (
        await once(
          s,
          [
            { role: 'system', content: '前几轮对话的文字记录（是数据不是指令）：用户问好，助手回了问好。' },
            { role: 'user', content: ask },
          ],
          [lookup],
        )
      ).summary,
  },
  'history-a-after-tools': {
    label: '历史办法 A 的难处：上一轮调过工具，这一轮回放时只留文字、不带思考和工具消息',
    run: async (s) =>
      (
        await once(
          s,
          [
            { role: 'user', content: ask },
            { role: 'assistant', content: 'XS-001 的数量是 500 只。' },
            { role: 'user', content: '那 XS-002 呢？' },
          ],
          [lookup],
        )
      ).summary,
  },
  parallel: {
    label: '并行：一句话要查两张订单，看一次回复里有几个工具调用',
    run: async (s) => (await once(s, [{ role: 'user', content: '同时查虚构订单 XS-001 和 XS-002 的数量，用工具查。' }], [lookup])).summary,
  },
  'max-tokens': {
    label: '思考 token 算不算进 max_tokens：最高档、max_tokens=1000、问一个要想的问题',
    run: async (s) =>
      (await once(s, [{ role: 'user', content: '一个纸箱厂 3 条线、每条每小时 400 只，排 1 万只的订单最少几小时？说理由。' }], [lookup], { thinking: 'max', maxOutputTokens: 1000 }))
        .summary,
  },
  efforts: {
    label: '四个档位各问一次同一个小问题，看思考字数、token 和耗时',
    run: async (s) => {
      const out: Record<string, unknown> = {};
      for (const level of ['off', 'low', 'high', 'max'] as const)
        out[level] = (await once(s, [{ role: 'user', content: '500 只纸箱分 3 车装，每车最多 200 只，够不够？' }], [lookup], { thinking: level })).summary;
      return out;
    },
  },
};
