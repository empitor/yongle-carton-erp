// 把业务库第 20 版（0.9.0 基线）的结构导出成可以直接执行的 SQL：tests/fixtures/schema-v20.sql。
// 用法：npm run schema:dump（写到默认位置），或 npm run schema:dump -- <输出路径>（测试里写到临时目录）。
//
// - 只在内存里建空库，和程序新建业务库走同一条路（Store → openBusinessDatabase → createSchema），不碰任何数据文件。
// - 输出是确定的：同一份代码导出多少次都逐字节相同。不带当前时间、程序版本号、机器信息；换行一律 LF。
//   版本记录的时间和程序版本换成固定的占位值（结构比较 describeSchema 本来就不比这两列）。
// - 顺序：建表、索引、触发器、视图按 sqlite_schema 里的先后（就是建库时的先后）；数据的表也按这个先后，行按 rowid。
// - 当前建表已经不是第 20 版（steps.ts 里有了升级步骤）就拒绝导出：0.9.0 发布后这份快照不许再改。
// 守它的测试在 tests/core/schema-evolution.test.ts（“第 20 版结构快照”几条）。
// 同一个命令还按建表生成每张表的行结构（server/core/schema/rows.ts，见 scripts/schema-rows.ts），
// 并导出还没有升级步骤的配置库的基线快照（tests/fixtures/config-db/，见 scripts/config-db-dump.ts）。
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../server/core/index.js';
import { writeConfigBaselines } from './config-db-dump.js';
import { writeRowSchemas } from './schema-rows.js';

/** 快照固定的结构版本 */
const SNAPSHOT_VERSION = 20;
/** 版本记录里和导出时刻、程序版本有关的两列，换成这两个固定值 */
export const SNAPSHOT_PLACEHOLDERS = { applied_at: '2000-01-01T00:00:00.000Z', app_version: 'schema-v20' } as const;
/** 默认输出位置 */
export const SNAPSHOT_FILE = fileURLToPath(new URL('../tests/fixtures/schema-v20.sql', import.meta.url));

type Row = Record<string, unknown>;
const AUTO_VACUUM = ['NONE', 'FULL', 'INCREMENTAL'];
const ident = (name: string) => (/^[a-z_][a-z0-9_]*$/i.test(name) ? name : '"' + name.replaceAll('"', '""') + '"');
/** 读一行，读不到就报错（建好的空库里这几行一定有） */
const mustGet = (db: DatabaseSync, sql: string, ...params: string[]) => {
  const row = db.prepare(sql).get(...params);
  if (!row) throw new Error('导出结构快照时读不到：' + sql);
  return row;
};
const pragma = (db: DatabaseSync, name: string) => Number(Object.values(mustGet(db, 'PRAGMA ' + name))[0]);
/** 版本记录里要换成固定值的列 */
const placeholders = new Map<string, string>(Object.entries(SNAPSHOT_PLACEHOLDERS));

const header = (applicationId: number) => `-- 业务库第 ${SNAPSHOT_VERSION} 版（0.9.0 基线）的结构快照：程序新建的空业务库是什么样，这份 SQL 就建出什么样。
-- 在一个全新的空库上整份执行，得到的库和程序新建的第 ${SNAPSHOT_VERSION} 版库完全一样：
-- 建表、索引、触发器、视图、预置数据、版本记录、application_id、auto_vacuum。
-- 用途：测试拿它当“从第 ${SNAPSHOT_VERSION} 版升级上来”的起点，核对一步步升级上来的库和程序新建的库结构完全一样。
--
-- 怎么生成：npm run schema:dump（scripts/schema-dump.ts，在内存里走 createSchema 建空库再导出）。
-- 输出是确定的，不带当前时间和程序版本：版本记录的 applied_at 固定写 '${SNAPSHOT_PLACEHOLDERS.applied_at}'、
-- app_version 固定写 '${SNAPSHOT_PLACEHOLDERS.app_version}'（结构比较不看这两列）。换行一律 LF。
-- 顺序：建表、索引、触发器、视图按 sqlite_schema 里的先后（建库时的先后）；数据的表也按这个先后，行按 rowid。
-- WAL 这类和文件、连接有关的设置不属于结构，不写在这里。
--
-- 0.9.0 发布前改了结构（server/core/schema/tables/）：运行 npm run schema:dump 重新导出，
-- 并把 tests/schema-evolution.test.ts 里这份文件的 sha256 换成新的。
-- 0.9.0 发布后这份文件不许再改；要改结构请在 server/core/schema/steps.ts 加升级步骤。

-- auto_vacuum 只能在建第一张表之前设；application_id 是本系统业务库的标识（0x${applicationId.toString(16).toUpperCase()}）
`;

