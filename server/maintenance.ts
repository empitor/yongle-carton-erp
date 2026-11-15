import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorMessage } from '../shared/core/index.js';
import {
  AuthManager,
  acquireLock,
  backupDirectory,
  createFullBackup,
  defaultAccountPath,
  defaultDbPath,
  restoreFullBackup,
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

/** 整个备份目录：各库都校验过才换上 */
async function restoreDirectory(source: string) {
  // 恢复前要校验备份里的每个配置库当前程序打不打得开，靠各库的主人模块加载时登记的“哪个位置是哪个库、支持到第几版”。
  // 基础、AI 接入、消息接入的上面已经引入；助手工具设置、AI 识别工作区的主人只有这里用到，这时才加载
  await Promise.all([import('./assistant/index.js'), import('./import/index.js')]);
  unlock = acquireLock(defaultDbPath);
  const result = restoreFullBackup(source, dirname(defaultDbPath), { extraFiles: backupExtraFiles() });
  console.log(
    '已恢复' +
      result.files +
      '个文件并通过校验。\n恢复前的数据保留在：' +
      result.previous +
      '\n本机AI配置不会自动覆盖，备份内的副本在 _extra 目录。',
  );
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
  else throw new Error('仅支持 backup / restore / reset-password');
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  unlock?.();
}
