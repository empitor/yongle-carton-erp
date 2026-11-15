// 在服务器上应用 scripts/patch-server.mjs 生成的补丁。由 patch-server 上传后以 root 运行：
//   sudo /opt/yongle-carton-erp/runtime/node/bin/node apply-patch.mjs 补丁.json.gz
// 顺序：校验补丁 → 核对服务器文件仍是比对时的样子 → 记下数据库结构版本 → 备份业务数据 → 保存回滚副本 →
// 停服务 → 替换文件 → 启动 → 检查健康和版本。启动不起来就自动换回旧文件再启动；
// 新版本已经升级了数据库时，先用补丁前的完整备份恢复数据库再启动旧程序，旧程序不会跑在新库上。
// SSH 断开不会打断补丁：忽略 SIGHUP，终端写不出去也继续执行，全过程记在回滚副本目录的 apply.log。
// 同一时间只允许一个补丁在跑（/run 下的锁文件）。
// 只用 Node 自带模块，只改程序目录，不碰 data/、backups/ 和配置；
// 唯一例外是回滚时以服务账号调用程序自带的 erp.sh restore 恢复补丁前的备份。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, chownSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const app = '/opt/yongle-carton-erp';
export const service = 'yongle-carton-erp';
export const serviceUser = 'yongle-erp';
export const historyRoot = '/var/backups/yongle-carton-erp-patches';
// /run 是内存盘，重启后自动清空，机器重启不会留下卡住的锁。
export const lockPath = '/run/yongle-carton-erp-patch.lock';
const envFile = '/etc/yongle-carton-erp/erp.env';

// ---------- 纯逻辑，单独导出给测试 ----------

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

const latest = (schema) => (schema?.versions?.length ? schema.versions.at(-1) : null);

