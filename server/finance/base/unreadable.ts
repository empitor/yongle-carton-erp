/**
 * 补扫时内容读不出来的业务记录（送货、到货、完工单，盘点流水，采购退货单）：逐条跳过，别的照常。
 * 只认“这条记录本身的内容读不出来”一种（读它时抛 StoredDataError）；读出来以后的步骤出错照常抛，由 catch-up.ts 接住。
 *
 * 跳过的记在进程里（每个库一份，不改表结构）：键是“种类:编号”，带上内容原文的 sha256。内容没变就不再重读、
 * 出错记录只记一次；在库里原处改好（版本号没变也算）内容就变了，下次补扫再读，不用重启。重启后头一次补扫再试一次、再记一条。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { StoredDataError } from '../../core/index.js';

/** 一条业务记录：种类、编号、单号（盘点流水是拼的说明），内容原文 */
export type StoredRecord = { kind: string; id: string; number: string | null; content: string };
/** 跳过的一条：内容原文的 sha256、为什么读不出来、记没记进出错记录 */
type Skipped = Omit<StoredRecord, 'content'> & { digest: string; error: StoredDataError; reported: boolean };

const skippedByDb = new WeakMap<DatabaseSync, Map<string, Skipped>>();
function skippedOf(db: DatabaseSync) {
  const known = skippedByDb.get(db) ?? new Map<string, Skipped>();
  skippedByDb.set(db, known);
  return known;
}
const digestOf = (content: string) => createHash('sha256').update(content).digest('hex');
const keyOf = (r: { kind: string; id: string }) => r.kind + ':' + r.id;

/** 读一条：读出来返回结果；内容读不出来的记下跳过、返回 null（同一份内容已知读不出来的不再读） */
export function readOrSkip<T>(db: DatabaseSync, record: StoredRecord, read: () => T): T | null {
  const known = skippedOf(db),
    key = keyOf(record),
    digest = digestOf(record.content);
  if (known.get(key)?.digest === digest) return null;
  try {
    const value = read();
    known.delete(key);
    return value;
  } catch (error) {
    if (!(error instanceof StoredDataError)) throw error;
    known.set(key, { kind: record.kind, id: record.id, number: record.number, digest, error, reported: false });
    return null;
  }
}

/**
 * 这几种里已经跳过、内容还是原样的（“种类:编号”），给 SQL 排除用。current 按键读出这些记录现在的内容；
 * 内容变了（改好了）或者记录没了的，不再算跳过，下次照常读。
 */
export function skippedKeys(db: DatabaseSync, kinds: readonly string[], current: (keys: string[]) => StoredRecord[]) {
  const known = skippedOf(db);
  const keys = [...known.values()].filter((s) => kinds.includes(s.kind)).map(keyOf);
  if (!keys.length) return [];
  const now = new Map(current(keys).map((r) => [keyOf(r), digestOf(r.content)]));
  const still: string[] = [];
  for (const key of keys)
    if (now.get(key) === known.get(key)?.digest) still.push(key);
    else known.delete(key);
  return still;
}

/** 跳过以后还没记进出错记录的，交出去就算记过了（catch-up.ts 记） */
export function unreportedSkips(db: DatabaseSync) {
  const fresh = [...skippedOf(db).values()].filter((s) => !s.reported);
  for (const s of fresh) s.reported = true;
  return fresh;
}
