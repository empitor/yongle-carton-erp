/**
 * 财务对照业务来源：只读窗口给的来源（financeFacts.sources.heads，只有种类、编号、版本、状态、日期）和财务自己看到过的
 * （fin_source_observations）在程序里比，挑出这一版还没看过的、已经看不到的（单据、盘点流水被删了）。
 * 补扫（events.ts）、还没同步的计数和清单（events.ts、catch-up.ts）、月度台账和报表检查列的还没同步的单据（event-views.ts）都用它：
 * 一次窗口、一次观察记录，语句条数不随单据多少变；要读内容的再按批读原文（texts），逐条解析（readSource）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { many, one, rows } from '../../core/index.js';
import { financeFacts, type SourceHead, type SourceText } from '../../flow/index.js';
import { sourceHash, withNumber } from './source-fingerprint.js';
import type { FinanceSourceDocument } from './source-snapshot.js';
import { eventSourceKinds } from '../base/stored-values.js';
import { readOrSkip, skippedKeys } from '../base/unreadable.js';

/** 观察记录一条（对照要的几列），加上它挂的事件的状态和日期（被删的来源按它们判断要不要管、算在哪个月） */
const observation = rows.fin_source_observations
  .pick({ source_kind: true, source_id: true, source_version: true, status: true, event_id: true })
  .extend({ event_status: rows.fin_events.shape.status, event_date: rows.fin_events.shape.date });
type Observation = z.output<typeof observation>;
/** 这一版还没看过的来源：来源一条，加上财务上次看到它时挂的事件和那时的状态（第一次看到都是 null） */
export type UnseenSource = SourceHead & { previous: number | null; observed: string | null };

/** 来源的“种类:编号”，和 unreadable.ts 跳过的键同一个写法 */
export const sourceKey = (s: { kind: string; id: string }) => s.kind + ':' + s.id;
const observedKey = (o: Observation) => sourceKey({ kind: o.source_kind, id: o.source_id });

/** 财务看到过的全部来源（按“种类:编号”） */
function observations(db: DatabaseSync) {
  const all = many(
    db,
    observation,
    `SELECT o.source_kind,o.source_id,o.source_version,o.status,o.event_id,e.status AS event_status,e.date AS event_date
      FROM fin_source_observations o JOIN fin_events e ON e.id=o.event_id`,
  );
  return new Map(all.map((o) => [observedKey(o), o]));
}

/** 这些来源里这一版财务还没看过的：观察记录没有，或版本、状态和上次看到的不一样（先后同 heads） */
function unseenOf(heads: SourceHead[], seen: Map<string, Observation>): UnseenSource[] {
  return heads.flatMap((head) => {
    const o = seen.get(sourceKey(head));
    return o && o.source_version === head.version && o.status === head.status
      ? []
      : [{ ...head, previous: o?.event_id ?? null, observed: o?.status ?? null }];
  });
}

/** 对照一次：全部来源和全部观察记录 */
function scan(db: DatabaseSync) {
  const heads = financeFacts.sources.heads(db);
  const seen = observations(db);
  const present = new Set(heads.map(sourceKey));
  const missing = [...seen.values()]
    .filter((o) => o.status !== 'deleted' && o.event_status !== 'before_opening' && !present.has(observedKey(o)))
    .map((o) => ({ kind: o.source_kind, id: o.source_id, eventId: o.event_id, date: o.event_date }));
  return { unseen: unseenOf(heads, seen), missing };
}
type Scan = ReturnType<typeof scan>;

/** 库现在这一版的记号：本连接改过几行、别的连接提交过没有（任何一边写过都会变） */
const stampRow = z.object({ changes: z.number(), version: z.number() });
const stampOf = (db: DatabaseSync) =>
  JSON.stringify(one(db, stampRow, 'SELECT total_changes() AS changes,data_version AS version FROM pragma_data_version'));
/** 上一次对照的结果（每个库一份），库没变过就直接用：一次请求里补扫判断和第一批、月度台账和报表检查的几处共用一次 */
const scans = new WeakMap<DatabaseSync, { stamp: string; scan: Scan }>();

/**
 * 对照全部来源：unseen 是这一版还没看过的（不分种类、状态：新确认的、内容变了的、已撤销或被更正替代的、盘点流水改写的；
 * 先后同 heads），missing 是看到过、来源已经没了、还没记成已删除的（启用前的不管），带着它挂的事件的编号和日期。
 * 库从上次对照以后没写过（本连接、别的连接都没有），就用上次的结果，不再读一遍；交出去的不许改。
 * 只在事务外面用和存：事务回滚以后 total_changes 不会退回去，在事务里算的（看得到没提交的改动）存下来，
 * 回滚后记号对得上就会一直用它（补扫一批出错回滚后会误判成没东西要补）。事务里一律现算。
 */