/** 一张表的全部行，写成一行一条的 INSERT（值用 SQLite 的 quote() 转成字面量，生成列不写） */
function tableRows(db: DatabaseSync, table: string) {
  const columns = (db.prepare('PRAGMA table_xinfo(' + ident(table) + ')').all() as Row[]).filter((c) => Number(c.hidden) === 0);
  const list = mustGet(db, 'SELECT wr FROM pragma_table_list WHERE name=?', table);
  const order =
    Number(list.wr) === 1
      ? columns
          .filter((c) => Number(c.pk) > 0)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((c) => ident(String(c.name)))
          .join(',')
      : 'rowid';
  const names = columns.map((c) => String(c.name));
  const values = names.map((name) => {
    const fixed = table === 'schema_migrations' ? placeholders.get(name) : undefined;
    return fixed === undefined ? `quote(${ident(name)})` : `quote('${fixed}')`;
  });
  const rows = db.prepare(`SELECT ${values.join(',')} FROM ${ident(table)} ORDER BY ${order}`).all() as Row[];
  const head = `INSERT INTO ${ident(table)}(${names.map(ident).join(',')}) VALUES(`;
  return rows.map((row) => head + Object.values(row).map(String).join(',') + ');');
}

/** 内存里建一个空业务库，导出成第 20 版快照的全文 */
export function dumpSchemaSnapshot() {
  const store = new Store(':memory:');
  try {
    const db = store.db;
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version));
    if (versions.length !== 1 || versions[0] !== SNAPSHOT_VERSION)
      throw new Error(
        `当前程序新建的库是第 ${versions.join('、')} 版，不是第 ${SNAPSHOT_VERSION} 版：已经有升级步骤，不能再导出第 ${SNAPSHOT_VERSION} 版快照。` +
          `0.9.0 发布后 tests/fixtures/schema-v20.sql 不许改，要改结构请在 server/core/schema/steps.ts 加升级步骤。`,
      );
    const autoVacuum = AUTO_VACUUM[pragma(db, 'auto_vacuum')];
    const applicationId = pragma(db, 'application_id');
    const objects = db
      .prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all() as Row[];
    const out: string[] = [header(applicationId), `PRAGMA auto_vacuum=${autoVacuum};`, `PRAGMA application_id=${applicationId};`, ''];
    out.push('BEGIN;', '-- 外键在提交时统一检查，数据的先后不受外键限制', 'PRAGMA defer_foreign_keys=ON;', '');
    for (const object of objects) out.push(`-- ${object.type} ${object.name}`, String(object.sql) + ';', '');
    out.push('-- 预置数据和版本记录');
    for (const object of objects.filter((item) => item.type === 'table')) out.push(...tableRows(db, String(object.name)));
    out.push('', 'COMMIT;', '');
    const text = out.join('\n');
    if (text.includes('\r')) throw new Error('导出的内容里有回车符（\\r），换行必须统一是 LF');
    return text;
  } finally {
    store.close();
  }
}

function isMain() {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  // 同一个命令先按建表生成行结构（scripts/schema-rows.ts）：0.9.0 发布后快照不再导出（下面会报错），行结构照样跟着建表走
  console.log('已生成行结构：' + writeRowSchemas());
  // 配置库的基线快照（scripts/config-db-dump.ts）：只给还没有升级步骤的库导出
  for (const file of writeConfigBaselines()) console.log('已导出配置库基线快照：' + file);
  const target = resolve(process.argv[2] ?? SNAPSHOT_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, dumpSchemaSnapshot());
  console.log('已导出第 20 版结构快照：' + target);
}
