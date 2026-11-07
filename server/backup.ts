import { masterKeyName } from './config-paths.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Store } from './db.js';
import { ImportError } from './import/errors.js';

const stamp = () =>
  new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') +
  '-' +
  randomUUID().slice(0, 6);
const SNAPSHOT_DIR = 'snapshots';
const SNAPSHOT_KEEP = 20;
const SNAPSHOT_THROTTLE_MS = 5 * 60_000;
const AUTO_BACKUP_KEEP = 14;
const DAY_MS = 24 * 3600_000;
/** 运行时文件不进入备份：WAL由一致性备份合并，锁和控制令牌只属于运行中的实例。 */
const isTransient = (name: string) =>
  name === masterKeyName || /(-wal|-shm|\.running|\.control)$/.test(name) || /\.(restore|before-restore)-/.test(name);

function newest(dir: string, prefix: string) {
  if (!existsSync(dir)) return [] as string[];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
}

/**
 * 破坏性操作前的业务库快照：用它代替重复确认，让误删可以恢复。
 * VACUUM INTO 是同步的且得到一致副本；事务内无法执行，由调用方放在事务之外。
 * 5分钟内已有快照时不重复生成，失败则抛错，由调用方中止破坏性操作。
 */
export function snapshotBeforeDestructive(store: Store, reason: string): string | null {
  if (store.path === ':memory:' || store.db.isTransaction) return null;
  const dir = join(dirname(store.path), SNAPSHOT_DIR),
    existing = newest(dir, 'erp-');
  if (existing[0] && Date.now() - statSync(join(dir, existing[0])).mtimeMs < SNAPSHOT_THROTTLE_MS)
    return join(dir, existing[0]);
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'erp-' + stamp() + '-' + reason.replace(/[^\w-]/g, '') + '.sqlite');
    store.db.exec("VACUUM INTO '" + file.replaceAll("'", "''") + "'");
    for (const old of newest(dir, 'erp-').slice(SNAPSHOT_KEEP)) unlinkSync(join(dir, old));
    return file;
  } catch (error) {
    throw new ImportError(
      '无法在操作前生成恢复快照，本次操作未执行：' + (error as Error).message,
      507,
    );
  }
}

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
async function copySqlite(from: string, to: string) {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(db, to);
  } finally {
    db.close();
  }
}
export function validateBusinessDatabase(path: string, versions: number[]) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok')
      throw new Error('数据库完整性校验失败');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据关联校验失败');
    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all().map((row) => Number(row.version));
    const latest = applied.at(-1);
    if (latest === undefined || !versions.includes(latest)) throw new Error('不支持此数据库版本');
    if (applied.length !== latest || applied.some((version, index) => version !== index + 1))
      throw new Error('数据库迁移版本不连续，拒绝恢复');
    for (const table of ['customers', 'products', 'orders', 'order_lines'])
      db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
  } finally {
    db.close();
  }
}
export const supportedDatabaseVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

/** 启动锁内调用，在 Store 执行任何迁移前保存包含 WAL 内容的一致副本。 */
export function snapshotBeforeUpgrade(path: string) {
  if (path === ':memory:' || !existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  let staged: string | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const hasHistory = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
    const versions = new Set(hasHistory ? db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version) : []);
    if (supportedDatabaseVersions.every((version) => versions.has(version))) return null;
    const dir = join(dirname(path), SNAPSHOT_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'upgrade-' + stamp() + '.sqlite');
    staged = file + '.partial';
    db.prepare('VACUUM INTO ?').run(staged);
    renameSync(staged, file);
    return file;
  } catch (error) {
    if (staged) try { rmSync(staged, { force: true }); } catch { /* 保留原始错误 */ }
    throw new Error('升级前业务库快照失败，未启动数据库迁移：' + (error as Error).message);
  } finally {
    db?.close();
  }
}

