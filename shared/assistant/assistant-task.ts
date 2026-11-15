// 助手一轮对话里前后端共用的几种数据：这一轮服务器实际做了什么（TurnFacts）、先说的话和联网来源（InterimSaid、WebSource、isWebLink）、
// 用量记账（AgentBudgetView）。
import type { AssistantSpeaker } from './assistant-personas.js';

/** 这一轮服务器实际做了什么：页面在回复下面固定一行显示，不改模型的话。 */
export type TurnFacts = {
  /** 这一轮调过的工具（注册表名字，按先后）：排查和测试用，不给人看 */
  tools: string[];
  /** 查询了几次（只读工具成功的次数） */
  reads: number;
  /** 这一轮出的确认卡片（还没执行，等人点确认） */
  cards: { id: string; label: string }[];
  /**
   * 这一轮已经执行的：服务器直接执行的（识别、改这次对话里交来的识别结果、导出文件、记住或改掉的长期记忆），和人刚点了确认的那张卡片（“接着办”那一轮）。
   * memoryId：记住或改了哪条长期记忆，页面在这一项后面放“忘掉”。
   */
  executed: { label: string; memoryId?: number }[];
  /** 没做成的调用和原因 */
  failed: { label: string; message: string }[];
};

/** 模型一次回复里既说了话又调了命令时先说的那段：存进回复的 interim，页面排在正式回答上面 */
export type InterimSaid = { speaker?: AssistantSpeaker; text: string };

/** 这一轮联网搜到的、读过全文的（read）网页：存进回复的 sources，页面在回答下面列出来源链接（小字写网址的真实主机） */
export type WebSource = { title: string; url: string; date?: string; read?: boolean };

/** 来源里的网址最长几个字，超过的不收（中文路径转码后会很长，一轮最多存 30 条） */
const WEB_SOURCE_URL_CHARS = 2000;
/**
 * 能不能当来源链接：只收 http、https 开头、能解析、不超长的网址。搜索结果是外部数据，javascript: 之类的不收；
 * 服务器记来源和页面画链接都用这一个判断。
 */
export function isWebLink(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > WEB_SOURCE_URL_CHARS) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** 一轮的上限和用量（server/assistant/budget.ts），存进运行记录。 */
export type AgentBudgetView = {
  requestId: string;
  limits: { timeoutMs: number; maxSteps: number };
  used: { modelCalls: number; toolCalls: number };
  elapsedMs: number;
  providerUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requests: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    /** 每次请求的输入 token、其中命中上下文缓存的、输出和思考 token（按先后），看缓存打没打中 */
    calls: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number }[];
  };
};
