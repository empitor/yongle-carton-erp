import { masterKeyName } from './config-paths.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { APP_VERSION } from '../../../shared/core/index.js';
import { SCHEMA_LATEST, SNAPSHOT_DIRECTORY, stamp } from '../schema/index.js';
import { defaultDbPath } from '../storage/db.js';
import { one } from '../storage/sqlite/sql.js';
import { specAt, type VersionedSqliteSpec } from './versioned-sqlite-spec.js';
import { isDatabaseFile, refuseWalBackup, userVersionOf, validateBusinessDatabase, validateConfigDatabase } from './backup-check.js';
import { readBackupManifest, writeBackupManifest, type BackupFile } from './backup-manifest.js';

/* 完整备份和恢复：做备份（一致的副本加清单）、校验后恢复数据目录（失败自动退回）。库文件的校验在 backup-check.ts，每日自动备份在 backup-auto.ts。 */

const SNAPSHOT_DIR = SNAPSHOT_DIRECTORY;
/** 运行时文件不进入备份：WAL由一致性备份合并，锁和控制令牌只属于运行中的实例。 */
const isTransient = (name: string) =>
  name === masterKeyName || /(-wal|-shm|\.running|\.control)$/.test(name) || /\.(restore|before-restore)-/.test(name);

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function walk(dir: string, files: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== SNAPSHOT_DIR) walk(path, files);
    } else if (entry.isFile() && !isTransient(entry.name)) files.push(path);
  }
  return files;
}
/**
 * 复制一个 SQLite 文件（在线备份接口，拿到的是一致的副本），再把副本切成回滚日志模式（journal_mode=DELETE）。
 * 在线备份复制出来的文件头还是 WAL 模式，WAL 模式的文件哪怕用只读连接打开也会在旁边生成 -wal、-shm；
 * 切成回滚日志以后，备份就是一个个独立的文件，校验和恢复都不会往备份目录里写东西。恢复时不收 WAL 模式的副本（refuseWalBackup）。
 * 切换在算哈希之前做，清单里记的是切换以后的文件。程序打开恢复出来的业务库时会重新设成 WAL（schema/pragmas.ts）。
 */
async function copySqlite(from: string, to: string, scrubBackup?: VersionedSqliteSpec['scrubBackup']) {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(db, to);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(to);
  try {
    const mode = one(copy, journalMode, 'PRAGMA journal_mode=DELETE')?.journal_mode;
    if (mode !== 'delete') throw new Error(`备份副本没能整理成单个文件（日志模式还是 ${mode ?? '未知'}）：${to}`);
    scrubBackup?.(copy);
  } finally {
    copy.close();
  }
}

const journalMode = z.object({ journal_mode: z.string() });

/**
 * 完整备份：业务库、账号、AI工作区与原件、正式归档、提示词和工具设置，可选附带本机AI配置。
 * 清单里每个数据库文件都记下版本：业务库是结构版本（schemaVersion），其余是各自的 user_version（userVersion）。
 */
