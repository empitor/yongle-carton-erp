/**
 * 业务库（erp.sqlite）的结构：建表、认版本、升级。
 * - tables/ 是当前完整结构，空库照它一次建好（create.ts）；
 * - steps.ts 是第 20 版以后的升级步骤，一个事务里执行、失败整体退回（upgrade.ts）；
 * - 打开业务库只有 openBusinessDatabase 一个入口：0.9.0 以前的旧库、比程序新的库、不是本系统的文件、
 *   版本记录不完整的库、版本是当前版本表结构却和程序对不上的库（conformity.ts）都拒绝并给出中文提示，数据不动。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { errorMessage } from '../../../shared/core/index.js';
import { SQLITE_CODE, sqliteCode } from '../errors.js';
import { exists, many, pragmaInteger } from '../sql.js';
import { mismatchLines, schemaMismatch, type SchemaMismatch } from './conformity.js';
import { createSchema, type SchemaBuild } from './create.js';
import { SchemaError } from './errors.js';
import { applyConnectionPragmas, applySessionPragmas, optimizeDatabase, readOnlyDatabase } from './pragmas.js';
import { latestVersion, orderedSteps, snapshotForUpgrade, upgradeSchema, type UpgradeStep } from './upgrade.js';
import { SCHEMA_APPLICATION_ID, SCHEMA_BASELINE, SCHEMA_LATEST } from './version.js';

export { expectedSchemaFingerprint, mismatchLines, schemaMismatch } from './conformity.js';
export { buildTables, createSchema, schemaTableGroups } from './create.js';
export type { SchemaBuild } from './create.js';
export { describeSchema, normalizeSql, schemaFingerprint } from './describe.js';
export { SchemaError } from './errors.js';
export { optimizeDatabase, reclaimSpace } from './pragmas.js';
export { upgradeSteps } from './steps.js';
export { SNAPSHOT_DIRECTORY, STAMP_PATTERN, stamp, stampTime, upgradeSchema } from './upgrade.js';
export type { UpgradeStep } from './upgrade.js';
export { SCHEMA_APPLICATION_ID, SCHEMA_BASELINE, SCHEMA_LATEST } from './version.js';

export type SchemaState =
  /** 没有任何表：新建 */
  | { kind: 'empty' }
  | { kind: 'current'; version: number }
  /** 第 20 版以上、比程序旧：先拍快照再升级 */
  | { kind: 'upgrade'; from: number; to: number }
  /** 0.9.0 以前的旧库；version 是它的版本，读不出来是 null */
  | { kind: 'legacy'; version: number | null }
  /** 比程序新；supported 是当前程序最多支持到第几版 */
  | { kind: 'newer'; version: number; supported: number }
  /** 不是本系统的业务库 */
  | { kind: 'foreign' }
  /** 是本系统的库，但版本记录缺号或读不出来 */
  | { kind: 'broken'; reason: string };

const versionValue = z.object({ version: z.unknown().optional() });
const nameRow = z.object({ name: z.string() });
const isVersion = (value: unknown): value is number => Number.isInteger(value);

/**
 * 读版本记录里的版本号（从小到大）。别的程序的库、坏掉的库里这张表可能不是本系统的样子，认库时这是正常情况：
 * 没有 version 列、或者有不是整数的版本号，返回 null（不算读库出错，也不记日志）。
 */
