// apply-patch.mjs 的纯逻辑部分：路径和设置的解析、补丁锁、回滚时业务库怎么处理（换回配置库在 patch-rollback.mjs）。
// 只用 Node 自带模块，不引 server 代码（补丁脚本和它一起上传到服务器、单独运行）。测试直接导入这个文件。
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { posix } from 'node:path';

export const app = '/opt/yongle-carton-erp';
export const service = 'yongle-carton-erp';
export const serviceUser = 'yongle-erp';
export const historyRoot = '/var/backups/yongle-carton-erp-patches';
// /run 是内存盘，重启后自动清空，机器重启不会留下卡住的锁。
export const lockPath = '/run/yongle-carton-erp-patch.lock';

// 值去掉两头空白后中间不能再有换行（\r 和 Unicode 的行、段分隔符），这样的行不算设置
const ENV_LINE = /^\s*([A-Z_]+)\s*=([\s\S]*)$/;
const LINE_BREAK = /[\n\r\p{Zl}\p{Zp}]/u;
export function parseEnv(text) {
  return Object.fromEntries(
    String(text || '')
      .split('\n')
      .map((l) => ENV_LINE.exec(l))
      .filter((m) => m && !LINE_BREAK.test(m[2].trim()))
      .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, '')]),
  );
}

/**
 * 服务的配置目录，照程序里 configDirectory（server/core/backup/config-paths.ts）的 Linux 规则另写一份（补丁脚本不引 server 代码，
 * tests/patch-rollback.test.ts 拿同样的输入比两边的结果）：ERP_CONFIG_DIR，否则 XDG_CONFIG_HOME/zhixu-erp，
 * 否则服务账号家目录下的 .config/zhixu-erp（家目录从 /etc/passwd 读，查不到返回 null）。不是绝对路径的和程序一样拒绝。
 */
