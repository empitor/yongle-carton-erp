import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { errorMessage } from '../../shared/core/index.js';
import type { UpgradeStep } from './schema/index.js';
import { count, pragmaInteger } from './sql.js';

/**
 * 配置库（账号、出错记录、AI 设置、提示词、助手工具设置、机器人设置、AI 识别工作区）各是一个单独的 SQLite 文件，
 * 各用自己的 PRAGMA user_version 记结构版本，不并进业务库的版本序列。这里是规格、版本分类和登记表；
 * 打开和升级在 versioned-sqlite.ts，升级前备份和补丁回滚时的换回在 versioned-sqlite-backup.ts。
 *
 * 版本：基线（baseline）是 0.9.0 发布时的版本（以后新加的库：第一次发布时的版本），定下不改；
 * 当前版本 = 基线 + 步骤数（latestOf）。比基线旧的（含没记版本却有表的）是 0.9.0 以前留下的，打开时删掉重建；
 * 基线到当前之间的，打开时先留备份再一步步升级，数据留着。
 *
 * 改结构的做法：在 steps 末尾加一步，同时把 create 改成改完以后的完整结构；规矩和业务库一样（server/core/schema/steps.ts 开头），另外：
 * - 步骤写在规格所在的文件里（tests/schema-layout.test.ts 只放行这些文件写改表语句）；已发布的步骤不许改，编号不许复用；
 * - 步骤里不许自己 COMMIT、ROLLBACK（执行器每步之后查，结束了事务就停下报错）；
 * - 配置库的表不用 AUTOINCREMENT（执行器不补自增计数；tests/config-db-evolution.test.ts 查）；
 * - 账号库的会话表 auth_sessions 的表名、“删光就是清空会话”的做法以后不许改：补丁回滚时由旧程序的 clearSessions
 *   去清新程序的库（见 scrubBackup），表名一变旧程序就清不掉、也不报错（tests/config-db-evolution.test.ts 查表还在）；
 * - 每一步带一份数据样例：tests/fixtures/upgrade-samples/<短名>/v<版本号>.json（短名见 scripts/config-db-dump.ts，写法见 tests/upgrade-step-samples.test.ts 开头）；
 * - 基线快照 tests/fixtures/config-db/<短名>-v<基线>.sql 定下以后不许改。
 * 升级完不在运行时核对结构（业务库要核对，schema/index.ts）：配置库的“步骤走完和 create 建的一样”由
 * tests/config-db-evolution.test.ts 从基线快照一路升级来比，运行时再核对挡不住任何测试没挡住的东西。
 */
export type VersionedSqliteSpec = {
  /** 中文名，写进提示里，例如“账号库” */
  label: string;
  /** 基线版本（正整数），定下不改。比它旧的库打开时删掉重建 */
  baseline: number;
  /** 基线以后的升级步骤，版本号从 baseline+1 起连续。在升级的总事务里执行，外键检查已经关掉 */
  steps: readonly UpgradeStep[];
  /** 空库按当前完整结构建表。在事务里执行，连接参数写在 pragmas 里 */
  create(db: DatabaseSync): void;
  /**
   * 完整备份、升级前备份、补丁回滚时换下来的库，副本上要去掉的内容（账号库：登录会话）。
   * 跑在副本自己的版本上：升级前备份比当前程序旧；换下来的那份比当前程序新（补丁回滚时由旧程序执行，
   * 旧程序不知道新版本的结构）。所以要对基线以来的每一版、也对以后的每一版都成立，靠的是上面那条“会话表不许改”。
   */
  scrubBackup?(copy: DatabaseSync): void;
  /** 每次打开都要设的连接参数（synchronous、secure_delete 这类），在事务外执行 */
  pragmas?: string;
  /** 文件被别的连接占着时最多等多久（毫秒），默认 5000 */
  busyTimeout?: number;
};
/**
 * 配置库不能打开（比程序新、文件损坏或被占用、建库或升级失败、升级前备份没做成）。消息是给人看的中文，
 * 已经写明是哪个库、文件在哪、该怎么办；调用方把 message 原样给人看就行，不用再加堆栈。
 */
export class VersionedSqliteError extends Error {}

/** 当前程序的结构版本 */
export const latestOf = (spec: VersionedSqliteSpec) => spec.baseline + spec.steps.length;

