import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage } from '../../shared/core/index.js';
import type { UpgradeStep } from './schema/index.js';
import { SQLITE_CODE, sqliteCode } from './errors.js';
import { exists } from './sql.js';
import { keepUnfinishedBackup, takeUpgradeBackup, unfinishedAdvice, unfinishedBackup } from './versioned-sqlite-backup.js';
import {
  VersionedSqliteError,
  checkedSteps,
  inspect,
  latestOf,
  rememberOpened,
  specAt,
  stateOf,
  type SeenVersion,
  type VersionedSqliteSpec,
  type VersionedSqliteState,
} from './versioned-sqlite-spec.js';

/*
 * 打开配置库（规格、版本和登记表见 versioned-sqlite-spec.ts）。建表语句和升级步骤在各库的主人模块里，这里只管认版本、建库、升级和拒收，
 * 规则对每个库都一样：
 * - 当前版本：原样打开；
 * - 没有版本号、也没有表（新文件）：按 create 建成当前结构，记成当前版本；
 * - 基线到当前之间：拿到写锁以后先留一份升级前备份（versioned-sqlite-backup.ts），再在一个事务里一步步升级，数据留着；
 *   中途出错整个退回，文件和升级前一模一样，拒绝打开；任何情况下都不因为升级失败删库；
 * - 比基线旧，或者没记版本却有表（0.9.0 以前的程序留下的）：整个文件删掉（连同 -wal 等附属文件），按当前结构重建；
 * - 比程序新：拒绝打开，文件不动（多半是程序被换回了旧版本）；
 * - 上次升级没做完（步骤违规自己结束了事务，库是半截的，旁边留着 -before-unfinished- 备份）：拒绝打开，等人换回；
 * - 打不开、不是数据库、被占用：不删，原样报错。
 * 建库、升级都只在 BEGIN IMMEDIATE 里、并在锁里重新看过版本以后才做：两个程序同时打开，后到的等锁，拿到锁时已是当前版本，
 * 原样打开，不会升两遍、也不会多做一份备份。拒绝时提示写明是哪个库、文件在哪、该怎么办。
 */

const BUSY_TIMEOUT = 5000;
const closing = (file: string) => `\n文件：${file}\n文件没有任何改动。`;
/** 打开时要用到的：库文件、规格、排好的步骤 */
type Opening = { db: DatabaseSync; file: string; spec: VersionedSqliteSpec; steps: readonly UpgradeStep[] };

export type VersionedSqliteCheck = {
  /** 库的中文名 */
  label: string;
  /** 文件里记的版本，0 表示没记 */
  version: number;
  /** 这个库的基线版本 */
  baseline: number;
  /** 当前程序的版本 */
  latest: number;
  /** 放到这个位置以后打开时会怎样（见 VersionedSqliteState） */
  state: VersionedSqliteState;
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
    return { label: spec.label, version: seen.version, baseline: spec.baseline, latest: latestOf(spec), state: stateOf(seen, spec) };
  } finally {
    db.close();
  }
}

/**
 * 打开前先看一眼：比基线旧的库（这个库第一次发布以前的程序留下的）整个删掉（连同附属文件），之后按新库建。删库只有这一处，只看基线。
 * 打不开、不是数据库的不删，留给后面按统一的说法报错。删不掉（被别的程序占着）照样报错，不往下建。
 */
