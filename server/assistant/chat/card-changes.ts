// 出过的核对卡片后来怎么样了（等确认、已执行、执行没成、发出去了结果不明、作废、过期）：每轮结束记下这个会话所有卡片的状态（cardStates，存进那一轮的原样记录），
// 下一轮开头把有变化的（用户点了确认、作废了、过期了）写进这一轮的上下文（cardChanges）。
import { z } from 'zod';
import { many, one, parseStoredJson, rows } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { cardStateNames, type CardStateName } from '../../../shared/assistant/index.js';
import { asList } from './result-fields.js';

/** 一个结果里最多看几个元素、名称类的值最多几个字、卡片执行结果最多写几项 */
const ARRAY_PEEK = 5;
const QUOTED_CHARS = 60;
const RESULT_FACTS = 8;

const KEY = /^(id|number|no|code|name|label|title|state|status|ok|message|total|count|quantity|amount|unit|date|version|previewId|.*(?:Id|Number|Name|Date))$|^(共|单号|编号|名称|状态|数量|金额|单位|日期|结果|说明)$/;

/** 一个结果里最要紧的字段（编号、单号、名称、状态、数量……），广度优先，最多 n 个；名称类的值压成一行、包上引号。 */
function facts(value: unknown, n: number) {
  const out: string[] = [];
  const queue: unknown[] = [value];
  const quoted = (s: string) => {
    const line = s.replace(/\s+/g, ' ').trim();
    return JSON.stringify(line.length > QUOTED_CHARS ? line.slice(0, QUOTED_CHARS) + '…' : line);
  };
  while (queue.length && out.length < n) {
    const v = queue.shift();
    const items = asList(v);
    if (items) queue.push(...items.slice(0, ARRAY_PEEK));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (x !== null && typeof x === 'object') queue.push(x);
        else if (KEY.test(k) && x !== undefined && x !== '' && out.length < n)
          out.push(`${k}=${typeof x === 'string' ? quoted(x) : String(x)}`);
      }
  }
  return out.join(' ');
}

const CARD: Record<CardStateName, string> = {
  executed: '已确认并执行',
  failed: '用户确认了，但执行没有成功，这张卡片不会再执行；还要办就重新出一张',
  unknown: '用户确认后已经发出去执行，结果不明（可能做了也可能没做）：先查一下现在的情况再决定，不要直接重做',
  cancelled: '已作废，没有执行',
  expired: '过期了，没有执行',
  waiting: '还在等用户确认',
};
/** 存进一轮原样记录的各卡片状态（session-history.ts 的 turn.cards）：卡片编号 → 状态 */
export const storedCardStates = z.record(z.string(), z.enum(cardStateNames));

const previewState = rows.assistant_previews.pick({ id: true, expires_at: true, result: true }).extend({
  failed: z.string().nullable(),
  started: z.string().nullable(),
});
function cardState(r: z.infer<typeof previewState>, now: number): CardStateName {
  if (r.result != null) return 'executed';
  if (r.failed != null) return 'failed';
  if (r.started != null) return 'unknown';
  if (r.expires_at === 0) return 'cancelled';
  return r.expires_at < now ? 'expired' : 'waiting';
}
export function cardStates(store: Store, threadId: string, now = Date.now()): Record<string, CardStateName> {
  const previews = many(
    store.db,
    previewState,
    "SELECT id,expires_at,result,json_extract(document,'$.failed') AS failed,json_extract(document,'$.started') AS started FROM assistant_previews WHERE thread_id=? ORDER BY rowid",
    threadId,
  );
  return Object.fromEntries(previews.map((r) => [r.id, cardState(r, now)]));
}

const lastCards = z.object({ cards: z.string(), seq: z.number() });
const changedPreview = rows.assistant_previews.pick({ id: true, result: true }).extend({ label: z.string().nullable() });
/** 上一轮结束以后，卡片状态有变化的（用户在卡片上点了确认、作废了、过期了）。 */
export function cardChanges(store: Store, threadId: string, beforeSeq: number) {
  const last = one(
    store.db,
    lastCards,
    "SELECT seq,json_extract(document,'$.turn.cards') AS cards FROM assistant_messages WHERE thread_id=? AND role='user' AND seq<? AND json_extract(document,'$.turn.cards') IS NOT NULL ORDER BY seq DESC LIMIT 1",
    threadId,
    beforeSeq,
  );
  if (!last) return [];
  const before = parseStoredJson(storedCardStates, last.cards, `assistant_messages.document 的 turn.cards（第 ${last.seq} 行）`);
  const now = cardStates(store, threadId);
  const changed = Object.keys(now).filter(
    (id) => now[id] !== before[id] && !(before[id] === undefined && now[id] === 'waiting'),
  );
  if (!changed.length) return [];
  return many(
    store.db,
    changedPreview,
    `SELECT id,json_extract(document,'$.plan.label') AS label,result FROM assistant_previews WHERE id IN (${changed.map(() => '?').join(',')}) ORDER BY rowid`,
    ...changed,
  ).map((r) => ({
    previewId: r.id,
    label: r.label ?? undefined,
    state: CARD[now[r.id]],
    ...(r.result != null
      ? { result: facts(parseStoredJson(z.unknown(), r.result, `assistant_previews.result（卡片 ${r.id}）`), RESULT_FACTS) }
      : {}),
  }));
}
