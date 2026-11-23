import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DAY_MS, HOUR_MS, MINUTE_MS, errorMessage } from '../../../shared/core/index.js';
import { createFullBackup } from './backup.js';

const AUTO_BACKUP_KEEP = 14;
/** 文件不存在（stat 报 ENOENT） */
const missingFile = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function newest(dir: string, prefix: string) {
  if (!existsSync(dir)) return [] as string[];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
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
  const existing = await stat(target).catch((error: unknown) => {
    if (!missingFile(error)) throw error;
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
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      lastAutoBackupFailure = { at: new Date().toISOString(), message: failure.message };
      (options.onError || ((e) => console.error('自动备份失败：', e.message)))(failure);
    } finally {
      running = false;
    }
  };
  // 备份的出错 run 自己接住（记下失败、交给 onError），定时器这边不用等它
  const tick = () => void run();
  // 启动一分钟后看第一次，之后每小时看一次，距上次满 24 小时才做
  const first = setTimeout(tick, MINUTE_MS),
    timer = setInterval(tick, HOUR_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