function recordedVersions(db: DatabaseSync) {
  if (!exists(db, "SELECT 1 FROM pragma_table_info('schema_migrations') WHERE name='version'")) return null;
  const versions = many(db, versionValue, 'SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version);
  return versions.every(isVersion) ? versions : null;
}

/**
 * 判断一个库是什么状态。只读，不改任何东西。
 * 认库靠文件头里的 application_id：本系统 0.9.0 以后的库是固定值，0.9.0 以前的旧库和大多数别的 SQLite 文件是 0。
 * latest 只给测试用（配合测试里虚构的升级步骤）。
 */
export function inspectSchema(db: DatabaseSync, latest = SCHEMA_LATEST): SchemaState {
  const applicationId = pragmaInteger(db, 'application_id');
  const tables = many(db, nameRow, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(
    (row) => row.name,
  );
  const hasRecords = tables.includes('schema_migrations');
  if (applicationId !== SCHEMA_APPLICATION_ID) {
    if (applicationId !== 0) return { kind: 'foreign' };
    if (!tables.length) return { kind: 'empty' };
    // 没有标识但有版本记录表：0.9.0 以前的旧库（它们的版本到第 19 版为止）
    const versions = hasRecords ? recordedVersions(db) : null;
    if (!versions) return { kind: 'foreign' };
    const newest = versions.at(-1) ?? null;
    if (newest !== null && newest >= SCHEMA_BASELINE)
      return { kind: 'broken', reason: `版本记录到了第 ${newest} 版，但文件里没有本系统的标识` };
    return { kind: 'legacy', version: newest };
  }
  // 有标识但一张表都没有：上次建库在设好文件头之后、建表之前断掉了，当成空库重新建
  if (!tables.length) return { kind: 'empty' };
  const versions = hasRecords ? recordedVersions(db) : null;
  if (!versions) return { kind: 'broken', reason: '版本记录表不存在或读不出来' };
  const newest = versions.at(-1);
  if (newest === undefined) return { kind: 'broken', reason: '版本记录是空的' };
  if (versions[0] < SCHEMA_BASELINE)
    return { kind: 'broken', reason: `版本记录里混进了 0.9.0 以前的第 ${versions[0]} 版` };
  // 当前程序认识的那一段（第 20 版到 latest）必须一版不缺；更新的版本看不懂编号规则，只按“比程序新”处理
  const recorded = new Set(versions);
  for (let version = SCHEMA_BASELINE; version <= Math.min(newest, latest); version++)
    if (!recorded.has(version)) return { kind: 'broken', reason: `缺第 ${version} 版的记录` };
  if (newest > latest) return { kind: 'newer', version: newest, supported: latest };
  return newest === latest ? { kind: 'current', version: newest } : { kind: 'upgrade', from: newest, to: latest };
}

const printLine = (message: string) => console.log(message);
const UNTOUCHED = '程序没有启动，数据没有任何改动。';
/** 表结构对不上时该怎么办（启动时拒绝、升级后对不上都用这句） */
const MISMATCH_ADVICE = '正式数据请用最近的完整备份恢复；开发用的库可以移到别的地方保存，再启动程序建新库。';

/** 这个状态的库不能打开时，返回给人看的中文提示；能打开（空库、当前版本、可以升级）返回 null。 */
export function schemaRefusal(state: SchemaState, path: string): string | null {
  if (state.kind === 'legacy') {
    const dir = dirname(path);
    return [
      `这是 0.9.0 以前的旧业务数据库（${state.version === null ? '没有版本记录' : `第 ${state.version} 版`}）：${path}`,
      `0.9.0 起业务数据从新库开始，不再升级旧库。${UNTOUCHED}`,
      `请把下面这些旧数据移到别的地方保存，再启动程序建新库（都在 ${dir} 里）：`,
      '  1. erp.sqlite，连同 erp.sqlite-wal、erp.sqlite-shm（有就一起移走）',
      '  2. import-archive 目录（导入原件的归档）',
      '  3. ai-imports 目录（AI 识别工作区）',
      '其余目录留着不动：账号（security）、提示词（ai-prompts）、助手工具设置（ai-tools）、AI 设置、机器人设置这些配置库，程序启动时会按新结构重新建。' +
        '启动后要重新建管理员和各个账号，到设置里重新填 DeepSeek 密钥和机器人设置；提示词和助手工具设置回到默认。',
      '要查看旧数据，请用 0.8.4 的程序打开移走的那一份。',
    ].join('\n');
  }
  if (state.kind === 'newer')
    return [
      `数据库是第 ${state.version} 版，比当前程序（最多支持第 ${state.supported} 版）新：${path}`,
      '多半是补丁回滚时只换回了程序。请换回新版本的程序，或用补丁前的完整备份恢复。',
      UNTOUCHED,
    ].join('\n');
  if (state.kind === 'foreign')
    return [`这个文件不是本系统的业务数据库：${path}`, `请检查 DB_PATH 指向的位置。${UNTOUCHED}`].join('\n');
  if (state.kind === 'broken')
    return [
      `业务数据库的版本记录不完整（${state.reason}）：${path}`,
      `请用最近的完整备份恢复，或联系维护人员。${UNTOUCHED}`,
    ].join('\n');
  return null;
}

/** 版本是当前版本、表结构却和程序新建的对不上（开发阶段直接改了建表、被数据库工具改过）时给人看的提示 */
function mismatchRefusal(mismatch: SchemaMismatch, version: number, path: string) {
  return [
    `业务数据库的表结构和当前程序（第 ${version} 版）对不上：${path}`,
    ...mismatchLines(mismatch),
    '版本记录是当前版本，表结构却和程序新建的不一样（多半是开发阶段直接改了建表、没写升级步骤，或者被数据库工具改过）。' +
      '照这样打开，要到写入时才成片报缺列，所以不打开。',
    MISMATCH_ADVICE,
    UNTOUCHED,
  ].join('\n');
}

/** 用只读连接看一眼文件的状态：被拒绝的库连 WAL 都不会被合并，文件内容一个字节不变。 */
function inspectFile(path: string, latest: number): SchemaState {
  try {
    return readOnlyDatabase(path, (db) => inspectSchema(db, latest));
  } catch (error) {
    // 根本不是 SQLite 文件
    if (sqliteCode(error) === SQLITE_CODE.notADatabase) return { kind: 'foreign' };
    throw new SchemaError(`业务数据库打不开：${errorMessage(error)}\n文件：${path}\n${UNTOUCHED}`);
  }
}

export type OpenOptions = {
  /** 当前程序的版本号（package.json 的 version），写进版本记录 */
  appVersion: string;
  /** 升级前要不要拍快照，默认要 */
  snapshot?: boolean;
  /** 升级时的说明往哪里打，默认打到控制台 */
  log?: (message: string) => void;
  /**
   * 只给测试用：换一套建表和升级步骤（默认是 tables/ 和 steps.ts 里的），两者要配套（走完步骤和直接建出来是同一个结构）。
   * 空库照 build 建，核对表结构时应有的结构也按 build 算，和正式走同一条路。
   */
  steps?: readonly UpgradeStep[];
  build?: SchemaBuild;
};

/**
 * 升级前快照：只在库的状态是“可以升级”时拍，其余情况（新库、已是当前版本、会被拒绝的库、文件不存在）返回 null。
 * openBusinessDatabase 会自己调用；单独导出给要先拍快照、再做别的事的调用方和测试。
 */
export function snapshotBeforeUpgrade(path: string, steps?: readonly UpgradeStep[]): string | null {
  if (path === ':memory:' || !existsSync(path) || !statSync(path).size) return null;
  const state = inspectFile(path, latestVersion(orderedSteps(steps)));
  return state.kind === 'upgrade' ? snapshotForUpgrade(path, state.from, state.to) : null;
}

/**
 * 打开之前先用只读连接判断已有文件的状态：不能打开的直接拒绝（抛 SchemaError，文件不动），
 * 已是当前版本的核对表结构，可以升级的拍升级前快照。文件不存在或是空文件什么都不做。
 */
function checkExistingFile(path: string, options: OpenOptions, latest: number) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || !statSync(path).size) return;
  const seen = inspectFile(path, latest);
  const refusal = schemaRefusal(seen, path);
  if (refusal) throw new SchemaError(refusal);
  if (seen.kind === 'current') {
    const mismatch = readOnlyDatabase(path, (db) => schemaMismatch(db, options.build));
    if (mismatch) throw new SchemaError(mismatchRefusal(mismatch, seen.version, path));
  }
  if (seen.kind === 'upgrade' && options.snapshot !== false)
    (options.log ?? printLine)('已生成升级前业务库快照：' + snapshotForUpgrade(path, seen.from, seen.to));
}

