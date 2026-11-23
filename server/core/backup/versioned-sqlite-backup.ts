import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { errorMessage } from '../../../shared/core/index.js';
import { SNAPSHOT_DIRECTORY, STAMP_PATTERN, stamp, stampTime } from '../schema/index.js';
import { PARTIAL_SUFFIX, consistentCopy } from '../storage/sqlite/sqlite-copy.js';
import { integrityPassed, pragmaInteger } from '../storage/sqlite/sql.js';
import { inspect, latestOf, registeredHomes, type ResolvedHomes, type VersionedSqliteSpec } from './versioned-sqlite-spec.js';

/*
 * 配置库的升级前备份，和补丁回滚时把它换回去（规则见 versioned-sqlite-spec.ts 开头）。
 * 文件都放在库文件同目录的 snapshots/ 下（和业务库快照同名的目录，完整备份不带它，见 backup.ts 的 walk）：
 * - 升级前备份：<库文件名去掉 .sqlite>-upgrade-v<旧版>-to-v<新版>-<时间>.sqlite。同一个“从第几版到第几版”只留最新一份，
 *   不同的版本对各留一份，最多留最近 KEPT_VERSION_PAIRS 个版本对：升级失败、服务反复重启做的多份挤不掉更早升级留下的；
 * - 换回时换下来的库：<库文件名去掉 .sqlite>-before-revert-<时间>.sqlite，不自动清理，人工核对完可以删；
 * - 升级没做完（步骤自己结束了事务）时留下的升级前备份：<库文件名去掉 .sqlite>-before-unfinished-v<旧版>-to-v<新版>-<时间>.sqlite，
 *   不自动清理，有它这个库就拒绝打开，人工把它移回库文件的位置以后才正常（见 keepUnfinishedBackup）。
 * 时间是 stamp()（UTC，冒号和点换成横线，后面接 6 位随机）。文件名格式定下不改：换回、回滚脚本、文档都靠它找。
 * 两种副本都去掉了 scrubBackup 要去掉的内容（账号库没有登录会话），文件权限和库文件一样。
 */

/** 文件权限只取读写执行那几位 */
const PERMISSION_BITS = 0o777;
const SQLITE_SUFFIX = '.sqlite';
/** 每个库文件最多留几个版本对的升级前备份 */
const KEPT_VERSION_PAIRS = 3;
/** 库文件旁边有这些就说明没正常关掉（或不是回滚日志模式），不能直接换掉库文件 */
const SIDE_FILES = ['-wal', '-shm', '-journal'];

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 库文件名去掉 .sqlite：备份文件名的开头 */
const baseOf = (file: string) => basename(file).replace(new RegExp(escaped(SQLITE_SUFFIX) + '$'), '');
const snapshotDir = (file: string) => join(dirname(file), SNAPSHOT_DIRECTORY);
const modeOf = (file: string) => statSync(file).mode & PERMISSION_BITS;

/** 这个库文件的升级前备份文件名：第 1、2 组是从第几版到第几版，第 3 组是时间 */
const upgradeBackupPattern = (file: string) =>
  new RegExp(String.raw`^${escaped(baseOf(file))}-upgrade-v(\d+)-to-v(\d+)-${STAMP_PATTERN}${escaped(SQLITE_SUFFIX)}$`);
/** 升级前备份的完整路径 */
function upgradeBackupPath(file: string, from: number, to: number) {
  return join(snapshotDir(file), `${baseOf(file)}-upgrade-v${from}-to-v${to}-${stamp()}${SQLITE_SUFFIX}`);
}
/** 换回时换下来的库的完整路径 */
function beforeRevertPath(file: string) {
  return join(snapshotDir(file), `${baseOf(file)}-before-revert-${stamp()}${SQLITE_SUFFIX}`);
}

/** 升级没做完时留下的升级前备份：名字里没有“-upgrade-v”，清理、换回、回滚脚本都认不出它，打开时看到它就拒绝 */
const unfinishedPattern = (file: string) =>
  new RegExp(String.raw`^${escaped(baseOf(file))}-before-unfinished-v\d+-to-v\d+-${STAMP_PATTERN}${escaped(SQLITE_SUFFIX)}$`);
