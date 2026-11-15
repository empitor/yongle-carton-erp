import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQLITE_CODE, sqliteCode } from './errors.js';
import { count, pragmaInteger } from './sql.js';

/**
 * 配置库（账号、AI 设置、提示词、助手工具设置、机器人设置、AI 识别工作区）各是一个单独的 SQLite 文件，
 * 各用自己的 PRAGMA user_version 记结构版本，不并进业务库的版本序列。
 * 建表语句留在各库的主人模块里，这里只管认版本、建库和拒收，规则对每个库都一样（旧库不迁移、不留备份）：
 * - 当前版本：原样打开；
 * - 没有版本号、也没有表（新文件）：按 create 建成当前结构，记成当前版本；
 * - 比当前版本旧，或者没记版本却有表（0.9.0 以前的程序留下的）：整个文件删掉（连同 -wal 等附属文件），按当前结构重建；
 * - 比程序新：拒绝打开，文件不动（多半是程序被换回了旧版本）；
 * - 打不开、不是数据库、被占用：不删，原样报错。
 * 拒绝时提示写明是哪个库、文件在哪、该怎么办。
 */
export type VersionedSqliteSpec = {
  /** 中文名，写进提示里，例如“账号库” */
  label: string;
  /** 当前程序的结构版本。结构变了就加一：旧版本的库下次打开时会被删掉重建 */
  latest: number;
  /** 空库按当前完整结构建表。在事务里执行，连接参数写在 pragmas 里 */
  create(db: DatabaseSync): void;
  /** 每次打开都要设的连接参数（synchronous、secure_delete 这类），在事务外执行 */
  pragmas?: string;
  /** 文件被别的连接占着时最多等多久（毫秒），默认 5000 */
  busyTimeout?: number;
};
/**
 * 配置库不能打开（比程序新、文件损坏或被占用、建库失败）。消息是给人看的中文，
 * 已经写明是哪个库、文件在哪、该怎么办；调用方把 message 原样给人看就行，不用再加堆栈。
 */
export class VersionedSqliteError extends Error {}

const BUSY_TIMEOUT = 5000;
const closing = (file: string) => `\n文件：${file}\n文件没有任何改动。`;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function inspect(db: DatabaseSync) {
  const version = pragmaInteger(db, 'user_version');
  const tables = count(db, "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return { version, tables };
}
/** 比当前版本旧的库（含没记版本却有表的）：要删掉重建。新文件（没版本、没表）不算 */
const outdated = (seen: { version: number; tables: number }, latest: number) =>
  seen.version < latest && (seen.version > 0 || seen.tables > 0);

/**
 * 登记表：哪个位置放的是哪个配置库。恢复备份时据此判断备份里的配置库当前程序打不打得开（checkVersionedSqlite），
 * 基础模块自己不用知道上层有哪些库、各支持到第几版。两个时候登记：
 * - openVersionedSqlite 每次打开，登记实际打开的位置；
 * - 各库的主人模块加载时用 registerVersionedSqlite 登记默认位置。恢复备份的维护命令行不打开任何配置库，
 *   只把主人模块加载进来，靠这一条才查得到。
 */
const openedAt = new Map<string, VersionedSqliteSpec>();
const homes: { spec: VersionedSqliteSpec; home: () => string }[] = [];
const locationKey = (file: string) => {
  const full = resolve(file);
  return process.platform === 'win32' ? full.toLowerCase() : full;
};
/**
 * 登记一个配置库的默认位置。home 用到时才算：配置目录这类位置要读环境变量，加载模块时不去碰。
 * 一个规格可以登记多个位置（提示词库每个模块一个文件）。
 */
export function registerVersionedSqlite(spec: VersionedSqliteSpec, home: () => string) {
  homes.push({ spec, home });
}
/** 登记过的配置库规格（同一个规格登记了几个位置也只算一个）：scripts/schema-dump.ts 按它们的建表生成行结构 */
export function registeredVersionedSqlite() {
  return [...new Set(homes.map((entry) => entry.spec))];
}
function specAt(file: string) {
  const key = locationKey(file);
  const opened = openedAt.get(key);
  if (opened) return opened;
  for (const entry of homes) {
    try {
      if (locationKey(entry.home()) === key) return entry.spec;
    } catch {
      /* 这个默认位置现在算不出来（比如配置目录设错了），当它没登记 */
    }
  }
  return null;
}

export type VersionedSqliteCheck = {
  /** 库的中文名 */
  label: string;
  /** 文件里记的版本，0 表示没记 */
  version: number;
  /** 当前程序的版本 */
  latest: number;
  /** newer：比程序新，打不开；older：比程序旧，打开时会被删掉重建；null：原样打得开 */
  problem: 'newer' | 'older' | null;
};
/**
 * 恢复备份之前用：candidate 是备份里的文件，home 是恢复以后它所在的位置。只读，不改任何文件。
 * home 没登记过返回 null（不知道它是哪个库，调用方只做完整性检查）；登记过就按 openVersionedSqlite 的规则判断。
 */
export function checkVersionedSqlite(candidate: string, home: string): VersionedSqliteCheck | null {
  const spec = specAt(home);
  if (!spec) return null;
  const db = new DatabaseSync(candidate, { readOnly: true });
  try {
    const seen = inspect(db);
    const problem = seen.version > spec.latest ? 'newer' : outdated(seen, spec.latest) ? 'older' : null;
    return { label: spec.label, version: seen.version, latest: spec.latest, problem };
  } finally {
    db.close();
  }
}

/**
 * 打开前先看一眼：比当前版本旧的库整个删掉（连同附属文件），之后按新库建。
 * 打不开、不是数据库的不删，留给后面按统一的说法报错。删不掉（被别的程序占着）照样报错，不往下建。
 */
function discardOutdated(file: string, spec: VersionedSqliteSpec) {
  if (file === ':memory:' || !existsSync(file)) return;
  let seen: { version: number; tables: number };
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      seen = inspect(db);
    } finally {
      db.close();
    }
  } catch {
    return;
  }
  if (!outdated(seen, spec.latest)) return;
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
  } catch (error) {
    throw new VersionedSqliteError(
      `${spec.label}是旧版本（第 ${seen.version} 版，当前是第 ${spec.latest} 版），要删掉重建，但文件删不掉（${reasonOf(error)}）。` +
        '请关掉占用它的程序后再启动。' +
        closing(file),
    );
  }
}

