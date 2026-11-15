// 压缩时选哪一段：从最新往回留够一段尾巴，更早的那一段压成摘要；切的地方不能把工具调用和它的结果拆开。
// 纯函数，只看消息的角色、工具调用编号和各条的大小。
//
// 移植自 DeepSeek Harness（https://github.com/deepseek-ai/deepseek-harness）
//   packages/compaction/compaction-basic/src/region.ts（selectCompactableRange）
//   packages/compaction/compaction/src/tool-pairing.ts
// Copyright (c) 2026 DeepSeek，MIT 许可，全文见仓库根目录 THIRD_PARTY_NOTICES.md。
// 改动：它按会话事件算，我们按 Chat Completions 的消息算（助手消息的 tool_calls 和 role:'tool' 的结果）。
import type { ToolChatMessage } from '../../ai/index.js';

/**
 * 每个切点是不是“干净”的：cuts[i] 说的是在第 i 条消息之前切（共 n+1 个切点），
 * 干净 = 前面的工具调用都已经有结果，没有一个调用被切成两半。
 * 结果找不到对应的调用说明对话本身坏了，直接报错。
 */
export function balancedCuts(messages: readonly ToolChatMessage[]): boolean[] {
  const cuts = [true];
  let open = 0;
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant') open += ('tool_calls' in m ? m.tool_calls?.length : undefined) ?? 0;
    else if (m.role === 'tool') open -= 1;
    if (open < 0) throw new Error(`对话里第 ${i + 1} 条工具结果找不到对应的调用`);
    cuts.push(open === 0);
  }
  return cuts;
}

/**
 * 返回从第几条起原样留下（它之前、first 起的那一段去压缩）；没有能压的返回 null。
 * - sizes：每条消息的大小（token）；first：能压的第一条（开头的系统消息不压）；
 * - 从最后一条往回累加，够 retainTokens 就停，这些原样留下（最新的一条总是留下）；
 * - 切点不干净就往更早挪，直到干净；挪到 first 还不行，就是没有能压的。
 */
export function selectCut(
  sizes: readonly number[],
  cuts: readonly boolean[],
  first: number,
  retainTokens: number,
): number | null {
  if (!sizes.length) return null;
  let kept = 0,
    keepFrom = sizes.length;
  for (let i = sizes.length - 1; i >= 0; i--) {
    kept += sizes[i];
    keepFrom = i;
    if (kept >= retainTokens) break;
  }
  while (keepFrom > first && !cuts[keepFrom]) keepFrom--;
  return keepFrom > first ? keepFrom : null;
}