/**
 * 步骤自己结束了事务（规矩不许）、库成了半截时：把这次的升级前备份改名留下，既保护它不被以后的清理删掉，又当“升级没做完”的标记。
 * 返回改名以后的路径。
 */
export function keepUnfinishedBackup(file: string, backup: string, from: number, to: number) {
  const kept = join(snapshotDir(file), `${baseOf(file)}-before-unfinished-v${from}-to-v${to}-${stamp()}${SQLITE_SUFFIX}`);
  renameSync(backup, kept);
  return kept;
}
/** 升级没做完时给人看的处理办法：用哪个文件换回、换回以后怎么才能正常打开 */
export const unfinishedAdvice = (kept: string) =>
  `\n升级前备份：${kept}\n处理办法：先停掉程序，把这份升级前备份移到上面“文件”的位置、覆盖现在这个半截的库` +
  '（升级前的数据都在备份里；库旁边有 -journal 这类附属文件就一起删掉）；移走以后它就不再挡着，' +
  '换上修好的程序（或旧版本的程序）启动就能正常打开。请把这段提示交给维护人员。';
/** snapshots/ 里的文件名；还没有这个目录（或那个位置不是目录，做备份时会按备份做不成报出来）就是空的 */
function snapshotNames(file: string) {
  const dir = snapshotDir(file);
  return existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : [];
}
/** 这个库上次升级没做完时留下的升级前备份；没有返回 null */
export function unfinishedBackup(file: string) {
  const pattern = unfinishedPattern(file);
  const found = snapshotNames(file)
    .filter((name) => pattern.test(name))
    .sort();
  return found.length ? join(snapshotDir(file), found[found.length - 1]) : null;
}

/** 副本上：权限先改成和库文件一样，再去掉不该留的内容，核对完整性和版本 */
function prepareCopy(spec: VersionedSqliteSpec, version: number, mode: number) {
  return (copy: string) => {
    chmodSync(copy, mode);
    const db = new DatabaseSync(copy);
    try {
      spec.scrubBackup?.(db);
      if (!integrityPassed(db, 'quick_check')) throw new Error('副本没有通过完整性检查');
      const seen = pragmaInteger(db, 'user_version');
      if (seen !== version) throw new Error(`副本是第 ${seen} 版，应该是第 ${version} 版`);
    } finally {
      db.close();
    }
  };
}

