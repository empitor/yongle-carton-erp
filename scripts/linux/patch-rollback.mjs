// 补丁回滚时的数据步骤（apply-patch.mjs 用）：先换回新程序升级过的配置库（账号、提示词、AI 设置等小库），
// 再按业务库的结构版本决定要不要恢复。只用 Node 自带模块，不引 server 代码；测试直接导入这个文件。
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RESTORE_NOTE, STOPPED, manualSteps, restoreSteps, rollbackPlan, serviceUser, startSteps, stopStep } from './patch-logic.mjs';

/** 旧程序换回配置库的维护命令（erp.sh 的动作） */
export const REVERT_ACTION = 'revert-config-upgrades';

/** 换回来的旧程序有没有换回配置库的命令：看它的 erp.sh 里 case 分支的动作有没有 REVERT_ACTION */
export function hasRevertCommand(erpShText) {
  for (const match of String(erpShText || '').matchAll(/^\s*([a-z|-]+)\)/gm))
    if (match[1].split('|').includes(REVERT_ACTION)) return true;
  return false;
}

/**
 * 配置库升级前备份的文件名，照程序（server/core/backup/versioned-sqlite-backup.ts）另写一份，格式定下不改；
 * tests/core/patch-rollback.test.ts 拿程序真做出来的备份核对两边对得上：
 * <库文件名去掉 .sqlite>-upgrade-v<旧版>-to-v<新版>-<UTC 时间>-<6 位十六进制>.sqlite。
 * 业务库的升级快照叫 upgrade-v…（前面没有库名），不算在内。
 */
const CONFIG_UPGRADE_BACKUP = /^(.+)-upgrade-v(\d+)-to-v(\d+)-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-[\da-f]{6}\.sqlite$/;
const SNAPSHOT_DIRECTORY = 'snapshots';
const stampTime = (at) => Date.parse(at.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));

/** 一个 snapshots/ 目录里 since 以后做的配置库升级前备份；库文件在 snapshots/ 的上一层 */
function backupsIn(snapshots, since) {
  return readdirSync(snapshots)
    .map((name) => ({ name, match: CONFIG_UPGRADE_BACKUP.exec(name) }))
    .filter(({ match }) => match && stampTime(match[4]) >= since.getTime())
    .map(({ name, match }) => ({
      backup: join(snapshots, name),
      database: join(dirname(snapshots), match[1] + '.sqlite'),
      from: Number(match[2]),
      to: Number(match[3]),
      at: match[4],
    }));
}

/**
 * roots（数据目录、配置目录）下所有 snapshots/ 目录里、since 以后做的配置库升级前备份，按路径排好。
 * 不存在的目录当作没有；别的读不了的情况抛错（查不清就不能当作没有）。
 */
export function configUpgradeBackups(roots, since) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === SNAPSHOT_DIRECTORY) found.push(...backupsIn(path, since));
      else visit(path);
    }
  };
  for (const root of roots) {
    if (!root) throw new Error('定不下配置目录（erp.env 没写 ERP_CONFIG_DIR，也查不到服务账号的家目录）');
    visit(root);
  }
  return found.sort((a, b) => (a.backup < b.backup ? -1 : a.backup > b.backup ? 1 : 0));
}