/**
 * 把库带到当前版本：新库建表，当前版本不动，比程序新的拒绝。
 * 返回 false 表示拿到写锁后发现别的程序刚改过这个库，要重新判断一次。
 */
function settle(db: DatabaseSync, file: string, spec: VersionedSqliteSpec) {
  const seen = inspect(db);
  if (seen.version === spec.latest) return true;
  if (seen.version > spec.latest)
    throw new VersionedSqliteError(
      `${spec.label}比当前程序新，不能打开：它是第 ${seen.version} 版，当前程序最多支持第 ${spec.latest} 版，多半是程序被换回了旧版本。请换回新版本的程序再启动。` +
        closing(file),
    );
  // 走到这里只剩新文件（旧库在打开前已经删掉）；别的程序刚好在这一刻放进来旧库，下一轮重新判断时会被拒绝
  if (seen.tables > 0)
    throw new VersionedSqliteError(
      `${spec.label}不能打开：打开的同时有别的程序写进了旧版本的内容，请关掉其它程序后再启动。` + closing(file),
    );
  let open = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    open = true;
    const now = inspect(db);
    if (now.version !== seen.version || now.tables !== seen.tables) {
      db.exec('ROLLBACK');
      open = false;
      return false;
    }
    spec.create(db);
    db.exec(`PRAGMA user_version=${spec.latest}`);
    db.exec('COMMIT');
    open = false;
    return true;
  } catch (error) {
    // 磁盘满、读写出错这类情况 SQLite 已经自己退回了，再退一次会报错，不能让它盖住原来的原因
    if (open)
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 退回失败时要报的是上面建库失败的原因，退回本身的错不再另报 */
      }
    throw new VersionedSqliteError(`${spec.label}没有建成：${reasonOf(error)}\n文件：${file}`);
  }
}

/** 文件读不出来时该怎么办：被占用时不能让人把文件移走，损坏或根本不是数据库的才叫人恢复或移走 */
function unreadableAdvice(error: unknown) {
  const code = sqliteCode(error);
  if (code === SQLITE_CODE.busy || code === SQLITE_CODE.locked)
    return '文件正被别的程序占用。请关掉占用它的程序（或等它用完），稍后再启动。';
  if (code === SQLITE_CODE.corrupt || code === SQLITE_CODE.notADatabase)
    return '文件不是 SQLite 数据库，或者已经损坏。请从备份恢复这个文件，或把它移走保存后再启动。';
  return '文件读不出来。请检查文件和目录的读写权限。';
}

/** 打开一个配置库并带到当前版本（规则见文件开头）。':memory:' 也能用（每次都是空库，直接建）。 */
export function openVersionedSqlite(file: string, spec: VersionedSqliteSpec): DatabaseSync {
  if (!Number.isInteger(spec.latest) || spec.latest < 1) throw new Error(`${spec.label}的结构版本必须是正整数。`);
  // 先登记再打开：就算这次被拒绝，也知道这个位置是哪个库、支持到第几版
  if (file !== ':memory:') openedAt.set(locationKey(file), spec);
  discardOutdated(file, spec);
  let db: DatabaseSync;
  try {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);
  } catch (error) {
    throw new VersionedSqliteError(
      `${spec.label}不能打开：文件或它所在的目录打不开（${reasonOf(error)}）。请检查目录是否存在、运行程序的账号有没有读写权限。\n文件：${file}`,
    );
  }
  try {
    db.exec(`PRAGMA busy_timeout=${spec.busyTimeout ?? BUSY_TIMEOUT}; PRAGMA foreign_keys=ON;`);
    try {
      inspect(db);
    } catch (error) {
      throw new VersionedSqliteError(`${spec.label}不能打开：${unreadableAdvice(error)}（${reasonOf(error)}）` + closing(file));
    }
    if (spec.pragmas) db.exec(spec.pragmas);
    for (let attempt = 0; !settle(db, file, spec); attempt++)
      if (attempt >= 2)
        throw new VersionedSqliteError(`${spec.label}不能打开：另一个程序正在改这个库，请稍后再启动。\n文件：${file}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
