// 会话太长时压缩（纯逻辑，量大小、让模型写摘要都从参数传进来，用纯数据就能测）：
// 1. 整个请求没到线：什么都不做，连剪枝也不做；
// 2. 到线了先剪太长的工具结果（不调模型），够了就不写摘要；
// 3. 还超：从最新往回留一段尾巴，更早的一段交给模型写成要点，包成一条 user 消息顶替那一段；
//    摘要不比原文小就作废；压完再量，还超就再压，最多再压 compactionRetries 次；
// 4. 写摘要出错不影响已经做成的部分：返回做到哪一步和出错原因，调用方记下来、照常发请求。
// force（接口明确报上下文超长时用）：不管到没到线都剪，留尾按 0 再压一次。
//
// 移植自 DeepSeek Harness（https://github.com/deepseek-ai/deepseek-harness）
//   packages/compaction/compaction-basic/src/index.ts（compactIfNeeded、compactPressure）
//   packages/compaction/compaction-basic/src/region.ts（summarizeCompaction 里“不变小就作废”、提交顺序）
// Copyright (c) 2026 DeepSeek，MIT 许可，全文见仓库根目录 THIRD_PARTY_NOTICES.md。
// 改动：它按会话事件日志改写、用起止事件加锁；我们一个会话同一时刻只有一轮在跑，直接返回新的消息数组。
// 触发线不按模型窗口的比例算，用 session-limits.ts 定死的数。
import type { ToolChatMessage } from '../../ai/index.js';
import { COMPACTION_INSTRUCTION, frameSummary } from './compact-prompt.js';
import { pruneToolResults, type PruneLimits } from './compact-prune.js';
import { balancedCuts, selectCut } from './compact-region.js';

export type CompactLimits = PruneLimits & {
  compactAboveTokens: number;
  retainTokens: number;
  compactionRetries: number;
};
export type CompactDeps = {
  /** 一条消息有多少 token */
  measure(message: ToolChatMessage): number;
  /** 请求里消息以外的部分有多少 token（tools 参数） */
  overhead: number;
  /** 发一次摘要请求（开头的系统消息、要压的一段、最后一条指令），返回模型写的正文 */
  summarize(request: ToolChatMessage[]): Promise<string>;
};
export type Compacted = {
  /** 压缩后的整个对话（开头的系统消息、要点、留下来的尾巴）；什么都没变时就是原数组 */
  messages: ToolChatMessage[];
  /** 这次新写的要点（放回对话的那条 user 消息的正文）；没写摘要时没有 */
  checkpoint?: string;
  /** 剪了几条工具结果、写了几次摘要 */
  pruned: number;
  summaries: number;
  /** 压缩前后整个请求的 token */
  before: number;
  after: number;
  /** 没做完的原因；已经做成的部分照样在 messages 里 */
  failure?: unknown;
};

/** head：开头有几条系统消息（固定提示词、日期、长期记忆），它们永远不压。 */
export async function compactMessages(
  messages: ToolChatMessage[],
  head: number,
  limits: CompactLimits,
  deps: CompactDeps,
  force = false,
): Promise<Compacted> {
  const total = (list: readonly ToolChatMessage[]) => list.reduce((sum, m) => sum + deps.measure(m), deps.overhead);
  const before = total(messages);
  const done = (list: ToolChatMessage[], rest: Partial<Compacted> = {}): Compacted => ({
    messages: list,
    pruned: 0,
    summaries: 0,
    before,
    after: total(list),
    ...rest,
  });
  if (!force && before < limits.compactAboveTokens) return done(messages);

  const { messages: prunedMessages, pruned } = pruneToolResults(messages, limits);
  let current = pruned ? prunedMessages : messages;
  if (!force && total(current) < limits.compactAboveTokens) return done(current, { pruned });

  let checkpoint: string | undefined,
    summaries = 0;
  try {
    for (let attempt = 0; attempt <= limits.compactionRetries; attempt++) {
      const sizes = current.map(deps.measure);
      const keepFrom = selectCut(sizes, balancedCuts(current), head, force ? 0 : limits.retainTokens);
      if (keepFrom === null) throw new Error('没有能安全压缩的一段（剩下的是开头的系统消息和要原样留下的尾巴）');
      const region = current.slice(head, keepFrom);
      const summary = await deps.summarize([
        ...current.slice(0, head),
        ...region,
        { role: 'user', content: COMPACTION_INSTRUCTION },
      ]);
      if (!summary.trim()) throw new Error('模型没有写出要点');
      const framedText = frameSummary(summary);
      const framed: ToolChatMessage = { role: 'user', content: framedText };
      const regionTokens = sizes.slice(head, keepFrom).reduce((a, b) => a + b, 0);
      if (deps.measure(framed) >= regionTokens)
        throw new Error(`要点不比原文小（${deps.measure(framed)} 对 ${regionTokens}），作废`);
      current = [...current.slice(0, head), framed, ...current.slice(keepFrom)];
      checkpoint = framedText;
      summaries++;
      // force 只压一次：只要求确实变短了，不要求回到线以下
      if (force || total(current) < limits.compactAboveTokens) return done(current, { checkpoint, pruned, summaries });
    }
    throw new Error(`压了 ${summaries} 次还在线以上（${total(current)} 对 ${limits.compactAboveTokens}）`);
  } catch (failure) {
    return done(current, { checkpoint, pruned, summaries, failure });
  }
}
