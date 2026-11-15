import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Store } from './db.js';
import { AppError } from './errors.js';
import { SNAPSHOT_DIRECTORY, stamp } from './schema/index.js';
import { DAY_MS, MINUTE_MS, errorMessage } from '../../shared/core/index.js';
import { count, integrityPassed, pragmaInteger } from './sql.js';

/**
 * 删除、初始化这类破坏性操作前给业务库拍的恢复快照（放在业务库旁边的快照目录里）。
 * 完整备份、恢复在 backup.ts。
 */

const SNAPSHOT_DIR = SNAPSHOT_DIRECTORY;
const SNAPSHOT_KEEP = 20;
/** 几分钟内、之后又没有写入的，复用上一份快照 */
const SNAPSHOT_REUSE_MINUTES = 5;
const SNAPSHOT_THROTTLE_MS = SNAPSHOT_REUSE_MINUTES * MINUTE_MS;

/** 本程序生成的快照名：erp-时间-随机-原因.sqlite。别的文件既不复用也不清理。 */
const SNAPSHOT_NAME =
  /^erp-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z-[\da-f]{6}(?:-[\w-]*)?\.sqlite(\.partial)?$/;

/** 从快照文件名读出生成时间；partial 为 true 时只认中断留下的 .partial 文件。不是本程序命名的返回 null。 */
export function snapshotTime(name: string, partial = false): number | null {
  const m = SNAPSHOT_NAME.exec(name);
  if (!m || !!m[6] !== partial) return null;
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(at) ? at : null;
}

/**
 * 快照保留：24 小时内的全部保留，避免日常操作把刚生成的快照挤掉；更早的只在总数不到上限时保留。
 * 进程中断留下的 .partial 超过一天才清理，正在写的不会被误删。返回删掉的文件名。
 */
export function pruneSnapshots(dir: string, now = Date.now()) {
  if (!existsSync(dir)) return [] as string[];
  const names = readdirSync(dir), removed: string[] = [];
  names
    .map((name) => ({ name, at: snapshotTime(name) }))
    .filter((e): e is { name: string; at: number } => e.at !== null)
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1))
    .forEach((e, index) => {
      if (index >= SNAPSHOT_KEEP && now - e.at > DAY_MS) {
        rmSync(join(dir, e.name), { force: true });
        removed.push(e.name);
      }
    });
  for (const name of names) {
    const at = snapshotTime(name, true);
    if (at !== null && now - at > DAY_MS) {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * 判断“快照之后有没有写入”的标记，三样都便宜：
 * - 业务连接的 total_changes()：本进程所有业务写入都走 store.db 这一个连接，每次增删改都会让它变大；
 * - schema_version：建表、删表这类不计入 total_changes 的改动；
 * - 业务库和 -wal 的大小与修改时间（纳秒）：兜住其他连接的提交和检查点。
 * 任何一项变了就重新拍快照，误判只会多拍一次。本进程经 store.db 的写入一定能发现；
 * 其他连接的写入靠文件大小和修改时间，只有在同一个时钟刻度内写入、且 WAL 大小恰好不变时才可能漏判。
 */
function changeMarker(store: Store) {
  const changes = count(store.db, 'SELECT total_changes() AS n'),
    schema = pragmaInteger(store.db, 'schema_version');
  const files = ['', '-wal'].map((suffix) => {
    try {
      const s = statSync(store.path + suffix, { bigint: true });
      return s.size + ':' + s.mtimeNs;
    } catch {
      return '-';
    }
  });
  return [changes, schema, ...files].join('|');
}
type SnapshotRecord = { file: string; at: number; marker: string; size: number; mtimeMs: number };
/** 按业务连接记住最近一次可复用的快照。只在内存里，重启后第一次破坏性操作一定重新拍。 */
const lastSnapshot = new WeakMap<object, SnapshotRecord>();

function quickCheck(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return integrityPassed(db, 'quick_check');
  } finally {
    db.close();
  }
}
function reusableSnapshot(store: Store, dir: string) {
  const last = lastSnapshot.get(store.db);
  if (!last || Date.now() - last.at >= SNAPSHOT_THROTTLE_MS) return null;
  if (dirname(last.file) !== dir || snapshotTime(basename(last.file)) === null) return null;
  if (changeMarker(store) !== last.marker) return null;
  try {
    const s = statSync(last.file);
    if (s.size !== last.size || s.mtimeMs !== last.mtimeMs || !quickCheck(last.file)) return null;
  } catch {
    return null;
  }
  return last.file;
}

/**
 * 破坏性操作前的业务库快照：用它代替重复确认，让误删可以恢复。
 * 用单独的只读连接 VACUUM INTO：业务库是 WAL 模式，另一个连接只看得到已提交的数据，
 * 所以调用方已经开了事务或 SAVEPOINT 也能拍，得到的是这次操作之前已提交的状态。
 * 先写 .partial 再改名，半截文件不会被当成快照。5 分钟内、且之后没有任何写入时复用上一份。
 * 拍不成（库忙、磁盘满、目录不可写）就抛错，由调用方中止破坏性操作；只有内存库返回 null。
 */
export function snapshotBeforeDestructive(store: Store, reason: string): string | null {
  if (store.path === ':memory:') return null;
  const dir = join(dirname(store.path), SNAPSHOT_DIR);
  const reused = reusableSnapshot(store, dir);
  if (reused) return reused;
  lastSnapshot.delete(store.db);
  const file = join(dir, 'erp-' + stamp() + '-' + reason.replace(/[^\w-]/g, '') + '.sqlite'),
    staged = file + '.partial';
  try {
    mkdirSync(dir, { recursive: true });
    const reader = new DatabaseSync(store.path, { readOnly: true });
    try {
      reader.exec('PRAGMA busy_timeout=5000');
      reader.prepare('VACUUM INTO ?').run(staged);
    } finally {
      reader.close();
    }
    renameSync(staged, file);
  } catch (error) {
    try {
      rmSync(staged, { force: true });
    } catch {
      /* 保留原始错误 */
    }
    const message = errorMessage(error);
    throw new AppError(
      (/busy|locked/i.test(message) ? '数据库正忙，' : '') +
        '无法在操作前生成恢复快照，本次操作未执行，请稍后重试：' +
        message,
      507,
    );
  }
  // 事务里拍的快照不含本事务已做的改动，事务提交后就不代表当前数据，不能复用。
  if (!store.db.isTransaction) {
    const s = statSync(file);
    lastSnapshot.set(store.db, { file, at: Date.now(), marker: changeMarker(store), size: s.size, mtimeMs: s.mtimeMs });
  }
  try {
    pruneSnapshots(dir);
  } catch {
    /* 清理旧快照失败不影响本次快照和操作 */
  }
  return file;
}
