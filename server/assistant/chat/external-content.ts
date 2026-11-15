// 联网只开用户给的或搜索结果里的网址（防止把数据带出去）：
// web.read 只打开用户在这个会话里说过的网址、或这个会话里 web.search 返回过的网址（tools/web.ts）。
// 搜索返回的存在会话 document 的 webUrls 里，用户说过的从会话记录取；换一轮、重启都一样，不看模型这一轮写了什么。
import { z } from 'zod';
import { many, one, parseStoredJson, rows } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { field, listField } from './result-fields.js';

const MAX_URLS = 300;

/** 会话 document 里这份文件写的部分：搜索返回过的网址 */
const threadWebUrls = z.object({ webUrls: z.array(z.string()).optional() });
const threadDocument = rows.assistant_threads.pick({ document: true });

const webUrls = (store: Store, threadId: string): string[] => {
  const row = one(store.db, threadDocument, 'SELECT document FROM assistant_threads WHERE id=?', threadId);
  if (!row) return [];
  return parseStoredJson(threadWebUrls, row.document, `assistant_threads.document（会话 ${threadId}）`).webUrls ?? [];
};

/** web.search 返回的每一条（tools/web.ts 的 结果）；不是这个样子的当没有 */
export const searchHits = (result: unknown) => listField(result, '结果') ?? [];
/** 搜索结果里的网址，不是字符串的不收 */
const searchedUrls = (result: unknown) =>
  searchHits(result).flatMap((r) => {
    const url = field(r, '网址');
    return typeof url === 'string' ? [url] : [];
  });

/** web.search 成功之后：返回的网址记进会话。 */
export function noteSearchResult(store: Store, threadId: string, result: unknown) {
  const found = searchedUrls(result);
  if (!found.length) return;
  const list = [...new Set([...webUrls(store, threadId), ...found])].slice(-MAX_URLS);
  store.db.prepare("UPDATE assistant_threads SET document=json_set(document,'$.webUrls',json(?)) WHERE id=?").run(JSON.stringify(list), threadId);
}

// 用户话里的网址认两种，都记进放行表（都是用户自己打的字）：到空白或中文标点为止的一长段（网址里带中文路径的），
// 和碰到非 ASCII 字符就截断的一段（“打开https://a.com/x看看”这种中文紧挨着的）。协议名不分大小写。
const URL_TO_PUNCTUATION = /https?:\/\/[^\s<>"'，。；、！？（）【】「」『』]+/gi;
const URL_ASCII = /https?:\/\/[!#-&(-;=?-~]+/gi;
const NON_ASCII_RUN = /^[^\x00-\x7f]+/;
const SCHEME_END = '://';

/**
 * 碰到非 ASCII 截断的那一段：截在主机名里（:// 后面还没出现 / ? #）、而主机名明显还没完的不收——
 * 截出来的以 . 或 - 结尾，或者那串非 ASCII 字后面紧跟着 .（“github.com镜像.cn/x”）。不然会放行用户没给的主机。
 */
function asciiUrls(text: string) {
  const out: string[] = [];
  for (const m of text.matchAll(URL_ASCII)) {
    const url = m[0],
      rest = text.slice(m.index + url.length);
    const inHost = !/[/?#]/.test(url.slice(url.indexOf(SCHEME_END) + SCHEME_END.length));
    const run = rest.match(NON_ASCII_RUN)?.[0];
    if (run && inHost && (/[.-]$/.test(url) || rest[run.length] === '.')) continue;
    out.push(url);
  }
  return out;
}
const userUrls = (text: string) =>
  [...(text.match(URL_TO_PUNCTUATION) ?? []), ...asciiUrls(text)].map((u) => u.replace(/[.,;:!?)\]]+$/, ''));

/** 去掉 # 后面的片段：放行和来源去重都按它判断是不是同一个网页 */
export const withoutFragment = (url: string) => {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
};
/**
 * web.read 打开哪个网址：先逐字对用户说过的话里的网址、搜索返回过的网址；对不上时，去掉 # 后面的片段相同也算对上
 * （搜索返回的网址常带 #1，模型常去掉）。返回的永远是放行过的那条原样，模型自己写的片段、参数一个字都不带进去；
 * 都对不上返回 null。不许在放行的网址后面续路径、参数。
 */
export function allowedUrl(store: Store, threadId: string, url: string): string | null {
  const searched = webUrls(store, threadId);
  if (searched.includes(url)) return url;
  const said = many(
    store.db,
    rows.assistant_messages.pick({ text: true }),
    "SELECT text FROM assistant_messages WHERE thread_id=? AND role='user'",
    threadId,
  ).flatMap((r) => userUrls(r.text));
  const allowed = [...said, ...searched];
  if (allowed.includes(url)) return url;
  return allowed.find((a) => withoutFragment(a) === withoutFragment(url)) ?? null;
}
