// 会话内上下文的几个数：都在这一处，以后调只改这里；不读环境变量（测试经 AssistantManager 的 agent.session 调小）。
// 做法：同一个会话里用户的话、助手的回复、每次工具调用和结果原样往后追加，不重排、不改写前面的，
// 每次请求的前缀不变，能命中 DeepSeek 的上下文缓存；单个工具结果进对话时截到上限；
// 整个请求超过触发线时压缩（compact.ts，照 DeepSeek Harness 的做法）。

export const SESSION = {
  /** 一个工具结果进对话的上限（token）。超过的把最长的列表截短，写明还有多少条、怎么翻页。 */
  toolResultTokens: 8_000,
  /** 整个请求（系统提示词、工具、全部消息）到这么多 token 就压缩。用户定的，不随模型窗口变。 */
  compactAboveTokens: 200_000,
  /** 压缩时从最新往回原样留下这么多 token 的消息（触发线 × 0.16，Harness 的比例）。 */
  retainTokens: 32_000,
  /** 压缩的第一步：超过这么多字的工具结果只留开头和结尾（Harness 的三个数）。 */
  pruneAboveChars: 8_192,
  pruneHeadChars: 4_096,
  pruneTailChars: 1_024,
  /** 压完一次还在触发线以上时最多再压几次。 */
  compactionRetries: 1,
  /** 一个命令最多执行多久：到点就中止、把超时告诉模型，不拖死整轮。识别一批文件要排队调模型，最长的正常调用也在这以内。 */
  toolTimeoutMs: 900_000, // 15 分钟
};

/** 官方说法：中文字约 0.6 个 token、英文字符约 0.3 个 */
export const CJK_TOKENS_PER_CHAR = 0.6;
const OTHER_TOKENS_PER_CHAR = 0.3;
/** 从这个字符起按中文算（中日韩文字、全角标点） */
const CJK_FROM = 0x2e80;

/** 估算 token：只用来比触发线，计费以接口返回的用量为准。 */
export function estimateTokens(text: string) {
  let cjk = 0;
  for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) >= CJK_FROM) cjk++;
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (text.length - cjk) * OTHER_TOKENS_PER_CHAR);
}