/** 规格写错（基线不是正整数、步骤不是从基线起一版一步）是程序问题：打开任何文件之前直接报错。返回按版本排好的步骤 */
export function checkedSteps(spec: VersionedSqliteSpec) {
  if (!Number.isInteger(spec.baseline) || spec.baseline < 1) throw new Error(`${spec.label}的基线版本必须是正整数。`);
  const sorted = [...spec.steps].sort((a, b) => a.version - b.version);
  sorted.forEach((step, index) => {
    if (step.version !== spec.baseline + 1 + index)
      throw new Error(
        `${spec.label}的升级步骤必须从第 ${spec.baseline + 1} 版起连续，第 ${index + 1} 步写的是第 ${step.version} 版。`,
      );
  });
  return sorted;
}

export type SeenVersion = { version: number; tables: number };
export function inspect(db: DatabaseSync): SeenVersion {
  const version = pragmaInteger(db, 'user_version');
  const tables = count(db, "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return { version, tables };
}

/**
 * 一个库文件对当前程序来说是什么状态：
 * - empty：新文件（没版本、没表），按当前结构建；current：当前版本，原样打开；
 * - upgrade：在基线和当前之间，留备份后升级；legacy：比基线旧或没记版本却有表，删掉重建；
 * - newer：比程序新，拒绝打开。
 */
export type VersionedSqliteState = 'empty' | 'current' | 'upgrade' | 'legacy' | 'newer';
export function stateOf(seen: SeenVersion, spec: VersionedSqliteSpec): VersionedSqliteState {
  const latest = latestOf(spec);
  if (seen.version > latest) return 'newer';
  if (seen.version === latest) return 'current';
  if (seen.version === 0 && seen.tables === 0) return 'empty';
  return seen.version >= spec.baseline ? 'upgrade' : 'legacy';
}

/**
 * 登记表：哪个位置放的是哪个配置库。恢复备份时据此判断备份里的配置库当前程序打不打得开（checkVersionedSqlite），
 * 补丁回滚时据此找要换回的库（revertConfigUpgrades）；基础模块自己不用知道上层有哪些库。两个时候登记：
 * - openVersionedSqlite 每次打开，登记实际打开的位置；
 * - 各库的主人模块加载时用 registerVersionedSqlite 登记默认位置。恢复备份、换回的维护命令行不打开任何配置库，
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
/** 登记过的配置库规格（同一个规格登记了几个位置也只算一个）：生成行结构和基线快照的脚本按它们走 */
export function registeredVersionedSqlite() {
  return [...new Set(homes.map((entry) => entry.spec))];
}
/** 记下这次实际打开的位置是哪个库 */
export function rememberOpened(file: string, spec: VersionedSqliteSpec) {
  openedAt.set(locationKey(file), spec);
}
/** 一个配置库位置：库文件在哪、是哪个库 */
export type ConfigLocation = { spec: VersionedSqliteSpec; file: string };
/** 算出来的默认位置（found，同一位置登记了两次只算第一次），和算不出来的（unresolved，比如配置目录设错了，带原因） */
export type ResolvedHomes = { found: ConfigLocation[]; unresolved: { spec: VersionedSqliteSpec; reason: string }[] };
/** 把登记的默认位置算出来。用到时才算：配置目录这类位置要读环境变量 */
export function resolveHomes(entries: readonly { spec: VersionedSqliteSpec; home: () => string }[]): ResolvedHomes {
  const seen = new Set<string>();
  const resolved: ResolvedHomes = { found: [], unresolved: [] };
  for (const { spec, home } of entries) {
    let file: string;
    try {
      file = home();
    } catch (error) {
      resolved.unresolved.push({ spec, reason: errorMessage(error) });
      continue;
    }
    if (seen.has(locationKey(file))) continue;
    seen.add(locationKey(file));
    resolved.found.push({ spec, file });
  }
  return resolved;
}
/** 登记过的默认位置（补丁回滚时换回用：算不出来的也要报出来） */
export const registeredHomes = () => resolveHomes(homes);
/**
 * 这个位置放的是哪个库：打开过的优先，再找默认位置；都没有返回 null。
 * 恢复备份前用：算不出来的默认位置当它没登记，那里本来就不会有文件，恢复只对它查完整性。
 */
export function specAt(file: string) {
  const key = locationKey(file);
  return openedAt.get(key) ?? registeredHomes().found.find((entry) => locationKey(entry.file) === key)?.spec ?? null;
}