/** 以服务账号只读读一个库文件的 user_version，输出一行 JSON（文件不在输出 null）。 */
export const versionProbe = [
  "const{DatabaseSync}=require('node:sqlite');const{existsSync}=require('node:fs');const p=process.argv[1];",
  "if(!existsSync(p)){console.log('null');process.exit(0)}",
  'const db=new DatabaseSync(p,{readOnly:true});',
  "try{console.log(JSON.stringify(db.prepare('PRAGMA user_version').get().user_version))}finally{db.close()}",
].join('');
export function parseVersion(stdout) {
  try {
    const value = JSON.parse(String(stdout || '').trim().split('\n').at(-1));
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 找到的备份里，对应的库现在正是升级后的版本（真升级过、还没换回）的那些，每个库取最新一份备份。
 * 升级失败退回的库还是旧版本、已经换回的库也是旧版本，都不算。readVersion 读不出来就抛错（查不清就转人工）。
 */
function stillUpgraded(backups, readVersion) {
  return newestPerDatabase(backups).filter((found) => {
    const version = readVersion(found.database);
    if (version === null) throw new Error(`读不出 ${found.database} 的版本，查不清它升级过没有`);
    return version === found.to;
  });
}
/** 每个库只取最新一份备份 */
function newestPerDatabase(backups) {
  const newest = new Map();
  for (const found of backups) {
    const seen = newest.get(found.database);
    if (!seen || found.at > seen.at) newest.set(found.database, found);
  }
  return [...newest.values()];
}

/**
 * 换回命令失败以后，查还要人工换回哪些库。读不出某个库的版本时不能当作“没有要换的”：
 * 列出补丁开始以后的全部升级前备份（每个库最新一份），标明不确定，让人逐个确认后再换。
 */
function pendingAfterFailedCommand(io, since) {
  const backups = configUpgradeBackups(io.roots, since);
  try {
    return { pending: stillUpgraded(backups, io.readVersion), uncertain: false, lines: [] };
  } catch (error) {
    return {
      pending: newestPerDatabase(backups),
      uncertain: true,
      lines: [`${error.message}；下面这些不确定是否已经换回，逐个确认后再换。`],
    };
  }
}

/**
 * 换回配置库这一步。旧程序有换回命令就用它（revert() 以服务账号跑，返回退出码）；
 * 没有就看补丁开始以后有没有配置库真升级过：没有不用换，有就转人工。
 * 返回 { ok, lines, pending（还要人工换回的）, commandRan（换回命令跑过）, uncertain（pending 里的不确定要不要换）,
 * unknown（查不清还有哪些要换） }。
 */
export function configRevertStep(ctx, io) {
  const since = new Date(ctx.startedAt);
  if (hasRevertCommand(io.readErpSh())) {
    if (io.revert() === 0) return { ok: true, lines: ['配置库已由换回来的旧程序检查过，需要换回的已换回（见上面的输出）。'] };
    // 命令已经跑过、失败了：后面查还要换回哪些库时再出错，也要留住“命令跑过、失败了”这一句
    const failed = { ok: false, commandRan: true, lines: ['换回配置库失败（原因见上面的输出）。'], pending: [] };
    try {
      const found = pendingAfterFailedCommand(io, since);
      return { ...failed, ...found, lines: [...failed.lines, ...found.lines] };
    } catch (error) {
      return { ...failed, unknown: true, lines: [...failed.lines, `再查还要换回哪些库时出错（${error.message}），下面列不出具体的库。`] };
    }
  }
  const upgraded = stillUpgraded(configUpgradeBackups(io.roots, since), io.readVersion);
  if (!upgraded.length)
    return { ok: true, lines: ['换回来的旧程序没有换回配置库的命令；补丁开始以后没有配置库升级到新版本，不用换回。'] };
  return {
    ok: false,
    commandRan: false,
    lines: [
      '换回来的旧程序没有换回配置库的命令，而补丁开始以后这些配置库升级过，旧程序打不开它们：',
      ...upgraded.map((found) => `  ${found.database}（第 ${found.from} 版升到第 ${found.to} 版，升级前备份 ${found.backup}）`),
    ],
    pending: upgraded,
  };
}

/** 手动换回一个配置库：现在的库连同 -wal、-shm、-journal 改名留在 snapshots/ 里（不删），再把升级前备份复制回去 */
function manualRevertLines({ backup, database }, at) {
  const kept = join(dirname(backup), `${basename(database, '.sqlite')}-before-revert-manual-${at}.sqlite`);
  return [
    `     ${database}：`,
    `       sudo -u ${serviceUser} sh -c 'for s in "" -wal -shm -journal; do [ ! -e "${database}$s" ] || mv "${database}$s" "${kept}$s"; done'`,
    `       sudo -u ${serviceUser} cp -p ${backup} ${database}`,
  ];
}

/** 换完配置库以后业务库怎么办：按 rollbackPlan 的结论，从第 3 步接着编号 */
function businessSteps(ctx, plan) {
  if (plan.action === 'files-only') return ['  业务库没变（数据库结构版本没有变化），换完配置库直接启动：', ...startSteps(ctx, 3)];
  return [`  业务库变了或判断不了（${plan.reason}），换完配置库接着做下面的恢复：`, ...restoreSteps(ctx, 3), RESTORE_NOTE];
}

/** 配置库自动换不回时给人看的手动步骤：先换回还没换回的配置库，再按业务库的结论启动或恢复 */
export function configManualSteps(ctx, { pending, commandRan, uncertain, unknown }, plan) {
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  const how =
    '（先把现在的库和旁边的 -wal、-shm、-journal 一起改名留在 snapshots 目录里，不要删；再把补丁前的升级前备份复制回去，库文件旁边不能再留 -wal、-shm、-journal）';
  const revert = pending.length
    ? [
        uncertain
          ? `  2. 下面这些不确定是否已经换回：逐个确认库现在的版本（是“升到第几版”的那一版才要换），要换的照这样换${how}：`
          : `  2. 逐个换回下面的配置库${how}：`,
        ...pending.flatMap((found) => manualRevertLines(found, at)),
      ]
    : [
        unknown
          ? '  2. 查不清还有哪些配置库要换回，按上面的输出逐个处理，或联系维护人员。'
          : `  2. 没有找到还要换回的配置库的升级前备份（补丁开始 ${ctx.startedAt} 以后的），按上面的输出处理，或联系维护人员。`,
      ];
  return [
    STOPPED,
    stopStep,
    ...(commandRan ? ['     已经换回的库看上面的输出，下面只列还没换回的。'] : []),
    ...revert,
    ...businessSteps(ctx, plan),
    '换回以后，新程序运行期间对账号、提示词、AI 设置等的改动留在改名留下的那份里，需要时人工核对补录；所有人要重新登录。',
  ];
}

/**
 * 回滚时，旧文件已经换回、服务已经停下以后的数据步骤：先换回配置库，再按业务库的结构版本决定要不要恢复。
 * io：readErpSh()（读换回来的 erp.sh）、roots（数据目录、配置目录）、revert()、readVersion(库文件)、
 * readSchema()、restoreDatabase(reason) → 成不成、warn(...lines)。
 * 返回能不能启动旧程序；不能时说明和手动步骤已经由 warn 给出，服务保持停止。
 */
export function rollbackData(ctx, io) {
  let config;
  try {
    config = configRevertStep(ctx, io);
  } catch (error) {
    config = { ok: false, commandRan: false, pending: [], lines: ['查配置库要不要换回时出错：' + error.message] };
  }
  io.warn(...config.lines);
  // 配置库没换成也只读看一眼业务库，手动步骤里写明业务库要不要恢复
  const plan = rollbackPlan({ before: ctx.schemaBefore, after: io.readSchema(), backupDir: ctx.backupDir });
  if (!config.ok) {
    io.warn(...configManualSteps(ctx, config, plan));
    return false;
  }
  if (plan.action === 'manual') {
    io.warn(`已换回旧文件，但${plan.reason}，旧程序不能直接用这份数据库。`, ...manualSteps(ctx));
    return false;
  }
  if (plan.action === 'restore-db' && !io.restoreDatabase(plan.reason)) {
    io.warn('恢复数据库失败。', ...manualSteps(ctx));
    return false;
  }
  return true;
}
