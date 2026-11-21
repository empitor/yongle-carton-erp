import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { errorMessage } from '../../../shared/core/index.js';
import { consistentCopy } from '../sqlite-copy.js';
import { exists, integrityPassed, many, one } from '../sql.js';
import { SchemaError } from './errors.js';
import { readOnlyDatabase } from './pragmas.js';
import { upgradeSteps, type UpgradeStep } from './steps.js';
import { SCHEMA_BASELINE } from './version.js';

export type { UpgradeStep } from './steps.js';

/**
 * 快照目录：和业务库放在一起，破坏性操作前的快照（backup.ts）也在这里；配置库的升级前备份放在各自库文件旁边的同名目录里。
 * 完整备份不带叫这个名字的目录。
 */
export const SNAPSHOT_DIRECTORY = 'snapshots';
/** 升级前快照保留最近几份 */
const UPGRADE_SNAPSHOT_KEEP = 3;
/** 文件名末尾随机串的长度（同一毫秒拍两份也不重名），和下面的文件名规则一致 */
const STAMP_RANDOM_LENGTH = 6;
/** 文件名里的时间戳加 6 位随机：升级前快照、删除前快照、完整备份、恢复时留的原文件都用它，按名字排序就是先后顺序 */
export const stamp = () =>
  new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID().slice(0, STAMP_RANDOM_LENGTH);
