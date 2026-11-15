// 压缩的第一步，不调模型：太长的工具结果只留开头和结尾，中间换成一句标记。
//
// 移植自 DeepSeek Harness（https://github.com/deepseek-ai/deepseek-harness）
//   packages/compaction/compaction-tool-result-pruner/src/index.ts（pruneContent、pruneSession）和 config.ts
// Copyright (c) 2026 DeepSeek，MIT 许可，全文见仓库根目录 THIRD_PARTY_NOTICES.md。
// 改动：我们的工具结果是一段文字（不是内容块），直接按字切；数字从 session-limits.ts 传进来。
import type { ToolChatMessage } from '../../ai/index.js';

export const PRUNE_MARKER = '\n\n[……工具结果中间一段已省略……]\n\n';
export type PruneLimits = { pruneAboveChars: number; pruneHeadChars: number; pruneTailChars: number };

/**
 * 超过上限的文字留头留尾；没超过返回 null。按码点切，不会把一个字（代理对）切成两半。
 * 头、标记、尾加起来必须比原文短、也不超过上限，否则是数字配错了。
 */
export function pruneText(text: string, limits: PruneLimits): string | null {
  const points = Array.from(text);
  if (points.length <= limits.pruneAboveChars) return null;
  const pruned =
    points.slice(0, limits.pruneHeadChars).join('') +
    PRUNE_MARKER +
    points.slice(points.length - limits.pruneTailChars).join('');
  if (Array.from(pruned).length > limits.pruneAboveChars)
    throw new Error('工具结果剪枝的数字配错了：开头、标记、结尾加起来超过了上限');
  return pruned;
}

/** 把每条太长的工具结果剪一遍（别的消息原样），返回新数组、剪了几条、少了多少字。 */
export function pruneToolResults(messages: readonly ToolChatMessage[], limits: PruneLimits) {
  let pruned = 0,
    charsRemoved = 0;
  const out = messages.map((m): ToolChatMessage => {
    if (m.role !== 'tool') return m;
    const content = pruneText(m.content, limits);
    if (content === null) return m;
    pruned++;
    charsRemoved += Array.from(m.content).length - Array.from(content).length;
    return { ...m, content };
  });
  return { messages: out, pruned, charsRemoved };
}
