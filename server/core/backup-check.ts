import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { SCHEMA_BASELINE, SCHEMA_LATEST, inspectSchema, mismatchLines, schemaMismatch } from './schema/index.js';
import { checkVersionedSqlite } from './versioned-sqlite.js';
import { errorMessage } from '../../shared/core/index.js';
import { exists, integrityPassed, pragmaInteger } from './sql.js';

/* 备份里的数据库文件能不能用（backup.ts 备份和恢复时用）：WAL 模式的拒收、业务库的版本和结构、其余配置库的完整性和版本。 */

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
/** 文件头读到第 18、19 字节（写、读格式版本）为止 */
const HEADER_BYTES = 20;
/**
 * 不用数据库连接、直接读文件头，看这个 SQLite 文件是不是 WAL 模式（第 18、19 字节：1 是回滚日志，2 是 WAL）。
 * 用 SQLite 打开 WAL 模式的文件（哪怕只读）会在旁边生成 -wal、-shm，所以要在打开之前看。
 * 读不出来、太短、不是 SQLite 文件的返回 false，交给后面的校验按“不是有效的备份”处理。
 */
function isWalFile(file: string) {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(HEADER_BYTES);
    if (readSync(fd, head, 0, head.length, 0) < head.length) return false;
    return head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC) && (head[18] === 2 || head[19] === 2);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
/**
 * 恢复前先看：备份里的数据库文件还是 WAL 模式，就不是当前程序做出来的备份（当前程序做的副本都整理成了单个文件），
 * 在用 SQLite 打开它之前拒绝，备份目录和数据目录都不写任何东西。name 是提示里写的文件名。
 */
export function refuseWalBackup(file: string, name: string) {
  if (isWalFile(file))
    throw new Error(
      `这份备份是旧格式（里面的数据库文件 ${name} 没有整理成单个文件），不能恢复。` +
        '请用当前版本重新做一次完整备份（npm run backup）；直接复制出来的 erp.sqlite 也不能当备份用。现有数据没有改动。',
    );
}
/** 当前程序认识的业务库版本：第 20 版（0.9.0 基线）到最新版。补丁脚本的测试也用它。 */
export const supportedDatabaseVersions = Array.from(
  { length: SCHEMA_LATEST - SCHEMA_BASELINE + 1 },
  (_, index) => SCHEMA_BASELINE + index,
);

/**
 * 校验一份业务库文件（备份里的、要恢复的），只读。依次查：完整性和数据关联、是不是本系统 0.9.0 以后的库、
 * 版本记录从第 20 版起连续、版本不比程序新。
 * - 恢复时严格：打开之前先看文件头，WAL 模式的（不是当前程序做的备份）直接拒绝，旁边不会生成 -wal、-shm；
 *   0.9.0 以前的备份明确拒绝；比程序新的拒绝；正好是当前版本的还要比一次结构指纹，
 *   认出被数据库工具改过结构的库。第 20 版以上、比程序旧的可以恢复，下次启动自动快照并升级。
 * - 备份时传 allowNewer：数据库比程序新（例如补丁回滚后旧程序面对已升级的库）也照样备份，只记下版本，
 *   不比结构指纹；完整性和关联校验照做。校验的是已经整理成单个文件的副本。
 */
export function validateBusinessDatabase(path: string, options: { allowNewer?: boolean } = {}) {
  if (!options.allowNewer) refuseWalBackup(path, basename(path));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!integrityPassed(db, 'integrity_check')) throw new Error('数据库完整性校验失败');
    if (exists(db, 'PRAGMA foreign_key_check')) throw new Error('数据关联校验失败');
    const state = inspectSchema(db);
    if (state.kind === 'legacy') {
      const version = state.version === null ? '没有版本记录' : `业务库第 ${state.version} 版`;
      throw new Error(
        options.allowNewer
          ? `这是 0.9.0 以前的旧业务库（${version}），当前程序不处理它，没有备份。要保存旧数据，请直接复制整个数据目录，或用 0.8.4 的程序备份。`
          : `这是 0.9.0 以前的备份（${version}），0.9.0 起业务数据从新库开始，不能恢复；要查看旧数据，请用 0.8.4 的程序恢复到另一个目录。`,
      );
    }
    if (state.kind === 'empty' || state.kind === 'foreign')
      throw new Error('不支持此数据库：不是本系统的业务数据库');
    if (state.kind === 'broken') throw new Error('数据库版本记录不连续（' + state.reason + '），拒绝处理');
    if (state.kind === 'newer') {
      if (!options.allowNewer)
        throw new Error(
          `不支持此数据库版本：数据库是第 ${state.version} 版，当前程序最高支持第 ${state.supported} 版，请用更新的程序恢复`,
        );
      return { version: state.version, newer: true };
    }
    const mismatch = state.kind === 'current' && !options.allowNewer ? schemaMismatch(db) : null;
    if (mismatch)
      throw new Error(
        [
          `数据库的结构和第 ${SCHEMA_LATEST} 版的标准结构不一致（可能被数据库工具改过，或者是开发过程中的库），拒绝恢复`,
          ...mismatchLines(mismatch),
        ].join('\n'),
      );
    return { version: state.kind === 'current' ? state.version : state.from, newer: false };
  } finally {
    db.close();
  }
}

export const isDatabaseFile = (name: string) => /\.sqlite$/.test(name);
export function userVersionOf(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return pragmaInteger(db, 'user_version');
  } finally {
    db.close();
  }
}

/**
 * 校验备份里业务库以外的数据库文件（账号、提示词、助手工具设置、AI 识别工作区，还有 _extra 里的本机配置），只读。
 * - 每个都要通过完整性检查；
 * - home 是恢复以后它所在的位置：这个位置登记过是哪个配置库（server/core/versioned-sqlite.ts 的登记表）的，
 *   还要是当前程序打得开的——不能比程序新，也不能是没记版本、当前程序不认的旧格式（比如 0.9.0 以前的 AI 识别工作区）。
 *   没登记过的位置不知道是哪个库，只查完整性。
 * name 是它在备份里的路径，写进提示里：每句提示都写明是哪个文件，认得出是哪个库的再带上库名。
 */
export function validateConfigDatabase(path: string, name: string, home: string | null) {
  const untouched = '现有数据没有改动。';
  let intact: boolean;
  let known: ReturnType<typeof checkVersionedSqlite> = null;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      intact = integrityPassed(db, 'integrity_check');
    } finally {
      db.close();
    }
    if (intact && home) known = checkVersionedSqlite(path, home);
  } catch (error) {
    throw new Error(
      `备份里的 ${name} 打不开，文件已经损坏或者不是数据库（${errorMessage(error)}），不能恢复。请换一份备份。${untouched}`,
    );
  }
  if (!intact)
    throw new Error(`备份里的 ${name} 没有通过完整性检查，文件已经损坏，不能恢复。请换一份备份。${untouched}`);
  if (known?.problem === 'newer')
    throw new Error(
      `备份里的 ${name}（${known.label}）是第 ${known.version} 版，比当前程序新（当前程序最多支持第 ${known.latest} 版），不能恢复。请用更新的程序恢复这份备份。${untouched}`,
    );
  if (known?.problem === 'older')
    throw new Error(
      `备份里的 ${name}（${known.label}）是旧版本的库（${known.version ? '第 ' + known.version + ' 版' : '没有记版本'}，当前是第 ${known.latest} 版），恢复以后程序打开时会把它清空重建，所以不能恢复。请换一份备份。${untouched}`,
    );
}