/** 认 stamp() 的正则片段：第 1 组是时间部分（stampTime 能读） */
export const STAMP_PATTERN = String.raw`(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-[\da-f]{6}`;
/** stamp() 的时间部分读回毫秒时间 */
export const stampTime = (at: string) => Date.parse(at.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
const UPGRADE_SNAPSHOT_NAME = new RegExp(String.raw`^upgrade-v\d+-to-v\d+-${STAMP_PATTERN}\.sqlite$`);

/** 步骤必须正好是第 21 版起一版一步；返回按版本排好的步骤。写错是程序问题，直接报错。 */
export function orderedSteps(steps: readonly UpgradeStep[] = upgradeSteps) {
  const sorted = [...steps].sort((a, b) => a.version - b.version);
  sorted.forEach((step, index) => {
    if (step.version !== SCHEMA_BASELINE + 1 + index)
      throw new Error(`升级步骤的版本号必须从第 ${SCHEMA_BASELINE + 1} 版起连续，第 ${index + 1} 步写的是第 ${step.version} 版。`);
  });
  return sorted;
}
/** 这组步骤走完是第几版 */
export const latestVersion = (steps: readonly UpgradeStep[] = upgradeSteps) => SCHEMA_BASELINE + steps.length;

const maxVersionRow = z.object({ version: z.number().nullable() });
/** 版本记录里最大的版本号；一条记录都没有时是 0（调用前 inspectSchema 已经拒绝了这种库） */
const currentVersion = (db: DatabaseSync) =>
  one(db, maxVersionRow, 'SELECT MAX(version) AS version FROM schema_migrations')?.version ?? 0;
const counterRow = z.object({ name: z.string(), seq: z.number() });
const nameRow = z.object({ name: z.string() });

/** 自增表用过的最大编号（sqlite_sequence）：表名 → 编号。库里还没有自增表时是空的。 */
function autoIncrementCounters(db: DatabaseSync) {
  if (!exists(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'")) return new Map<string, number>();
  return new Map(
    many(db, counterRow, 'SELECT name, MAX(seq) AS seq FROM sqlite_sequence GROUP BY name').map((row) => [row.name, row.seq] as const),
  );
}

/**
 * 升级步骤跑完以后，把自增表的计数补回去：按官方做法重建表（建新表、复制、删旧表、改名）时，
 * DROP TABLE 会把旧表在 sqlite_sequence 里的那一行删掉，新表的计数只等于复制进来的最大编号，删掉的编号会被重新分出去。
 * 这里对升级前就有计数、升级后同名的表还在并且还是自增的，把计数写回“升级前和现在里大的那个”。
 * 表改了名的对不上（看不出新表是不是旧表），由步骤自己把计数带到新表上（见 steps.ts 的规矩）。
 */
function keepAutoIncrementCounters(db: DatabaseSync, before: ReadonlyMap<string, number>) {
  if (!before.size) return;
  const autoTables = new Set(
    many(db, nameRow, "SELECT name FROM sqlite_schema WHERE type='table' AND sql LIKE '%AUTOINCREMENT%'").map((row) => row.name),
  );
  const current = autoIncrementCounters(db);
  const raise = db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=? AND seq<?');
  const insert = db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');
  for (const [name, seq] of before) {
    if (!autoTables.has(name)) continue;
    const now = current.get(name);
    if (now === undefined) insert.run(name, seq);
    else if (now < seq) raise.run(seq, name, seq);
  }
}

/**
 * 把库从现在的版本升级到最新：全部待做的步骤在一个事务里执行，任何一步失败整体退回，版本、结构、数据都不变。
 * 升级步骤可能要重建表，外键检查先关掉（事务里改这个设置无效，必须在事务外），提交前统一查一遍；
 * 重建表丢掉的自增计数在提交前补回去（keepAutoIncrementCounters），删掉的编号不会被重新分出去。
 * 调用前库的状态应该已经由 inspectSchema 判断为 upgrade；升级前的快照由 openBusinessDatabase 负责。
 * check 是提交前的最后一道检查（打开业务库时用来核对升级后的结构），抛错同样整体退回。
 */
export function upgradeSchema(
  db: DatabaseSync,
  options: { appVersion: string; steps?: readonly UpgradeStep[]; check?: (db: DatabaseSync) => void },
): { from: number; to: number } {
  const steps = orderedSteps(options.steps);
  const from = currentVersion(db),
    to = latestVersion(steps);
  const pending = steps.filter((step) => step.version > from);
  if (!pending.length) return { from, to: from };
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    try {
      db.exec('BEGIN IMMEDIATE');
      // 拿到写锁以后再看一眼：两次读之间被别的程序升级过，就不能再照原来的计划做
      if (currentVersion(db) !== from || pending[0].version !== from + 1)
        throw new Error('开始升级时数据库的版本和刚才看到的不一样');
      const counters = autoIncrementCounters(db);
      const record = db.prepare('INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(?,?,?,?)');
      for (const step of pending) {
        step.up(db);
        record.run(step.version, step.name, new Date().toISOString(), options.appVersion);
      }
      keepAutoIncrementCounters(db, counters);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('升级后数据关联校验失败');
      options.check?.(db);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new SchemaError(
        `数据库从第 ${from} 版升级到第 ${to} 版失败，已整体退回，数据没有改动：${errorMessage(error)}`,
      );
    }
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  return { from, to };
}

/**
 * 升级前的业务库快照：snapshots/upgrade-v20-to-v21-时间.sqlite。
 * 用单独的只读连接 VACUUM INTO，拍到的是含 WAL 内容的一致副本；拍完检查快照能通过 quick_check、版本就是升级前的版本。
 * 拍不成或检查不过就抛错，调用方不再升级。只保留最近 3 份升级前快照，别的文件不动。
 */
export function snapshotForUpgrade(path: string, from: number, to: number): string {
  const dir = join(dirname(path), SNAPSHOT_DIRECTORY);
  const file = join(dir, `upgrade-v${from}-to-v${to}-${stamp()}.sqlite`);
  try {
    mkdirSync(dir, { recursive: true });
    consistentCopy(path, file, (staged) =>
      readOnlyDatabase(staged, (db) => {
        if (!integrityPassed(db, 'quick_check')) throw new Error('快照没有通过完整性检查');
        if (currentVersion(db) !== from) throw new Error(`快照里的版本不是第 ${from} 版`);
      }),
    );
  } catch (error) {
    throw new SchemaError('升级前业务库快照失败，没有开始升级，数据没有改动：' + errorMessage(error));
  }
  try {
    const old = readdirSync(dir)
      .map((name) => ({ name, at: UPGRADE_SNAPSHOT_NAME.exec(name)?.[1] }))
      .filter((entry): entry is { name: string; at: string } => !!entry.at)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(UPGRADE_SNAPSHOT_KEEP);
    for (const entry of old) rmSync(join(dir, entry.name), { force: true });
  } catch {
    /* 清理旧快照失败不影响这次升级 */
  }
  return file;
}
