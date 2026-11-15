// 一轮对话里给页面看的过程（照 DeepSeek Harness 的体验）：状态行上正在跑的命令叫什么（tool 事件的 label）、
// 模型调命令前先说的那段话（said 事件，收尾存进回复的 interim）、联网搜到和读过的网页（收尾存进回复的 sources）。
// 只记下、只给页面看：不改发给模型的对话，也不改模型的话。
import { isWebLink, speakerForTools, type InterimSaid, type WebSource } from '../../../shared/assistant/index.js';
import { WEB_SEARCH } from '../tools/web.js';
import { searchHits, withoutFragment } from './external-content.js';
import { field } from './result-fields.js';
import type { ChatRun, ChatServices, ModelReply, ToolCall } from './run-state.js';

/** 一轮最多列几个来源 */
export const MAX_SOURCES = 30;
/** 状态行上命令后面那段（搜索词、网址）最多几个字 */
const LABEL_CHARS = 40;

const cut = (text: string, max: number) => ([...text].length > max ? [...text].slice(0, max - 1).join('') + '…' : text);

/** 路径里转过码的中文还原给人看；还原不了的照原样 */
function readable(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 状态行上这条命令叫什么：联网的写出搜什么、读哪个网页，别的用说明里的叫法（fallback） */
export function stepLabel(call: ToolCall, fallback: string) {
  if (call.name === 'web.search' && Array.isArray(call.args.queries))
    return '联网搜索：' + cut(call.args.queries.map(String).join('、'), LABEL_CHARS);
  const url = call.name === 'web.read' && isWebLink(call.args.url) ? new URL(call.args.url) : null;
  if (url) return '读网页：' + cut(url.host + (url.pathname === '/' ? '' : readable(url.pathname)), LABEL_CHARS);
  return fallback;
}

/**
 * 模型这次回复既说了话又要调命令：这段话先发给页面（排在“正在处理”上面），原样记下来收尾时存进回复（全文、不限段数，
 * 和生成时页面上看到的一样）。没写是谁说的：和收尾时一样按要调的命令归到小甬或小勒，都没有就沿用上一位
 */
export function noteSaid(svc: ChatServices, run: ChatRun, reply: ModelReply) {
  const speaker =
    reply.speaker ?? run.speaker ?? speakerForTools(reply.calls.map((c) => c.call.name)) ?? svc.conversations.lastSpeaker(run.id);
  const parts = [
    { speaker, text: reply.message },
    ...(reply.relay ?? []),
  ].filter((p) => p.text.trim());
  for (const p of parts) {
    const said: InterimSaid = { ...(p.speaker ? { speaker: p.speaker } : {}), text: p.text.trim() };
    run.emit('said', said);
    run.interim.push(said);
  }
}

const sourceTitle = (title: unknown, url: string) => cut(String(title || url), WEB_SEARCH.titleChars);

/**
 * web.search 返回的结果、web.read 读过的网页记进这一轮的来源：网址存原样（不规范化），只收 http/https、不超长的；
 * 去掉 # 片段后按网址去重，链接用先出现的那条；读过的并进同一条、标上。
 */
export function noteSources(run: Pick<ChatRun, 'sources'>, name: string, result: unknown) {
  if (name === 'web.search')
    for (const r of searchHits(result)) {
      const url = field(r, '网址'),
        date = field(r, '日期');
      if (!isWebLink(url) || run.sources.has(withoutFragment(url))) continue;
      run.sources.set(withoutFragment(url), { title: sourceTitle(field(r, '标题'), url), url, ...(date ? { date: String(date) } : {}) });
    }
  const read = name === 'web.read' ? field(result, '网址') : undefined;
  if (isWebLink(read)) {
    const known = run.sources.get(withoutFragment(read));
    run.sources.set(withoutFragment(read), {
      ...known,
      title: sourceTitle(field(result, '标题') || known?.title, read),
      url: known?.url ?? read,
      read: true,
    });
  }
}

/** 收尾存进回复的：先说的话、来源（读过全文的排前面，最多 30 个）；没有的不写 */
export function trailOf(run: Pick<ChatRun, 'sources' | 'interim'>): { interim?: InterimSaid[]; sources?: WebSource[] } {
  const all = [...run.sources.values()];
  const sources = [...all.filter((s) => s.read), ...all.filter((s) => !s.read)].slice(0, MAX_SOURCES);
  return { ...(run.interim.length ? { interim: run.interim } : {}), ...(sources.length ? { sources } : {}) };
}