function discardLegacy(file: string, spec: VersionedSqliteSpec) {
  if (file === ':memory:' || !existsSync(file)) return;
  let seen: SeenVersion;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      seen = inspect(db);
    } finally {
      db.close();
    }
  } catch {
    // 打不开的不删：下面用读写连接再打开时按统一的说法报错
    return;
  }
  if (stateOf(seen, spec) !== 'legacy') return;
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
  } catch (error) {
    throw new VersionedSqliteError(
      `${spec.label}比基线（第 ${spec.baseline} 版）旧（${seen.version ? `第 ${seen.version} 版` : '没有记版本'}），要删掉重建，但文件删不掉（${errorMessage(error)}）。` +
        '请关掉占用它的程序后再启动。' +
        closing(file),
    );
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

/** 退回事务。退回失败时要报的是原来的错；没退回成的改动留在日志里，下次打开时 SQLite 会自己退回 */
function rollback(db: DatabaseSync) {
  if (!db.isTransaction) return;
  try {
    db.exec('ROLLBACK');
  } catch {
    /* 见上 */
  }
}

/** 拿写锁，拿不到按“被占用”拒绝（这时什么都没改） */
function lockOrRefuse(o: Opening) {
  try {
    o.db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    throw new VersionedSqliteError(`${o.spec.label}不能打开：${unreadableAdvice(error)}（${errorMessage(error)}）` + closing(o.file));
  }
}
/** 拿到写锁后再看一眼：两次看之间被别的程序改过，就不能照原来的判断做 */
const changedSince = (db: DatabaseSync, seen: SeenVersion) => {
  const now = inspect(db);
  return now.version !== seen.version || now.tables !== seen.tables;
};

/** 新文件：在一个事务里建成当前结构。返回 false 表示拿到写锁后发现库被改过，要重新判断 */
function create(o: Opening, seen: SeenVersion) {
  try {
    o.db.exec('BEGIN IMMEDIATE');
    if (changedSince(o.db, seen)) {
      o.db.exec('ROLLBACK');
      return false;
    }
    o.spec.create(o.db);
    o.db.exec(`PRAGMA user_version=${latestOf(o.spec)}`);
    o.db.exec('COMMIT');
    return true;
  } catch (error) {
    // 磁盘满、读写出错这类情况 SQLite 已经自己退回了；退回不了也不能盖住原来的原因
    rollback(o.db);
    throw new VersionedSqliteError(`${o.spec.label}没有建成：${errorMessage(error)}\n文件：${o.file}`);
  }
}

/** 升级前备份，做不成就拒绝（这时还没改任何东西，调用方退回事务） */
function backupOrRefuse(o: Opening, from: number, to: number) {
  try {
    return takeUpgradeBackup(o.file, o.spec, from, to);
  } catch (error) {
    throw new VersionedSqliteError(
      `${o.spec.label}要从第 ${from} 版升级到第 ${to} 版，升级前备份没有做成（${errorMessage(error)}），没有开始升级。` +
        `请检查 ${dirname(o.file)} 所在磁盘的空间和读写权限后再启动。` +
        closing(o.file),
    );
  }
}

/** 升级失败（已整体退回）的提示：哪个库、从第几版到第几版、哪里出错；备份做成了才说备份在哪 */
function upgradeFailed(o: Opening, from: number, what: string, backup: string | null) {
  return new VersionedSqliteError(
    `${o.spec.label}从第 ${from} 版升级到第 ${latestOf(o.spec)} 版失败（${what}），已整体退回。` +
      closing(o.file) +
      (backup ? `\n升级前备份：${backup}` : '') +
      '\n请换回旧版本的程序继续使用，并把这段提示交给维护人员。',
  );
}

/**
 * 步骤自己结束了事务（规矩不许）：这一步之前的改动可能已经写进文件，库成了半截。把升级前备份改名留下
 * （清理删不掉它，它也是“升级没做完”的标记，以后打开都拒绝，不在半截的库上重跑步骤）。改名失败就照原名说，并提醒先复制走。
 */
function selfEnded(o: Opening, from: number, what: string, backup: string) {
  let kept = backup,
    note = '';
  try {
    kept = keepUnfinishedBackup(o.file, backup, from, latestOf(o.spec));
  } catch (error) {
    note = `\n这份备份没能改名保护起来（${errorMessage(error)}），以后的升级会清掉它，请先把它复制到别处。`;
  }
  return new VersionedSqliteError(
    `${o.spec.label}从第 ${from} 版升级到第 ${latestOf(o.spec)} 版停在${what}：这一步自己结束了事务（提交或退回），升级没有做完。` +
      `库现在是半截的：这一步之前的改动可能已经写进文件，版本号还是第 ${from} 版；以后打开都会拒绝，不会在半截的库上接着升级。` +
      `\n文件：${o.file}` +
      unfinishedAdvice(kept) +
      note,
  );
}

/** 上次升级没做完（库是半截的，旁边留着改了名的升级前备份）：拒绝打开，文件不动 */
function refuseUnfinished(file: string, spec: VersionedSqliteSpec) {
  const kept = file === ':memory:' ? null : unfinishedBackup(file);
  if (kept)
    throw new VersionedSqliteError(
      `${spec.label}上次升级没有做完，库是半截的，不能打开，也不会在半截的库上接着升级。` + closing(file) + unfinishedAdvice(kept),
    );
}

/**
 * 在已经开好的事务里一步步升级；哪一步出错就说清是哪一步。
 * 每步之后查事务还在：步骤自己 COMMIT、ROLLBACK 了（规矩不许），后面的不能接着做，这一步之前的改动可能已经写进文件。
 */
function runSteps(o: Opening, from: number, backup: string) {
  for (const step of o.steps.filter((s) => s.version > from)) {
    const what = `第 ${step.version} 步“${step.name}”`;
    try {
      step.up(o.db);
    } catch (error) {
      throw upgradeFailed(o, from, `${what}：${errorMessage(error)}`, backup);
    }
    if (!o.db.isTransaction) throw selfEnded(o, from, what, backup);
  }
  if (exists(o.db, 'PRAGMA foreign_key_check')) throw upgradeFailed(o, from, '升级后数据关联校验没有通过', backup);
  o.db.exec(`PRAGMA user_version=${latestOf(o.spec)}`);
}

/**
 * 基线到当前之间：拿写锁 → 锁里再看一眼 → 升级前备份 → 一步步升级 → 提交。返回 false 表示要重新判断。
 * 步骤可能要重建表，外键检查先关掉（事务里改这个设置无效，必须在事务外），提交前统一查一遍。
 * 锁里再看、提交这些地方出的错（磁盘满、读写出错、被别人占着）也整体退回，同样按库名说清。
 */
function upgrade(o: Opening, seen: SeenVersion) {
  const to = latestOf(o.spec);
  let backup: string | null = null;
  o.db.exec('PRAGMA foreign_keys=OFF');
  try {
    lockOrRefuse(o);
    try {
      if (changedSince(o.db, seen)) {
        o.db.exec('ROLLBACK');
        return false;
      }
      backup = backupOrRefuse(o, seen.version, to);
      runSteps(o, seen.version, backup);
      o.db.exec('COMMIT');
    } catch (error) {
      rollback(o.db);
      if (error instanceof VersionedSqliteError) throw error;
      const busy = sqliteCode(error) === SQLITE_CODE.busy || sqliteCode(error) === SQLITE_CODE.locked;
      throw upgradeFailed(o, seen.version, (busy ? '文件正被别的程序占用：' : '') + errorMessage(error), backup);
    }
    console.log(`${o.spec.label}已从第 ${seen.version} 版升级到第 ${to} 版，升级前备份：${backup}`);
    return true;
  } finally {
    o.db.exec('PRAGMA foreign_keys=ON');
  }
}

/** 把库带到当前版本。返回 false 表示拿到写锁后发现别的程序刚改过这个库，要重新判断一次 */
function settle(o: Opening) {
  const seen = inspect(o.db);
  const state = stateOf(seen, o.spec);
  switch (state) {
    case 'current':
      return true;
    case 'newer':
      throw new VersionedSqliteError(
        `${o.spec.label}比当前程序新，不能打开：它是第 ${seen.version} 版，当前程序最多支持第 ${latestOf(o.spec)} 版，多半是程序被换回了旧版本。请换回新版本的程序再启动。` +
          closing(o.file),
      );
    case 'legacy':
      // 旧库在打开前已经删掉；别的程序刚好在这一刻放进来旧库，不在这里删
      throw new VersionedSqliteError(
        `${o.spec.label}不能打开：打开的同时有别的程序写进了旧版本的内容，请关掉其它程序后再启动。` + closing(o.file),
      );
    case 'empty':
      return create(o, seen);
    case 'upgrade':
      return upgrade(o, seen);
  }
}

/** 打开文件（目录不在就建），打不开时说清是哪个库 */
function openFile(file: string, spec: VersionedSqliteSpec) {
  try {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    return new DatabaseSync(file);
  } catch (error) {
    throw new VersionedSqliteError(
      `${spec.label}不能打开：文件或它所在的目录打不开（${errorMessage(error)}）。请检查目录是否存在、运行程序的账号有没有读写权限。\n文件：${file}`,
    );
  }
}

/** 打开一个配置库并带到当前版本（规则见文件开头）。':memory:' 也能用（每次都是空库，直接建）。 */
export function openVersionedSqlite(file: string, spec: VersionedSqliteSpec): DatabaseSync {
  const steps = checkedSteps(spec);
  // 先登记再打开：就算这次被拒绝，也知道这个位置是哪个库、支持到第几版
  if (file !== ':memory:') rememberOpened(file, spec);
  refuseUnfinished(file, spec);
  discardLegacy(file, spec);
  const db = openFile(file, spec);
  try {
    db.exec(`PRAGMA busy_timeout=${spec.busyTimeout ?? BUSY_TIMEOUT}; PRAGMA foreign_keys=ON;`);
    try {
      inspect(db);
    } catch (error) {
      throw new VersionedSqliteError(`${spec.label}不能打开：${unreadableAdvice(error)}（${errorMessage(error)}）` + closing(file));
    }
    if (spec.pragmas) db.exec(spec.pragmas);
    const o = { db, file, spec, steps };
    for (let attempt = 0; !settle(o); attempt++)
      if (attempt >= 2)
        throw new VersionedSqliteError(`${spec.label}不能打开：另一个程序正在改这个库，请稍后再启动。\n文件：${file}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