type UpgradeBackup = { name: string; from: number; to: number; at: string };
/** 这个库文件的升级前备份，新的在前 */
function upgradeBackups(file: string): UpgradeBackup[] {
  const pattern = upgradeBackupPattern(file);
  return snapshotNames(file)
    .flatMap((name) => {
      const m = pattern.exec(name);
      return m ? [{ name, from: Number(m[1]), to: Number(m[2]), at: m[3] }] : [];
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * 同一个库文件的升级前备份：每个版本对只留最新一份，最多留最近几个版本对；中断留下的 .partial 一起删。
 * 调用方持有这个库的写锁，没有别人在做这个库的备份。别的库、别的文件不碰。
 */
function pruneUpgradeBackups(file: string) {
  const dir = snapshotDir(file);
  const pattern = upgradeBackupPattern(file);
  const partial = readdirSync(dir).filter(
    (name) => name.endsWith(PARTIAL_SUFFIX) && pattern.test(name.slice(0, -PARTIAL_SUFFIX.length)),
  );
  const pairs = new Set<string>();
  const old = upgradeBackups(file).filter((backup) => {
    const pair = `${backup.from}-${backup.to}`;
    if (pairs.has(pair) || pairs.size >= KEPT_VERSION_PAIRS) return true;
    pairs.add(pair);
    return false;
  });
  for (const name of [...old.map((backup) => backup.name), ...partial]) rmSync(join(dir, name), { force: true });
}

/**
 * 升级前备份：调用方已经拿到这个库的写锁（BEGIN IMMEDIATE）、还没改任何东西。返回备份的路径。
 * 做不成就抛错（原因是原始的），调用方不再升级。清理旧备份失败不影响这次升级，打一行日志，下次升级再清。
 */
export function takeUpgradeBackup(file: string, spec: VersionedSqliteSpec, from: number, to: number) {
  const target = upgradeBackupPath(file, from, to);
  mkdirSync(dirname(target), { recursive: true });
  consistentCopy(file, target, prepareCopy(spec, from, modeOf(file)));
  try {
    pruneUpgradeBackups(file);
  } catch (error) {
    console.warn(`${spec.label}的旧升级前备份没有清掉（${errorMessage(error)}），下次升级再清：${dirname(target)}`);
  }
  return target;
}

export type RevertedConfig = {
  label: string;
  /** 库文件 */
  file: string;
  /** 换回之前（比程序新）的版本 */
  from: number;
  /** 换回之后的版本，就是当前程序的版本 */
  to: number;
  /** 换进去的升级前备份 */
  backup: string;
  /** 换下来的库留在哪 */
  keptAs: string;
};
/** 没换回的库：file 是 null 表示这个库的默认位置算不出来（原因在 reason 里） */
export type RevertFailure = { label: string; file: string | null; reason: string };

/** 只读看库文件的版本 */
function versionAt(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return inspect(db).version;
  } finally {
    db.close();
  }
}

/** 从 from 版升到 to 版时做的升级前备份里最新的一份（给了 since 只看这个时间以后的）；没有返回 null */
function latestBackup(file: string, from: number, to: number, since: Date | undefined) {
  const found = upgradeBackups(file).find(
    (backup) => backup.from === from && backup.to === to && (!since || stampTime(backup.at) >= since.getTime()),
  );
  return found ? join(snapshotDir(file), found.name) : null;
}

/** 换回一个库；不比程序新返回 null，换不了抛错（这时库文件没动） */
function revertOne(file: string, spec: VersionedSqliteSpec, since: Date | undefined): RevertedConfig | null {
  const version = versionAt(file),
    latest = latestOf(spec);
  if (version <= latest) return null;
  const sides = SIDE_FILES.filter((suffix) => existsSync(file + suffix));
  if (sides.length)
    throw new Error(
      `库文件旁边还有 ${sides.map((suffix) => basename(file) + suffix).join('、')}：上次没有正常关掉，可能有没写完的改动，不能直接换掉。` +
        '请确认服务已经停止，再交给维护人员处理',
    );
  const backup = latestBackup(file, latest, version, since);
  if (!backup)
    throw new Error(
      `它是第 ${version} 版，比当前程序（第 ${latest} 版）新，snapshots 里没有从第 ${latest} 版升到第 ${version} 版的升级前备份` +
        (since ? `（${since.toISOString()} 以后做的）` : ''),
    );
  const mode = modeOf(file);
  // 先把现在的库（去掉会话）留一份，再用升级前备份整个换掉：改名是一步完成的，换不上时库文件不动
  const keptAs = beforeRevertPath(file);
  consistentCopy(file, keptAs, prepareCopy(spec, version, mode));
  consistentCopy(backup, file, prepareCopy(spec, latest, mode));
  return { label: spec.label, file, from: version, to: latest, backup, keptAs };
}

/**
 * 补丁回滚、换回旧程序以后用：每个配置库位置（默认是登记过的默认位置），版本比当前程序新的，
 * 换回从当前程序的版本升上去时做的升级前备份（取最新一份；给了 since 只用这个时间以后做的）。
 * 换之前把现在的库去掉会话留在 snapshots/ 下（beforeRevertPath），不删。
 * 不比程序新的、文件不存在的不动；默认位置算不出来的记进 failed（看不了它是不是比程序新，不能当没事）。
 * 一个库换不了只记进 failed，接着换别的。
 * 换回以后：新程序运行期间对这些库的改动不在库里（在留下的那份里），账号库没有会话，所有人要重新登录。
 */
export function revertConfigUpgrades(since?: Date, homes: ResolvedHomes = registeredHomes()) {
  const reverted: RevertedConfig[] = [];
  const failed: RevertFailure[] = homes.unresolved.map(({ spec, reason }) => ({
    label: spec.label,
    file: null,
    reason: `默认位置算不出来（${reason}），看不了它要不要换回`,
  }));
  for (const { spec, file } of homes.found) {
    if (!existsSync(file)) continue;
    try {
      const done = revertOne(file, spec, since);
      if (done) reverted.push(done);
    } catch (error) {
      failed.push({ label: spec.label, file, reason: errorMessage(error) });
    }
  }
  return { reverted, failed };
}
