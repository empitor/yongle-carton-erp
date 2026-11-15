// 助手对话的自动重发：断线、DeepSeek 内部出错（5xx）、长时间没有新内容、空回复时，原样再发一次，
// 最多重发 5 次、逐次退避（数字照 DeepSeek Harness：500 毫秒起、每次乘 2、最多 10 秒、上下浮动一成）。
// 还不行就把最后一次的错误照实抛出去，不拿收到一半的文字当回复。可能多计一次费。
// 只给助手的原生工具调用用；识别类调用不走这里（它们有各自的重试）。限流（429、503）由排队那一层退避重试，这里不管。
import { AiConnectionError } from './errors.js';

export const CHAT_RETRY = { retries: 5, baseMs: 500, factor: 2, maxMs: 10_000, jitter: 0.1 } as const;
/** 内容开始以后，流式回复这么久没有任何新内容就断开重发（整次请求多长不限：思考久的不会被砍掉，卡死的五分钟就发现） */
export const CHAT_IDLE_TIMEOUT_MS = 300_000;
/**
 * 发出请求到第一个真正的内容（正文、思考、工具调用的增量）最长等多久。DeepSeek 限速说明：排队时流式连接持续发保活行，
 * 最长排 10 分钟、仍没开始推理才关闭。这一段按 300 秒断开会丢掉排到的位置、重新排队，所以单独等满 10 分钟。
 */
export const CHAT_FIRST_CONTENT_TIMEOUT_MS = 600_000;

/** 值得原样再发一次的失败：连不上、中途断开、上游内部出错、等不到新内容、空回复。密钥、余额、请求不合规、内容被拦、输出被截断都不重发。 */
export function retryableChatError(error: unknown) {
  if (!(error instanceof AiConnectionError)) return false;
  if (error.code === 'network' || error.code === 'upstream' || error.code === 'timeout') return true;
  return error.code === 'response' && ['incomplete', 'empty'].includes(error.responseNote?.kind ?? '');
}

/** 第 n 次重发前等多久（n 从 1 起） */
export function retryDelay(attempt: number, random = Math.random) {
  const base = Math.min(CHAT_RETRY.maxMs, CHAT_RETRY.baseMs * CHAT_RETRY.factor ** (attempt - 1));
  return Math.round(base * (1 + CHAT_RETRY.jitter * (random() * 2 - 1)));
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * 跑 job；失败了值得重发就等一会儿再跑，最多重发 CHAT_RETRY.retries 次。用户点了停止（signal）就不再重发。
 * onRetry：每次重发前告诉调用方（第几次、为什么），页面上那段没收全的文字由它清掉。delay 只给测试换成不等待的。
 */
export async function withChatRetry<T>(
  job: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (attempt: number, error: AiConnectionError) => void,
  delay: (ms: number, signal?: AbortSignal) => Promise<void> = wait,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (error) {
      // 值得重发的一定是 AiConnectionError，先认出来好交给 onRetry
      if (!(error instanceof AiConnectionError)) throw error;
      if (attempt > CHAT_RETRY.retries || signal?.aborted || !retryableChatError(error)) throw error;
      onRetry?.(attempt, error);
      await delay(retryDelay(attempt), signal);
      if (signal?.aborted) throw error;
    }
  }
}