export function scanSources(db: DatabaseSync): Scan {
  if (db.isTransaction) return scan(db);
  const stamp = stampOf(db);
  const known = scans.get(db);
  if (known?.stamp === stamp) return known.scan;
  const fresh = scan(db);
  scans.set(db, { stamp, scan: fresh });
  return fresh;
}

/**
 * 来源现在的状态和补扫看到的不一样的（这一版还没补扫进来）：现在已撤销（含被更正替代）的、已被删的，
 * “种类:编号” → 现在的状态（reversed、deleted），JSON 文字。给 sourceIs 当参数。
 */
export function lapsedStatuses(db: DatabaseSync) {
  const { unseen, missing } = scanSources(db);
  const reversed = unseen.filter((s) => s.status === 'reversed' && s.observed === 'confirmed');
  return JSON.stringify(
    Object.fromEntries([...reversed.map((s) => [sourceKey(s), 'reversed']), ...missing.map((m) => [sourceKey(m), 'deleted'])]),
  );
}

/**
 * 财务事件（或别的带 source_kind、source_id 的行）e 的来源现在是不是 status（SQL 条件，带一个参数：lapsedStatuses 的结果）。
 * 财务看来源状态都走这一处：补扫看到的状态（财务自己的 fin_source_observations，被更正替代的原单也是已撤销），
 * 这一版还没补扫进来的撤销、删除按窗口现在的状态（补扫一次最多几批、坏单据被跳过时，写入照样拦得住撤销过的单据）。
 * 没有观察记录的（还没看到过）是 NULL，按不是算。
 */
export const sourceIs = (e: string, status: 'confirmed' | 'reversed') =>
  `coalesce(json_extract(?,'$."'||${e}.source_kind||':'||${e}.source_id||'"'),
    (SELECT seen.status FROM fin_source_observations seen WHERE seen.source_kind=${e}.source_kind AND seen.source_id=${e}.source_id))='${status}'`;

/**
 * 截至 end（含）还没同步进财务的来源有几条：这一版还没看过的（按单据日期；读不出来跳过的也算），
 * 加上被删、还没记成已删除的（按它挂的事件的日期）。
 */
export const unseenCount = ({ unseen, missing }: Scan, end: string) =>
  unseen.filter((s) => s.date <= end).length + missing.filter((m) => m.date <= end).length;

/** 一段日期里已确认的送货、到货单，这一版财务还没看过的（月度台账、报表检查按单据内容先算上；先后同 heads） */
export function unseenConfirmed(db: DatabaseSync, from: string, to: string) {
  return scanSources(db).unseen.filter(
    (s) => (s.kind === 'delivery' || s.kind === 'arrival') && s.status === 'confirmed' && s.date >= from && s.date <= to,
  );
}

/** 按批读这些来源的原文，按“种类:编号”对上 */
export function sourceTexts(db: DatabaseSync, refs: readonly { kind: string; id: string }[]) {
  return new Map(financeFacts.sources.texts(db, refs).map((t) => [sourceKey(t), t]));
}

/** 已经跳过（内容读不出来）、内容还是原样的来源的“种类:编号”：补扫不再读它们（unreadable.ts） */
export function skippedSources(db: DatabaseSync) {
  return new Set(
    skippedKeys(db, eventSourceKinds, (keys) =>
      financeFacts.sources
        .texts(db, keys.map((key) => ({ kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1) })))
        .map((t) => ({ kind: t.kind, id: t.id, number: t.number, content: t.text })),
    ),
  );
}

/**
 * 读一条来源：快照存的财务口径（窗口解析出来的，加上单号）和来源指纹（按算进指纹的内容算，见 sourceHash）。
 * 内容读不出来抛 StoredDataError。
 */
export function readSource(source: SourceText): { doc: FinanceSourceDocument; hash: string } {
  const { doc, counted } = financeFacts.sources.read(source);
  return { doc: withNumber(doc, source.number), hash: sourceHash(source, counted) };
}

/**
 * 同 readSource，内容读不出来的记下跳过、返回 null（unreadable.ts）：补扫和列“还没同步的单据”的地方
 * （月度台账、报表检查）都用它，一张坏单据不让整批、整页出错。它照样算“还没同步”（unseenSources）。
 */
export function readSourceOrSkip(db: DatabaseSync, source: SourceText) {
  return readOrSkip(db, { kind: source.kind, id: source.id, number: source.number, content: source.text }, () => readSource(source));
}