/** 完整备份：业务库、账号、AI工作区与原件、正式归档、提示词和工具设置，可选附带本机AI配置。 */
export async function createFullBackup(options: {
  dataDir: string;
  backupRoot: string;
  prefix?: 'full' | 'auto';
  extraFiles?: Record<string, string>;
}) {
  const dir = join(options.backupRoot, (options.prefix || 'full') + '-' + stamp()),
    staged = dir + '.partial',
    files: { path: string; sha256: string; bytes: number }[] = [];
  mkdirSync(staged, { recursive: true });
  try {
    const add = async (from: string, name: string) => {
      const to = join(staged, name);
      mkdirSync(dirname(to), { recursive: true });
      if (/\.sqlite$/.test(from)) {
        await copySqlite(from, to);
        if (name.split(sep).join('/') === 'security/users.sqlite') {
          // 备份恢复应重新登录，已撤销的历史会话不会因恢复而重新生效。
          const auth = new DatabaseSync(to);
          try {
            if (auth.prepare("SELECT 1 FROM sqlite_schema WHERE name='auth_sessions' AND type='table'").get())
              auth.exec('PRAGMA secure_delete=ON; DELETE FROM auth_sessions;');
          } finally { auth.close(); }
        }
      }
      else copyFileSync(from, to);
      files.push({ path: name.split(sep).join('/'), sha256: sha256(to), bytes: statSync(to).size });
    };
    for (const file of walk(options.dataDir)) await add(file, relative(options.dataDir, file));
    for (const [name, path] of Object.entries(options.extraFiles || {}))
      if (basename(path) === masterKeyName || basename(name) === masterKeyName) throw new Error('主密钥不能进入业务备份，请单独保管。');
      else if (existsSync(path)) await add(path, join('_extra', name));
    const business = join(staged, 'erp.sqlite');
    if (existsSync(business)) validateBusinessDatabase(business, supportedDatabaseVersions);
    writeFileSync(
      join(staged, 'manifest.json'),
      JSON.stringify({ kind: 'erp-full-backup', createdAt: new Date().toISOString(), files }, null, 2),
    );
    renameSync(staged, dir);
    return { dir, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/** 校验后恢复数据目录，保留原目录副本；切换失败自动退回。调用方须已确认服务停止。 */
export function restoreFullBackup(source: string, dataDir: string) {
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest?.kind !== 'erp-full-backup' || !Array.isArray(manifest.files))
    throw new Error('不是完整备份目录。');
  const root = realpathSync(source);
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file?.path !== 'string' || typeof file.sha256 !== 'string' ||
        file.path.split('/').some((part: string) => !part || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part)))
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
  validateBusinessDatabase(join(source, 'erp.sqlite'), supportedDatabaseVersions);
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
    for (const file of manifest.files)
      if (!file.path.startsWith('_extra/')) {
        const to = join(staged, file.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(source, file.path), to);
      }
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
    return { previous, files: manifest.files.length };
  } finally {
    // 清理暂存失败不能盖住切换/回退的原始错误。
    try { rmSync(staged, { recursive: true, force: true }); } catch { /* 副本仍保留 */ }
  }
}

/** 每日自动完整备份：启动后检查，距上次满24小时再做；失败只记录，不影响业务。 */
let lastAutoBackupFailure: { at: string; message: string } | null = null;
/** 最近一次自动备份失败的记录，下一次成功后清除。今日页据此提示。 */
export const autoBackupFailure = () => lastAutoBackupFailure;

export async function copyAutomaticBackup(source: string, targetRoot: string, keep?: number) {
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (pathKey(resolve(dirname(source))) === pathKey(resolve(targetRoot)))
    throw new Error('备份复制目录须与本地备份目录不同。');
  await mkdir(targetRoot, { recursive: true });
  if (pathKey(await realpath(dirname(source))) === pathKey(await realpath(targetRoot)))
    throw new Error('备份复制目录须与本地备份目录不同。');
  const target = join(targetRoot, basename(source));
  const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing && !existing.isDirectory()) throw new Error('备份目标存在同名文件。');
  if (!existing) {
    const staged = target + '.' + randomUUID() + '.partial';
    try {
      await cp(source, staged, { recursive: true, errorOnExist: true, force: false });
      await rename(staged, target);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  if (keep !== undefined)
    for (const old of (await readdir(targetRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^auto-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[\da-f]{6}$/.test(entry.name))
      .map((entry) => entry.name).sort().reverse()
      .slice(keep))
      await rm(join(targetRoot, old), { recursive: true, force: true });
}

export function scheduleDailyBackup(options: {
  dataDir: string;
  backupRoot: string;
  extraFiles?: Record<string, string>;
  copyDir?: string;
  copyKeep?: number;
  onError?: (error: Error) => void;
}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const latest = newest(options.backupRoot, 'auto-').filter((n) => !n.endsWith('.partial'))[0];
      const latestPath = latest && join(options.backupRoot, latest);
      const fresh = latestPath && Date.now() - statSync(latestPath).mtimeMs < DAY_MS;
      if (fresh && !options.copyDir) return;
      const local = fresh ? latestPath : (await createFullBackup({ ...options, prefix: 'auto' })).dir;
      for (const old of newest(options.backupRoot, 'auto-')
        .filter((n) => !n.endsWith('.partial'))
        .slice(AUTO_BACKUP_KEEP))
        rmSync(join(options.backupRoot, old), { recursive: true, force: true });
      if (options.copyDir) await copyAutomaticBackup(local, options.copyDir, options.copyKeep);
      lastAutoBackupFailure = null;
    } catch (error) {
      lastAutoBackupFailure = { at: new Date().toISOString(), message: (error as Error).message };
      (options.onError || ((e) => console.error('自动备份失败：', e.message)))(error as Error);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 60_000),
    timer = setInterval(run, 3600_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