/** 升级完、提交之前核对表结构：对不上就抛错，整个升级退回 */
const checkUpgraded = (build: SchemaBuild | undefined) => (db: DatabaseSync) => {
  const mismatch = schemaMismatch(db, build);
  if (mismatch) throw new Error(['升级后的表结构和当前程序新建的对不上', ...mismatchLines(mismatch), MISMATCH_ADVICE].join('\n'));
};

/** 空库建表；建不成的整体退回，换成说清原因和文件的 SchemaError */
function createOrExplain(db: DatabaseSync, path: string, options: OpenOptions, steps: readonly UpgradeStep[]) {
  try {
    createSchema(db, { appVersion: options.appVersion, steps, build: options.build });
  } catch (error) {
    throw new SchemaError(
      [
        `业务数据库没有建成：${errorMessage(error)}`,
        `文件：${path}`,
        '建了一半的表已经全部退回，程序没有启动。请检查磁盘空间和这个目录的读写权限，排除以后再启动会重新建库。',
      ].join('\n'),
    );
  }
}

/**
 * 打开业务库的唯一入口（服务端、维护命令行、脚本里的预览实例都经过 Store 走到这里）：
 * 1. 文件已经存在就先用只读连接判断状态，不能打开的直接拒绝（抛 SchemaError，文件不动）；
 *    已是当前版本的还要核对表结构，和程序新建的对不上同样拒绝；
 * 2. 可以升级的先拍升级前快照；
 * 3. 空库新建，旧一些的库升级（升级完提交前同样核对表结构），然后设好连接参数返回。
 * ':memory:' 每次都是空库，直接建。
 */
export function openBusinessDatabase(path: string, options: OpenOptions): DatabaseSync {
  const steps = orderedSteps(options.steps);
  const latest = latestVersion(steps);
  if (path !== ':memory:') checkExistingFile(path, options, latest);
  const db = new DatabaseSync(path);
  try {
    applySessionPragmas(db);
    // 以这个连接看到的为准（两次打开之间文件可能被换过）
    const state = inspectSchema(db, latest);
    const refusal = schemaRefusal(state, path);
    if (refusal) throw new SchemaError(refusal);
    if (state.kind === 'empty') createOrExplain(db, path, options, steps);
    else if (state.kind === 'upgrade') {
      const done = upgradeSchema(db, { appVersion: options.appVersion, steps, check: checkUpgraded(options.build) });
      (options.log ?? printLine)(`业务数据库已从第 ${done.from} 版升级到第 ${done.to} 版。`);
    }
    applyConnectionPragmas(db);
    // 刚建的空库没有数据可统计
    if (state.kind !== 'empty') optimizeDatabase(db, true);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
