import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorMessage } from '../shared/core/index.js';
import { AuthManager, defaultAccountPath } from './accounts/index.js';
import {
  acquireLock,
  backupDirectory,
  createFullBackup,
  defaultDbPath,
  restoreFullBackup,
  revertConfigUpgrades,
  stamp,
  validateBusinessDatabase,
} from './core/index.js';
import { backupExtraFiles } from './backup-extras.js';

// 恢复前的校验：0.9.0 以前的备份、比程序新的备份、结构被改过的库都在这里拒绝，这时还没有动任何文件
const validate = (path: string) => validateBusinessDatabase(path);
const action = process.argv[2];
let unlock: (() => void) | undefined;

async function backup() {
  if (!existsSync(defaultDbPath)) throw new Error('数据库尚未创建，请先启动服务或导入示例。');
  const result = await createFullBackup({
    dataDir: dirname(defaultDbPath),
    backupRoot: backupDirectory(),
    extraFiles: backupExtraFiles(),
  });
  console.log(
    '完整备份已生成：' +
      result.dir +
      '\n共' +
      result.files +
      '个文件，含业务库、账号、AI工作区与原件、提示词和本机AI配置。' +
      (result.newerSchema
        ? `\n注意：数据库是第 ${result.schemaVersion} 版，比当前程序新，只能用支持该版本的程序恢复。`
        : '') +
      '\n请另存一份到其他磁盘。',
  );
}

/**
 * 恢复检查和换回都靠各配置库的主人模块加载时登记的“哪个位置是哪个库、支持到第几版”。
 * 基础、账号、AI 接入、消息接入的上面已经引入；助手工具设置、AI 识别工作区的主人只有这里用到，这时才加载
 */
async function loadConfigOwners() {
  await Promise.all([import('./assistant/index.js'), import('./import/index.js')]);
}

/** 整个备份目录：各库都校验过才换上 */
async function restoreDirectory(source: string) {
  await loadConfigOwners();
  unlock = acquireLock(defaultDbPath);
  const result = restoreFullBackup(source, dirname(defaultDbPath));
  console.log(
    '已恢复' +
      result.files +
      '个文件并通过校验。\n恢复前的数据保留在：' +
      result.previous +
      '\n本机AI配置不会自动覆盖，备份内的副本在 _extra 目录。' +
      (result.integrityOnly.length
        ? '\n只查了完整性的文件（认不出是哪个配置库，或是 _extra 里不恢复的本机配置）：\n  ' +
          result.integrityOnly.join('\n  ')
        : ''),
  );
}

/** 补丁开始时间：可以不给；给了必须是能读懂的时间 */
function revertSince(text: string | undefined) {
  if (!text) return undefined;
  const since = new Date(text);
  if (Number.isNaN(since.getTime())) throw new Error('时间写法不对：' + text + '（例：2026-11-21T10:00:00.000Z）');
  return since;
}

/**
 * 补丁回滚换回旧程序以后：比当前程序新的配置库，换回升级前那一份。给了时间只用这个时间以后做的升级前备份。
 * 有换不回的就以非零退出码结束（回滚脚本据此停住服务转人工）。
 */
async function revertConfigs() {
  const since = revertSince(process.argv[3]);
  await loadConfigOwners();
  unlock = acquireLock(defaultDbPath);
  const { reverted, failed } = revertConfigUpgrades(since);
  for (const done of reverted)
    console.log(
      `${done.label}已从第 ${done.from} 版换回第 ${done.to} 版：${done.file}\n  换进去的升级前备份：${done.backup}\n  换下来的文件留在：${done.keptAs}`,
    );
  if (!reverted.length && !failed.length) console.log('没有比当前程序新的配置库，不用换回。');
  if (reverted.some((done) => resolve(done.file) === resolve(defaultAccountPath()))) console.log('账号库换回以后没有登录会话，所有人要重新登录。');
  if (!failed.length) return;
  // file 是 null：这个库的默认位置算不出来（比如配置目录设错了），reason 已经写明了这一点和原因
  for (const failure of failed)
    console.error(
      failure.file === null
        ? `${failure.label}没有换回：${failure.reason}`
        : `${failure.label}没有换回：${failure.file}\n  原因：${failure.reason}`,
    );
  throw new Error(`有 ${failed.length} 个配置库没有换回，文件没有改动；请按上面的原因处理，或从各库旁边的 snapshots 目录手动换回。`);
}

/** 把现在的业务库写完日志后改名留下，返回留下的位置；没有业务库时返回 undefined */
function setAsideCurrent() {
  if (!existsSync(defaultDbPath)) return undefined;
  const db = new DatabaseSync(defaultDbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const previous = defaultDbPath + '.before-restore-' + stamp();
  renameSync(defaultDbPath, previous);
  return previous;
}

/** 暂存的副本换成业务库；换不上就把原来的放回去 */
function swapIn(staged: string) {
  const previous = setAsideCurrent();
  try {
    renameSync(staged, defaultDbPath);
  } catch (error) {
    if (previous) renameSync(previous, defaultDbPath);
    throw error;
  }
  return previous;
}

/**
 * 单个文件：完整备份里的业务库副本，或程序自动拍的快照（删除前、初始化前、升级前）。
 * 先看文件头再打开：WAL 模式的（直接复制出来的业务库）在这里就拒绝，文件所在目录和数据目录都不写任何东西
 */
function restoreFile(source: string) {
  validate(source);
  unlock = acquireLock(defaultDbPath);
  const staged = defaultDbPath + '.restore-' + stamp();
  let previous: string | undefined;
  try {
    copyFileSync(source, staged);
    validate(staged);
    previous = swapIn(staged);
  } finally {
    // 中途失败（复制、校验、改名出错）也不在数据目录里留下暂存文件
    if (existsSync(staged)) unlinkSync(staged);
  }
  // 换下来的旧库留下的 -wal、-shm 不能跟着新文件
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(defaultDbPath + suffix)) unlinkSync(defaultDbPath + suffix);
  console.log('已恢复并通过完整性检查。' + (previous ? '\n恢复前文件保留在：' + previous : ''));
}

async function restore() {
  if (!process.argv[3]) throw new Error('用法：npm run restore -- "备份目录或文件绝对路径"');
  const source = resolve(process.argv[3]);
  if (source === defaultDbPath) throw new Error('备份路径不能与当前数据库相同');
  if (statSync(source).isDirectory()) await restoreDirectory(source);
  else restoreFile(source);
}

function resetPassword() {
  const name = process.argv[3];
  if (!name) throw new Error('用法：npm run reset-password -- "用户名"');
  const auth = new AuthManager(defaultAccountPath());
  try {
    const password = auth.resetPassword(name);
    console.log('临时密码（只显示这一次，24 小时内有效）：' + password + '\n登录后必须先改密码才能使用系统。');
  } finally {
    auth.close();
  }
}

try {
  if (action === 'backup') await backup();
  else if (action === 'restore') await restore();
  else if (action === 'reset-password') resetPassword();
  else if (action === 'revert-config-upgrades') await revertConfigs();
  else throw new Error('仅支持 backup / restore / reset-password / revert-config-upgrades');
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  unlock?.();
}