export async function createFullBackup(options: {
  dataDir: string;
  backupRoot: string;
  prefix?: 'full' | 'auto';
  extraFiles?: Record<string, string>;
}) {
  const dir = join(options.backupRoot, (options.prefix || 'full') + '-' + stamp()),
    staged = dir + '.partial',
    files: BackupFile[] = [];
  mkdirSync(staged, { recursive: true });
  try {
    const add = async (from: string, name: string) => {
      const to = join(staged, name),
        path = name.split(sep).join('/'),
        database = isDatabaseFile(from);
      mkdirSync(dirname(to), { recursive: true });
      if (database) {
        // 已打开的库按实际位置认，备份其他数据目录时也按数据目录内的相对位置认登记的库。
        const spec = specAt(from) ?? specAt(join(dirname(defaultDbPath), path));
        await copySqlite(from, to, spec?.scrubBackup);
      } else copyFileSync(from, to);
      files.push({
        path,
        sha256: sha256(to),
        bytes: statSync(to).size,
        // 业务库的版本在版本记录表里，下面校验完再填
        ...(database && path !== 'erp.sqlite' ? { userVersion: userVersionOf(to) } : {}),
      });
    };
    for (const file of walk(options.dataDir)) await add(file, relative(options.dataDir, file));
    for (const [name, path] of Object.entries(options.extraFiles || {}))
      if (basename(path) === masterKeyName || basename(name) === masterKeyName) throw new Error('主密钥不能进入业务备份，请单独保管。');
      else if (existsSync(path)) await add(path, join('_extra', name));
    const business = join(staged, 'erp.sqlite');
    // 比程序新的库也要能备份：补丁回滚后旧程序面对已升级的库，备份失败会卡住每小时备份和下一次补丁。
    // 版本写进清单；恢复仍然严格，只能用支持该版本的程序恢复。
    const schema = existsSync(business)
      ? validateBusinessDatabase(business, { allowNewer: true })
      : null;
    const businessFile = files.find((file) => file.path === 'erp.sqlite');
    if (businessFile && schema) businessFile.schemaVersion = schema.version;
    writeBackupManifest(staged, {
      kind: 'erp-full-backup',
      createdAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      schemaVersion: schema?.version ?? null,
      ...(schema?.newer ? { newerSchema: true, programSupportsUpTo: SCHEMA_LATEST } : {}),
      files,
    });
    renameSync(staged, dir);
    return {
      dir,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      schemaVersion: schema?.version ?? null,
      newerSchema: !!schema?.newer,
    };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 校验后恢复数据目录，保留原目录副本；切换失败自动退回。调用方须已确认服务停止。
 * 校验都在复制和切换之前：清单和哈希、每个数据库副本的文件头（WAL 模式的不是当前程序做的备份，在打开之前拒绝）、
 * 业务库（validateBusinessDatabase）、其余每个数据库文件（validateConfigDatabase）。
 * 任何一项不过就抛错，这时目标目录还没有动过。
 * _extra 里的本机配置不恢复（不覆盖本机），只查完整性。返回的 integrityOnly 是只查了完整性的数据库文件
 * （_extra 里的，和认不出是哪个配置库的），按备份里的路径列出。
 */
export function restoreFullBackup(source: string, dataDir: string) {
  const manifest = readBackupManifest(source);
  checkManifestFiles(source, manifest.files);
  const integrityOnly = validateBackupDatabases(source, dataDir, manifest.files);
  const previous = switchDataDirectory(dataDir, (staged) => {
    for (const file of manifest.files)
      if (!file.path.startsWith('_extra/')) {
        const to = join(staged, file.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(source, file.path), to);
      }
  });
  return { previous, files: manifest.files.length, integrityOnly };
}

/** 清单里每个文件：路径合法、不重复、不指到备份目录之外，哈希对得上；业务库必须在 */
function checkManifestFiles(source: string, files: BackupFile[]) {
  const root = realpathSync(source);
  const paths = new Set<string>();
  for (const file of files) {
    if (file.path.split('/').some((part) => !part || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part)))
      throw new Error('备份清单包含无效路径。');
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (paths.has(key)) throw new Error('备份清单包含重复路径。');
    paths.add(key);
    const resolved = realpathSync(join(root, file.path));
    const child = relative(root, resolved);
    if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + sep))
      throw new Error('备份清单文件指向备份目录之外。');
    if (sha256(resolved) !== file.sha256)
      throw new Error('备份文件校验失败：' + file.path);
  }
  if (!paths.has('erp.sqlite')) throw new Error('备份清单缺少业务库。');
}

/** 复制任何文件之前校验全部数据库副本：文件头、业务库、其余配置库；返回只查了完整性的文件 */
function validateBackupDatabases(source: string, dataDir: string, files: BackupFile[]) {
  // 用 SQLite 打开任何一个之前，先看全部数据库副本的文件头：还有 WAL 模式的就不是当前程序做的备份，直接拒绝
  for (const file of files)
    if (isDatabaseFile(file.path)) refuseWalBackup(join(source, file.path), file.path);
  // 0.9.0 以前的备份、比程序新的备份在这里就拒绝：还没有复制任何文件，目标目录不动
  validateBusinessDatabase(join(source, 'erp.sqlite'));
  // 其余的数据库文件：损坏的、比程序新的配置库、恢复后会被清空重建的旧库，同样在动任何文件之前拒绝
  const integrityOnly: string[] = [];
  for (const file of files) {
    if (file.path === 'erp.sqlite' || !isDatabaseFile(file.path)) continue;
    const home = file.path.startsWith('_extra/') ? null : join(dataDir, file.path);
    if (validateConfigDatabase(join(source, file.path), file.path, home)) integrityOnly.push(file.path);
  }
  return integrityOnly;
}

/** 先把备份复制进暂存目录（fill），完整了才清空数据目录、换进去；换的时候出错就退回原样 */
function switchDataDirectory(dataDir: string, fill: (staged: string) => void) {
  const staged = dataDir + '.restore-' + stamp();
  const previous = dataDir + '.before-restore-' + stamp();
  const existed = existsSync(dataDir);
  const clear = () => {
    for (const name of readdirSync(dataDir)) {
      if (name.endsWith('.running')) continue;
      rmSync(join(dataDir, name), { recursive: true, force: true });
    }
  };
  try {
    mkdirSync(staged, { recursive: true });
    fill(staged);
    // 副本完整复制成功后才开始破坏性切换，副本一直保留供人工恢复。
    if (existed) cpSync(dataDir, previous, { recursive: true });
    else mkdirSync(dataDir, { recursive: true });
    try {
      clear();
      for (const name of readdirSync(staged)) renameSync(join(staged, name), join(dataDir, name));
    } catch (error) {
      try {
        clear();
        if (existed) cpSync(previous, dataDir, { recursive: true });
        else rmSync(dataDir, { recursive: true, force: true });
      } catch {
        const detail = existed ? '原数据副本保留在：' + previous : '原目标目录不存在，请清理未完成的目录：' + dataDir;
        if (error instanceof Error) {
          error.message += '；自动回退失败，' + detail;
          throw error;
        }
        throw new Error('恢复备份及自动回退失败，' + detail, { cause: error });
      }
      throw error;
    }
    return previous;
  } finally {
    // 清理暂存失败不能盖住切换/回退的原始错误。
    try { rmSync(staged, { recursive: true, force: true }); } catch { /* 副本仍保留 */ }
  }
}
