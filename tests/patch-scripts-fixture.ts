// 加载补丁脚本（scripts/ 下的 .mjs，没有类型声明）共用的准备：按写明的形状核对导出，再按脚本里的写法给出类型。
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// 用变量路径动态导入，类型检查不去解析它们。导入后按下面写明的形状核对点名的导出都在、种类对得上。
type ExportKind = 'function' | 'string' | 'array';
const kindOf = (value: unknown) => (Array.isArray(value) ? 'array' : typeof value);
function hasExports<T>(mod: unknown, shape: Record<string, ExportKind>): mod is T {
  if (typeof mod !== 'object' || mod === null) return false;
  return Object.entries(shape).every(([name, kind]) => kindOf(Reflect.get(mod, name)) === kind);
}
export async function load<T>(path: string, shape: Record<keyof T, ExportKind>): Promise<T> {
  const mod: unknown = await import(pathToFileURL(join(projectRoot, path)).href);
  if (!hasExports<T>(mod, shape)) throw new Error(path + ' 的导出和测试里写明的不一致');
  return mod;
}

export type SchemaState = { exists: boolean; versions: number[] };
/** 回滚时要的那些：补丁开始时间、补丁前的结构版本和完整备份、服务器上的位置 */
export type RollbackContext = {
  startedAt: string;
  schemaBefore: SchemaState | null;
  backupDir: string | null;
  backupRoot: string;
  port: string;
};
export type RollbackIo = {
  readErpSh: () => string;
  roots: (string | null)[];
  revert: () => number | null;
  readVersion: (file: string) => number | null;
  readSchema: () => SchemaState | null;
  restoreDatabase: (reason: string) => boolean;
  warn: (...lines: string[]) => void;
};
type ConfigBackup = { backup: string; database: string; from: number; to: number };

/** scripts/linux/patch-logic.mjs 的导出（apply-patch.mjs 的纯逻辑部分） */
type PatchLogic = {
  rollbackPlan: (o: { before: SchemaState | null; after: SchemaState | null; backupDir: string | null }) => {
    action: 'files-only' | 'restore-db' | 'manual';
    reason: string;
  };
  manualSteps: (o: { backupDir: string | null; backupRoot: string; port: string }) => string[];
  parseBackupDir: (output: string) => string | null;
  parseEnv: (text: string) => Record<string, string>;
  configDirOf: (env: Record<string, string>, passwdText: string) => string | null;
  patchTarget: (path: string) => string | null;
  schemaProbe: string;
  parseSchema: (stdout: string) => SchemaState | null;
  acquireLock: (path: string, info: Record<string, unknown>, isAlive: (pid: number) => boolean) => () => void;
};
export const patchLogic = () =>
  load<PatchLogic>('scripts/linux/patch-logic.mjs', {
    rollbackPlan: 'function',
    manualSteps: 'function',
    parseBackupDir: 'function',
    parseEnv: 'function',
    configDirOf: 'function',
    patchTarget: 'function',
    schemaProbe: 'string',
    parseSchema: 'function',
    acquireLock: 'function',
  });

/** scripts/linux/patch-rollback.mjs 的导出（回滚时换回配置库） */
type PatchRollback = {
  hasRevertCommand: (erpShText: string) => boolean;
  configUpgradeBackups: (roots: string[], since: Date) => ConfigBackup[];
  versionProbe: string;
  parseVersion: (stdout: string) => number | null;
  rollbackData: (ctx: RollbackContext, io: RollbackIo) => boolean;
};
export const patchRollback = () =>
  load<PatchRollback>('scripts/linux/patch-rollback.mjs', {
    hasRevertCommand: 'function',
    configUpgradeBackups: 'function',
    versionProbe: 'string',
    parseVersion: 'function',
    rollbackData: 'function',
  });
