import { z } from 'zod';
import { DEEPSEEK_LIMITS } from '../../shared/ai/index.js';
import { MIB } from '../../shared/core/index.js';
import { AiConnectionError } from './errors.js';
import { closeAfter, openDeepSeek, readShaped, type AiTransport } from './transport.js';

/** DeepSeek 联网：搜索（/v1/tools/search）和读网页（/v1/tools/fetch）。结果都是外部数据，由调用方标明来源。 */
export type WebSearchResult = {
  title: string;
  url: string;
  siteName: string | null;
  date: string | null;
  summary: string;
  snippet: string;
  score: number;
  authority: number;
};
/** 搜索结果各栏最多留多少字 */
const HIT_CHARS = { title: 500, url: 2000, siteName: 200, date: 40, summary: 4000, snippet: 1000 };
/** 读网页的标题、正文最多留多少字 */
const PAGE_CHARS = { title: 1000, content: 2_000_000 };
/** 搜索、读网页的回答最多读多少 MB */
const REPLY_MEGABYTES = { search: 4, fetch: 8 };
const SEARCH_REPLY_BYTES = REPLY_MEGABYTES.search * MIB;
const FETCH_REPLY_BYTES = REPLY_MEGABYTES.fetch * MIB;
/** 文字栏截到 max 字；不是文字的当作空 */
const clipped = (max: number) => z.string().catch('').transform((v) => v.slice(0, max));
/** 可以没有的文字栏：不是文字的当作没有（null） */
const clippedOrNull = (max: number) => z.string().transform((v) => v.slice(0, max)).nullable().catch(null);
/** 一条搜索结果：没有网址的不要，别的栏缺了按空、没有、0（权威度 -1）算 */
const searchHitSchema = z
  .object({
    url: z.string().transform((v) => v.slice(0, HIT_CHARS.url)),
    title: clipped(HIT_CHARS.title),
    site_name: clippedOrNull(HIT_CHARS.siteName),
    date: clippedOrNull(HIT_CHARS.date),
    summary: clipped(HIT_CHARS.summary),
    snippet: clipped(HIT_CHARS.snippet),
    rerank_score: z.number().catch(0),
    authority: z.number().catch(-1),
  })
  .transform(
    (r): WebSearchResult => ({
      title: r.title,
      url: r.url,
      siteName: r.site_name,
      date: r.date,
      summary: r.summary,
      snippet: r.snippet,
      score: r.rerank_score,
      authority: r.authority,
    }),
  );
const searchReplySchema = z.object({ results: z.array(z.unknown()) });
const fetchReplySchema = z.object({
  content: z.string().transform((v) => v.slice(0, PAGE_CHARS.content)),
  title: clipped(PAGE_CHARS.title),
});
/** 搜索频率按多长的窗口数 */
const WINDOW_MS = 1000;

/** 每秒最多发几个搜索请求：DeepSeek 搜索接口按账号限 5 QPS（DeepSeek Harness 同一个数）。 */
export const SEARCH_REQUESTS_PER_SECOND = 5;

/**
 * 发请求前排队：最近一秒内已经发了 limit 个就等到最早那个满一秒再发。now、sleep 给测试换成假时钟；
 * 等的时候用户点停止就不等了，抛出中止。
 */
export function requestWindow(
  limit: number,
  now: () => number = () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = pause,
) {
  const starts: number[] = [];
  return async (signal?: AbortSignal) => {
    for (;;) {
      signal?.throwIfAborted();
      const at = now();
      while (starts.length && starts[0] <= at - WINDOW_MS) starts.shift();
      if (starts.length < limit) return void starts.push(at);
      await sleep(starts[0] + WINDOW_MS - at, signal);
    }
  };
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => (clearTimeout(timer), resolve());
    const timer = setTimeout(() => (signal?.removeEventListener('abort', done), resolve()), ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
export async function webSearch(
  transport: AiTransport,
  key: string,
  input: { query: string; count: number; originalQuestion?: string },
  slot: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const query = input.query.trim();
  if (!query || [...query].length > DEEPSEEK_LIMITS.searchQueryChars)
    throw new AiConnectionError('validation', '搜索词要 1～128 个字。', 400);
  // 用户这一轮的原话（接口最多收 128 字，空白压成一个空格），帮搜索接口理解搜索词
  const collapsed = input.originalQuestion?.replace(/\s+/gu, ' ').trim();
  const question = collapsed ? [...collapsed].slice(0, DEEPSEEK_LIMITS.searchQueryChars).join('') : undefined;
  await slot(signal);
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'search', path: '/v1/tools/search', key, timeoutMs: 60_000, signal,
    json: {
      query,
      count: Math.max(1, Math.min(DEEPSEEK_LIMITS.searchCount, Math.floor(input.count))),
      need_content: false,
      ...(question ? { ori_question: question } : {}),
    },
  });
  return closeAfter(deadline, async () => {
    const body = await readShaped(response, searchReplySchema, SEARCH_REPLY_BYTES, deadline);
    return body.results.flatMap((r) => {
      const hit = searchHitSchema.safeParse(r);
      return hit.success ? [hit.data] : [];
    });
  });
}

export async function webFetch(transport: AiTransport, key: string, url: string, signal?: AbortSignal) {
  const target = publicWebUrl(url);
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'fetch', path: '/v1/tools/fetch', key, timeoutMs: 90_000, signal, json: { url: target },
  });
  return closeAfter(deadline, async () => {
    const body = await readShaped(response, fetchReplySchema, FETCH_REPLY_BYTES, deadline);
    return { url: target, title: body.title, content: body.content };
  });
}

const privateHost = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp|.*\.intranet)$/i;
/**
 * 读网页只收公网 http/https 地址：有主机名、不带账号密码、默认端口、不是 IP 或本机、内网名。
 * 抓取由 DeepSeek 的服务器做，不会打到我们的内网；这里拦是为了不把内部地址发出去。
 */
export function publicWebUrl(raw: string) {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AiConnectionError('validation', '网址格式不对，要以 http:// 或 https:// 开头。', 400);
  }
  if (text.length > DEEPSEEK_LIMITS.fetchUrlChars || !['http:', 'https:'].includes(url.protocol) || !url.hostname)
    throw new AiConnectionError('validation', '只能读 http 或 https 开头的网页。', 400);
  if (url.username || url.password) throw new AiConnectionError('validation', '网址里不能带账号密码。', 400);
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')))
    throw new AiConnectionError('validation', '只能读默认端口的公网网页。', 400);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (privateHost.test(host) || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':'))
    throw new AiConnectionError('validation', '只能读公网网页，不能读 IP 地址、本机或内网地址。', 400);
  return url.toString();
}