export function configDirOf(env, passwdText) {
  if (env.ERP_CONFIG_DIR) {
    if (!posix.isAbsolute(env.ERP_CONFIG_DIR)) throw new Error('ERP_CONFIG_DIR 必须是绝对路径。');
    return posix.normalize(env.ERP_CONFIG_DIR);
  }
  if (env.XDG_CONFIG_HOME && !posix.isAbsolute(env.XDG_CONFIG_HOME)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径。');
  if (env.XDG_CONFIG_HOME) return posix.join(env.XDG_CONFIG_HOME, 'zhixu-erp');
  const home = String(passwdText || '')
    .split('\n')
    .map((line) => line.split(':'))
    .find((fields) => fields[0] === serviceUser)?.[5];
  return home ? posix.join(home, '.config', 'zhixu-erp') : null;
}

/** 只允许程序目录里的相对路径，补丁里的路径不能跳出去，也不能碰数据和运行时。返回 null 表示不允许。 */
export function patchTarget(path) {
  const p = posix.normalize(String(path));
  if (p.startsWith('/') || p.startsWith('..') || /^(data|backups|runtime|node_modules)(\/|$)/.test(p) || p === '.release-package')
    return null;
  return posix.join(app, p);
}

/** 从 erp.sh backup 的输出里取出备份目录（maintenance.ts 打印“完整备份已生成：目录”）。 */
export function parseBackupDir(output) {
  const m = /完整备份已生成：(.+)/.exec(String(output || ''));
  return m ? m[1].trim() : null;
}

export const latest = (schema) => (schema?.versions?.length ? schema.versions.at(-1) : null);

/**
 * 回滚时怎么处理业务库。before/after 是 { exists, versions } 或 null（读不出来）。
 * - files-only：结构版本没变，只换回程序文件；
 * - restore-db：新版本升级了数据库，用补丁前的完整备份恢复后再启动旧程序；
 * - manual：判断不了或没有可用备份，旧程序不能启动，打印手动步骤。
 */
export function rollbackPlan({ before, after, backupDir }) {
  if (!after) return { action: 'manual', reason: '回滚时读不出数据库的结构版本' };
  if (before && after.exists === before.exists && JSON.stringify(after.versions) === JSON.stringify(before.versions))
    return { action: 'files-only', reason: '数据库结构版本没有变化' };
  if (!before) return { action: 'manual', reason: '补丁前没有记下数据库的结构版本' };
  if (!after.exists) return { action: 'manual', reason: '回滚时找不到业务数据库' };
  const change = `数据库已从第 ${latest(before) ?? '无'} 版变成第 ${latest(after) ?? '无'} 版`;
  if (!backupDir) return { action: 'manual', reason: change + '，但没有找到补丁前的完整备份' };
  return { action: 'restore-db', reason: change };
}

export const STOPPED = '服务保持停止，不要直接启动旧程序。请按顺序手动处理：';
export const stopStep = `  1. sudo systemctl stop ${service}`;
export const RESTORE_NOTE =
  '恢复会先把现在的数据目录另存为 data.before-restore-时间，新版本运行期间写入的数据在那份副本里，需要时人工核对补录。';
/** 启动并查健康，从第 n 步编号 */
export const startSteps = ({ port }, n) => [
  `  ${n}. sudo systemctl start ${service}`,
  `  ${n + 1}. curl -fsS http://127.0.0.1:${port}/api/health`,
];
/** 用补丁前的完整备份恢复业务库，再启动，从第 n 步编号 */
export function restoreSteps(ctx, n) {
  const restore = `sudo -u ${serviceUser} ${app}/scripts/linux/erp.sh restore`;
  return [
    ctx.backupDir
      ? `  ${n}. ${restore} ${ctx.backupDir}`
      : `  ${n}. sudo sh -c 'ls -dt ${ctx.backupRoot}/full-* | head' 找到打补丁之前最近的一份完整备份，然后：${restore} 那个目录`,
    ...startSteps(ctx, n + 1),
  ];
}

/** 业务库自动处理不了时给人看的手动步骤。 */
export function manualSteps(ctx) {
  return [STOPPED, stopStep, ...restoreSteps(ctx, 2), RESTORE_NOTE];
}

/** 进程还在、而且确实是 apply-patch。读不了 /proc 时按“还在”处理，宁可让人手动删锁。 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('apply-patch');
  } catch {
    return true;
  }
}

/** 锁已经在了：持有者还活着（或刚建好还没写内容）就抛错，否则返回，由调用方清掉重拿 */
function refuseLiveHolder(path, isAlive) {
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 刚建好还没写进内容的锁也算有人持有。
    let fresh = false;
    try {
      fresh = Date.now() - statSync(path).mtimeMs < 30_000;
    } catch {
      // 锁文件刚被持有者删掉：不算新锁，下面清掉（已不存在）后重拿
    }
    if (fresh) throw new Error('另一个补丁正在应用，不要同时运行。等它结束后再试。');
  }
  if (holder && isAlive(holder.pid))
    throw new Error(
      `另一个补丁正在应用（进程 ${holder.pid}，补丁 ${holder.patch || '未知'}，开始于 ${holder.startedAt || '未知'}），不要同时运行。等它结束后再试。`,
    );
}

/** 独占锁：拿到返回释放函数；另一个补丁正在跑就抛错。持有进程已经不在的锁视为中断遗留，清掉重拿。 */
export function acquireLock(path, info = {}, isAlive = processAlive) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      refuseLiveHolder(path, isAlive);
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ...info }) + '\n');
    } finally {
      closeSync(fd);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) rmSync(path, { force: true });
      } catch {
        // 锁已不在或内容不是自己写的：没有要释放的，退出时不再报错
      }
    };
  }
  throw new Error('无法取得补丁锁：' + path);
}

/** 以服务账号读取业务库的结构版本；只读打开，输出一行 JSON。 */
export const schemaProbe = [
  "const{DatabaseSync}=require('node:sqlite');const{existsSync}=require('node:fs');const p=process.argv[1];",
  "if(!existsSync(p)){console.log(JSON.stringify({exists:false,versions:[]}));process.exit(0)}",
  'const db=new DatabaseSync(p,{readOnly:true});',
  "try{const t=db.prepare(\"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'\").get();",
  "const v=t?db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r)=>Number(r.version)):[];",
  'console.log(JSON.stringify({exists:true,versions:v}))}finally{db.close()}',
].join('');
export function parseSchema(stdout) {
  try {
    const value = JSON.parse(String(stdout || '').trim().split('\n').at(-1));
    return typeof value?.exists === 'boolean' && Array.isArray(value.versions) && value.versions.every(Number.isInteger)
      ? { exists: value.exists, versions: value.versions }
      : null;
  } catch {
    return null;
  }
}