/**
 * 回滚时怎么处理数据库。before/after 是 { exists, versions } 或 null（读不出来）。
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

/** 自动处理不了时给人看的手动步骤。 */
export function manualSteps({ backupDir, backupRoot, port }) {
  const restore = `sudo -u ${serviceUser} ${app}/scripts/linux/erp.sh restore`;
  return [
    '服务保持停止，不要直接启动旧程序。请按顺序手动处理：',
    `  1. sudo systemctl stop ${service}`,
    backupDir
      ? `  2. ${restore} ${backupDir}`
      : `  2. sudo sh -c 'ls -dt ${backupRoot}/full-* | head' 找到打补丁之前最近的一份完整备份，然后：${restore} 那个目录`,
    `  3. sudo systemctl start ${service}`,
    `  4. curl -fsS http://127.0.0.1:${port}/api/health`,
    '恢复会先把现在的数据目录另存为 data.before-restore-时间，新版本运行期间写入的数据在那份副本里，需要时人工核对补录。',
  ];
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

/** 独占锁：拿到返回释放函数；另一个补丁正在跑就抛错。持有进程已经不在的锁视为中断遗留，清掉重拿。 */
export function acquireLock(path, info = {}, isAlive = processAlive) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
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

// ---------- 输出和日志 ----------

let logFile = null;
let consoleOk = true;
const pending = [];
function emit(stream, text) {
  if (logFile) {
    try {
      appendFileSync(logFile, text);
    } catch {
      // 日志写不进去也不能打断补丁：终端上照样输出
    }
  } else pending.push(text);
  if (!consoleOk) return;
  try {
    stream.write(text);
  } catch {
    consoleOk = false;
  }
}
const say = (...lines) => emit(process.stdout, lines.join('\n') + '\n');
const warn = (...lines) => emit(process.stderr, lines.join('\n') + '\n');
function openLog(file) {
  logFile = file;
  try {
    appendFileSync(file, pending.join(''), { mode: 0o600 });
  } catch {
    // 同上：开头几行补不进日志也继续，终端上已经输出过
  }
  pending.length = 0;
}
const fail = (message) => {
  warn('补丁未应用：' + message);
  process.exit(1);
};

// 子进程放进新会话（setsid），终端挂断时收不到 SIGHUP；输出经由本进程写日志，不直接碰终端。
const hasSetsid = existsSync('/usr/bin/setsid');
function exec(cmd, args) {
  const [c, a] = hasSetsid ? ['/usr/bin/setsid', ['--wait', cmd, ...args]] : [cmd, args];
  return spawnSync(c, a, {
    cwd: app,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
function run(cmd, args) {
  const r = exec(cmd, args);
  if (r.stdout?.trim()) say(r.stdout.trimEnd());
  if (r.stderr?.trim()) warn(r.stderr.trimEnd());
  if (r.error) warn(`${cmd} 没有运行起来：${r.error.message}`);
  return r;
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- 主流程 ----------

// SSH 断开时终端发 SIGHUP；Ctrl+C 发 SIGINT。补丁中途停下会留下停着的服务或半套文件，所以都不中断。
// 本脚本全程同步执行，处理函数要等结束才会被调用，这里只是阻止默认的“直接退出”。
function keepRunningWhenDetached() {
  process.on('SIGHUP', () => {});
  process.on('SIGINT', () => {});
  // 终端没了或管道断了，写输出会出错；吞掉错误继续执行，日志文件里仍有全部输出。
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => (consoleOk = false));
}

function readPatch() {
  if (process.getuid?.() !== 0) fail('需要 root（sudo）运行。');
  const patchPath = process.argv[2];
  if (!patchPath || !existsSync(patchPath)) fail('找不到补丁文件。');
  let patch;
  try {
    patch = JSON.parse(gunzipSync(readFileSync(patchPath)).toString('utf8'));
  } catch {
    fail('补丁文件读不出来，可能没有上传完整。');
  }
  if (patch.format !== 'yongle-erp-patch/1' || !/^[0-9T]+-[0-9a-f]{8}$/.test(patch.id)) fail('补丁格式不对。');
  return { patch, patchPath };
}
/** 建回滚副本目录、开日志、拿补丁锁，返回回滚副本目录。 */
function startHistory(patch) {
  const history = join(historyRoot, patch.id);
  mkdirSync(history, { recursive: true, mode: 0o700 });
  openLog(join(history, 'apply.log'));
  say(`\n==== ${new Date().toISOString()} 开始应用补丁 ${patch.id}（进程 ${process.pid}）`);
  say(`全过程记在 ${logFile}。SSH 断开不会打断补丁，重新连上后用 sudo tail -n 40 ${logFile} 查看结果。`);
  let releaseLock;
  try {
    releaseLock = acquireLock(lockPath, { patch: patch.id, startedAt: new Date().toISOString() });
  } catch (error) {
    fail(error.message);
  }
  process.on('exit', () => releaseLock?.());
  return history;
}

const markerFile = join(app, '.release-package');
const target = (path) => patchTarget(path) ?? fail('补丁包含不允许的路径：' + path);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const current = (path) => (existsSync(target(path)) ? sha(readFileSync(target(path))) : null);

/** 补丁对得上服务器装的版本、内容没损坏、服务器文件仍是比对时的样子。 */
function checkPatchFiles(patch) {
  const installed = JSON.parse(readFileSync(markerFile, 'utf8')).version;
  if (patch.fromVersion && installed !== patch.fromVersion && installed !== patch.version)
    fail(`这个补丁用于把 ${patch.fromVersion} 升级到 ${patch.version}，服务器当前是 ${installed}。`);
  say(`补丁 ${patch.id}：${installed} → ${patch.version}，${patch.files.length} 个文件写入，${patch.deleted.length} 个删除。`);
  for (const f of patch.files) {
    if (sha(Buffer.from(f.data, 'base64')) !== f.sha256) fail('补丁内容损坏：' + f.path);
    if (current(f.path) !== f.before) fail('服务器上的文件在比对之后被改过：' + f.path + '。请重新运行补丁脚本。');
  }
  for (const f of patch.deleted) if (current(f.path) !== f.before) fail('服务器上的文件在比对之后被改过：' + f.path);
}
function serverPaths() {
  const env = parseEnv(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '');
  // erp.sh 在程序目录里启动，相对路径按程序目录解析。
  return {
    port: env.PORT || '3001',
    dbPath: resolve(app, env.DB_PATH || 'data/erp.sqlite'),
    backupRoot: resolve(app, env.ERP_BACKUP_DIR || 'backups'),
    erpSh: join(app, 'scripts/linux/erp.sh'),
  };
}

// 以服务账号读：root 读 WAL 库可能新建 root 所有的 -shm/-wal，服务就打不开库了。
function readSchema(dbPath) {
  const r = exec('runuser', ['-u', serviceUser, '--', process.execPath, '--no-warnings', '-e', schemaProbe, dbPath]);
  const schema = r.status === 0 ? parseSchema(r.stdout) : null;
  if (!schema) warn('读取数据库结构版本失败：' + ((r.stderr || r.error?.message || r.stdout || '').trim() || '没有输出'));
  return schema;
}
function recordSchema(dbPath) {
  say('\n== 记下数据库结构版本');
  const schemaBefore = readSchema(dbPath);
  if (!schemaBefore) fail('读不出业务数据库的结构版本，没有改动任何文件。回滚时要靠它判断数据库是否被新版本升级过。');
  say(schemaBefore.exists ? `数据库结构版本：第 ${latest(schemaBefore)} 版（${dbPath}）` : '还没有业务数据库：' + dbPath);
  return schemaBefore;
}
function fullBackups(backupRoot) {
  try {
    return new Set(readdirSync(backupRoot).filter((n) => /^full-/.test(n) && !n.endsWith('.partial')));
  } catch {
    return new Set();
  }
}

/** 补丁前做一份完整备份，返回备份目录。 */
function backupBusinessData({ backupRoot, erpSh }, schemaBefore) {
  say('\n== 备份业务数据（服务照常运行，可能要几十秒）');
  const earlier = fullBackups(backupRoot);
  const backupRun = run('runuser', ['-u', serviceUser, '--', erpSh, 'backup']);
  if (backupRun.status !== 0) {
    if (/不支持此数据库版本/.test((backupRun.stdout || '') + (backupRun.stderr || '')))
      warn(
        `数据库是第 ${latest(schemaBefore)} 版，比服务器上装的程序新（多半是以前某次补丁失败回滚时只换回了程序文件）。`,
        '旧程序备份不了这份库，补丁也就不能安全地打。先按部署文档用升级前的完整备份恢复数据库，或联系维护人员。',
      );
    fail('业务数据备份失败，没有改动任何文件。');
  }
  const fresh = [...fullBackups(backupRoot)].filter((n) => !earlier.has(n)).sort();
  const backupDir = [parseBackupDir(backupRun.stdout), fresh.length === 1 ? join(backupRoot, fresh[0]) : null]
    .find((dir) => dir && existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'erp.sqlite')));
  if (!backupDir) fail('备份命令成功了，但找不到它生成的备份目录，没有改动任何文件。回滚时要用这份备份恢复数据库。');
  say('补丁前完整备份：' + backupDir);
  return backupDir;
}

/** 记下要改的文件的原样和标记文件，返回 { saved, oldMarker } 给回滚用。 */
function saveRollbackCopy({ patch, patchPath, history, backupDir, schemaBefore }) {
  say('\n== 保存回滚副本');
  const saved = [];
  for (const path of [...patch.files.map((f) => f.path), ...patch.deleted.map((f) => f.path)]) {
    const file = target(path);
    saved.push(existsSync(file)
      ? { path, data: readFileSync(file).toString('base64'), mode: statSync(file).mode & 0o777 }
      : { path, data: null });
  }
  const oldMarker = readFileSync(markerFile, 'utf8');
  const copy = JSON.stringify({ marker: oldMarker, backupDir, schemaBefore, files: saved });
  writeFileSync(join(history, 'rollback.json'), copy, { mode: 0o600 });
  writeFileSync(join(history, 'patch.json.gz'), readFileSync(patchPath), { mode: 0o600 });
  say('回滚副本：' + history);
  return { saved, oldMarker };
}

function writeProgramFile(path, data, mode) {
  const file = target(path);
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chownSync(dir, 0, 0);
  }
  const temp = file + '.patch-tmp';
  writeFileSync(temp, data);
  chownSync(temp, 0, 0);
  chmodSync(temp, mode);
  renameSync(temp, file);
}

function health(port) {
  // 最多约 90 秒：30 次，每次最多等 2 秒再歇 1 秒。
  for (let i = 0; i < 30; i++) {
    const r = exec('curl', ['-fsS', '--max-time', '2', `http://127.0.0.1:${port}/api/health`]);
    if (r.status === 0) {
      try {
        return JSON.parse(r.stdout);
      } catch {
        // 服务刚起来、回的还不是完整 JSON：歇一下再查
      }
    }
    sleep(1000);
  }
  return null;
}

/** 回滚：换回旧文件；新版本升级过数据库就先用补丁前的备份恢复，再启动旧程序。总是以失败退出。 */
function rollback(ctx, reason) {
  warn('\n== 回滚：' + reason);
  const stopped = run('systemctl', ['stop', service]).status === 0;
  try {
    for (const f of ctx.saved) {
      if (f.data === null) rmSync(target(f.path), { force: true });
      else writeProgramFile(f.path, Buffer.from(f.data, 'base64'), f.mode);
    }
    writeFileSync(markerFile, ctx.oldMarker);
  } catch (error) {
    warn('换回旧文件出错：' + error.message, `回滚副本在 ${ctx.history}/rollback.json，服务保持停止，请联系维护人员。`);
    process.exit(1);
  }
  if (!stopped) {
    warn('已换回旧文件，但停止服务失败，确认不了新版本已经停下，所以不动数据库，也不启动旧程序。', ...manualSteps(ctx));
    process.exit(1);
  }
  const plan = rollbackPlan({ before: ctx.schemaBefore, after: readSchema(ctx.dbPath), backupDir: ctx.backupDir });
  if (plan.action === 'manual') {
    warn(`已换回旧文件，但${plan.reason}，旧程序不能直接用这份数据库。`, ...manualSteps(ctx));
    process.exit(1);
  }
  if (plan.action === 'restore-db') restoreDatabase(ctx, plan.reason);
  run('systemctl', ['start', service]);
  warn(health(ctx.port) ? '已换回旧文件，服务已恢复。' : '已换回旧文件，但服务没有起来，请查看 journalctl -u ' + service);
  process.exit(1);
}

function restoreDatabase(ctx, reason) {
  warn(`${reason}，旧程序不支持升级后的数据库。用补丁前的完整备份恢复：${ctx.backupDir}`);
  const restored = run('runuser', ['-u', serviceUser, '--', ctx.erpSh, 'restore', ctx.backupDir]);
  if (restored.status !== 0) {
    warn('恢复数据库失败。', ...manualSteps(ctx));
    process.exit(1);
  }
  const previous = /恢复前的数据保留在：(.+)/.exec(restored.stdout || '')?.[1]?.trim();
  const kept = previous ? `原样保留在 ${previous}` : '原样保留在数据目录旁的 data.before-restore-时间 副本里';
  warn(`数据库已恢复到打补丁前备份时的状态。备份之后到停服务之间、以及新版本运行期间的写入已被丢弃，${kept}，需要时人工核对补录。恢复后所有人要重新登录。`);
}

/** 标记文件记下这次补丁：当前程序对应的提交和是否正式发布，patch-server --check 据此核对三方一致。 */
function patchedMarker(oldMarker, patch) {
  const marker = JSON.parse(oldMarker);
  const released = patch.released ?? !patch.dirty;
  marker.version = patch.version;
  marker.commit = patch.baseCommit;
  marker.released = released;
  const { id, baseCommit, dirty, hotfix } = patch;
  const entry = { id, appliedAt: new Date().toISOString(), baseCommit, dirty, released, ...(hotfix ? { hotfix } : {}) };
  marker.patches = [...(marker.patches || []), { ...entry, written: patch.files.length, deleted: patch.deleted.length }];
  return marker;
}

function replaceFiles(ctx) {
  const { patch } = ctx;
  say('\n== 停止服务并替换文件');
  if (run('systemctl', ['stop', service]).status !== 0)
    fail('停止服务失败，没有改动任何文件。请用 systemctl status ' + service + ' 确认服务状态。');
  try {
    for (const f of patch.files) {
      const file = target(f.path);
      const mode = existsSync(file) ? statSync(file).mode & 0o777 : /\.sh$/.test(f.path) ? 0o755 : 0o644;
      writeProgramFile(f.path, Buffer.from(f.data, 'base64'), mode);
    }
    for (const f of patch.deleted) rmSync(target(f.path), { force: true });
    writeFileSync(markerFile, JSON.stringify(patchedMarker(ctx.oldMarker, patch), null, 2) + '\n');
  } catch (error) {
    rollback(ctx, '替换文件出错：' + error.message);
  }
}

function startAndCheck(ctx) {
  const { patch } = ctx;
  say('\n== 启动并检查');
  let state;
  try {
    if (run('systemctl', ['start', service]).status !== 0) rollback(ctx, '服务启动失败');
    state = health(ctx.port);
  } catch (error) {
    rollback(ctx, '启动检查出错：' + error.message);
  }
  if (!state) rollback(ctx, '启动后 90 秒内健康检查没有通过');
  if (state.version !== patch.version) rollback(ctx, `健康检查版本是 ${state.version}，应为 ${patch.version}`);
  rmSync(ctx.patchPath, { force: true });
  say(`\n补丁已应用：版本 ${state.version}，进程 ${state.processId}。回滚副本留在 ${ctx.history}。`);
  if (patch.hotfix) say(`这是临时修复（${patch.hotfix}），已标记为未发布，事后要补发正式版本。`);
}

function main() {
  keepRunningWhenDetached();
  const { patch, patchPath } = readPatch();
  const history = startHistory(patch);
  checkPatchFiles(patch);
  const paths = serverPaths();
  const schemaBefore = recordSchema(paths.dbPath);
  const backupDir = backupBusinessData(paths, schemaBefore);
  const base = { patch, patchPath, history, ...paths, schemaBefore, backupDir };
  const ctx = { ...base, ...saveRollbackCopy(base) };
  replaceFiles(ctx);
  startAndCheck(ctx);
}

const isMain = (() => {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) main();
