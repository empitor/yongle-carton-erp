import { DatabaseSync, backup } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDbPath } from './db.js';
import { acquireLock } from './lock.js';
import { AuthManager } from './auth.js';
import { defaultAiSettingsPath } from './ai/credential-store.js';
import { defaultWecomBotPath } from './inbox/wecom-bot-settings.js';
import {
  createFullBackup,
  restoreFullBackup,
  supportedDatabaseVersions,
  validateBusinessDatabase,
} from './backup.js';

const validate = (path: string) => validateBusinessDatabase(path, supportedDatabaseVersions);
const stamp = () =>
  new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') +
  '-' +
  randomUUID().slice(0, 6);
const action = process.argv[2];
let unlock: (() => void) | undefined;
try {
  if (action === 'backup') {
    if (!existsSync(defaultDbPath)) throw new Error('数据库尚未创建，请先启动服务或导入示例。');
    const result = await createFullBackup({
      dataDir: dirname(defaultDbPath),
      backupRoot: resolve('backups'),
      extraFiles: {
        'ai-settings.sqlite': defaultAiSettingsPath(),
        'wecom-bot.sqlite': defaultWecomBotPath(),
      },
    });
    console.log(
      '完整备份已生成：' +
        result.dir +
        '\n共' +
        result.files +
        '个文件，含业务库、账号、AI工作区与原件、提示词和本机AI配置。\n请另存一份到其他磁盘。',
    );
  } else if (action === 'backup-db') {
    if (!existsSync(defaultDbPath)) throw new Error('数据库尚未创建，请先启动服务或导入示例。');
    const file = resolve('backups', `erp-${stamp()}.sqlite`);
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(defaultDbPath, { readOnly: true });
    try {
      await backup(db, file);
    } finally {
      db.close();
    }
    validate(file);
    console.log('业务库一致性备份已生成：' + file + '\n请另存一份到其他磁盘。');
  } else if (action === 'restore') {
    if (!process.argv[3]) throw new Error('用法：npm run restore -- "备份目录或文件绝对路径"');
    const source = resolve(process.argv[3]);
    if (source === defaultDbPath) throw new Error('备份路径不能与当前数据库相同');
    if (statSync(source).isDirectory()) {
      unlock = acquireLock(defaultDbPath);
      const result = restoreFullBackup(source, dirname(defaultDbPath));
      console.log(
        '已恢复' +
          result.files +
          '个文件并通过校验。\n恢复前的数据保留在：' +
          result.previous +
          '\n本机AI配置不会自动覆盖，备份内的副本在 _extra 目录。',
      );
    } else {
      validate(source);
      unlock = acquireLock(defaultDbPath);
      const staged = defaultDbPath + '.restore-' + stamp();
      copyFileSync(source, staged);
      validate(staged);
      let previous: string | undefined;
      if (existsSync(defaultDbPath)) {
        const db = new DatabaseSync(defaultDbPath);
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          db.close();
        }
        previous = defaultDbPath + '.before-restore-' + stamp();
        renameSync(defaultDbPath, previous);
      }
      try {
        renameSync(staged, defaultDbPath);
      } catch (error) {
        if (previous) renameSync(previous, defaultDbPath);
        throw error;
      }
      for (const suffix of ['-wal', '-shm'])
        if (existsSync(defaultDbPath + suffix)) unlinkSync(defaultDbPath + suffix);
      console.log('已恢复并通过完整性检查。' + (previous ? '\n恢复前文件保留在：' + previous : ''));
    }
  } else if (action === 'reset-password') {
    const name = process.argv[3];
    if (!name) throw new Error('用法：npm run reset-password -- "用户名"');
    const auth = new AuthManager(join(dirname(defaultDbPath), 'security', 'users.sqlite'));
    try {
      const password = auth.resetPassword(name);
      console.log('临时密码（只显示这一次，24 小时内有效）：' + password + '\n登录后必须先改密码才能使用系统。');
    } finally {
      auth.close();
    }
  } else throw new Error('仅支持 backup / backup-db / restore / reset-password');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  unlock?.();
}
