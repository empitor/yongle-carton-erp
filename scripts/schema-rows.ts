// 按建表生成每张表的 zod 行结构：server/core/schema/rows.ts（汇总）和 rows/ 下的几份。读库时校验用（server/core/storage/sqlite/sql.ts）。
// 由 npm run schema:dump 一起生成（scripts/schema-dump.ts 调这里），守它的测试在 tests/schema-evolution.test.ts。
//
// - 业务库按 server/core/schema/tables/ 的分组依次建一遍，按分组写进几份文件（一份不超过 500 行）；
// - 配置库（账号、AI 设置、提示词、助手工具设置、机器人设置、识别工作区、出错记录）按各主人模块登记的规格
//   （registerVersionedSqlite）在内存里建一遍，写进 rows/config-db.ts。主人模块加载时才登记，所以下面把它们加载进来；
// - 类型按声明的列类型：INTEGER、REAL 是 number，TEXT 是 string，BLOB 是 Uint8Array；NOT NULL 和主键以外的列可空；
// - 输出是确定的：表按建表先后，列按定义先后，配置库按中文名排；换行一律 LF。
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openVersionedSqlite, registeredVersionedSqlite, schemaTableGroups } from '../server/core/index.js';
// 这几个模块加载时登记各自的配置库规格（出错记录库随 core 一起登记）
import '../server/accounts/index.js';
import '../server/ai/index.js';
import '../server/assistant/index.js';
import '../server/import/index.js';
import '../server/inbox/index.js';

/** 行结构文件放在哪：rows.ts 汇总，rows/ 下按分组各一份 */
export const ROWS_DIRECTORY = fileURLToPath(new URL('../server/core/schema/', import.meta.url));
type TableGroup = keyof typeof schemaTableGroups;
/** 业务库的表按 tables/ 的分组写进哪份文件（新加的分组要在这里登记，不然生成时报错） */
const businessRowFiles: { file: string; name: string; title: string; groups: TableGroup[] }[] = [
  {
    file: 'business-db',
    name: 'businessRows',
    title: '业务库（财务以外）',
    groups: ['migration', 'sales', 'base', 'operations', 'flow', 'documents', 'marks', 'import', 'assistant'],
  },
  { file: 'finance-db', name: 'financeRows', title: '业务库的财务', groups: ['financeLedger', 'financeDealings', 'financeCosts'] },
];
const CONFIG_FILE = { file: 'config-db', name: 'configRows', title: '配置库（各自一个文件，不在业务库里）' };
const HEADER =
  '// 由 scripts/schema-rows.ts 按建表生成（npm run schema:dump），不要手改；tests/schema-evolution.test.ts 核对它和建表一致。';

const columnInfo = z.object({ name: z.string(), type: z.string(), notnull: z.number(), pk: z.number(), hidden: z.number() });
/** 声明的列类型 → zod 结构 */
const zodTypes = new Map([
  ['INTEGER', 'z.number()'],
  ['REAL', 'z.number()'],
  ['TEXT', 'z.string()'],
  ['BLOB', 'z.instanceof(Uint8Array)'],
]);
const ident = (name: string) => (/^[a-z_][a-z0-9_]*$/i.test(name) ? name : '"' + name.replaceAll('"', '""') + '"');
const key = (name: string) => (/^[a-z_$][a-z0-9_$]*$/i.test(name) ? name : JSON.stringify(name));
const tableNames = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
    .all()
    .map((row) => z.string().parse(row.name));

/** 一张表的行结构（几行代码）。虚拟表的隐藏列不要，生成列要（查得出来） */
function tableSchema(db: DatabaseSync, table: string) {
  const columns = z
    .array(columnInfo)
    .parse(db.prepare('PRAGMA table_xinfo(' + ident(table) + ')').all())
    .filter((column) => column.hidden !== 1);
  const lines = [`  ${key(table)}: z.object({`];
  for (const column of columns) {
    const type = zodTypes.get(column.type.toUpperCase());
    if (!type)
      throw new Error(
        `表 ${table} 的列 ${column.name} 声明的类型是“${column.type}”，生成不了行结构：列类型要写成 INTEGER、REAL、TEXT 或 BLOB`,
      );
    lines.push(`    ${key(column.name)}: ${type}${column.notnull || column.pk ? '' : '.nullable()'},`);
  }
  lines.push('  }),');
  return lines;
}

type Section = { comment: string; db: DatabaseSync; tables: string[] };
/** 一份行结构文件的全文。seen 记已经生成过的表名，重名就报错（行结构按表名取） */
function rowFile(part: { name: string; title: string }, sections: Section[], seen: Set<string>) {
  const out = [
    HEADER,
    '// 类型按声明的列类型：INTEGER、REAL 是 number，TEXT 是 string，BLOB 是 Uint8Array；NOT NULL 和主键以外的列可空。',
    "import { z } from 'zod';",
    '',
    `/** ${part.title}：一张表一个行结构 */`,
    `export const ${part.name} = {`,
  ];
  for (const section of sections) {
    out.push(`  // ${section.comment}`);
    for (const table of section.tables) {
      if (seen.has(table)) throw new Error(`表名 ${table} 重复了（两个库里各有一张），行结构按表名取，要改名`);
      seen.add(table);
      out.push(...tableSchema(section.db, table));
    }
  }
  out.push('};', '');
  return out.join('\n');
}

/** 业务库：按 tables/ 的分组依次建表（和 createSchema 同一个先后），记下每组新建了哪些表 */
function businessGroups(db: DatabaseSync) {
  const byGroup = new Map<string, string[]>();
  for (const [group, sql] of Object.entries(schemaTableGroups)) {
    const before = new Set(tableNames(db));
    db.exec(sql);
    byGroup.set(
      group,
      tableNames(db).filter((table) => !before.has(table)),
    );
  }
  const listed = new Set<string>(businessRowFiles.flatMap((file) => file.groups));
  const missing = [...byGroup.keys()].filter((group) => !listed.has(group));
  if (missing.length)
    throw new Error(`建表分组 ${missing.join('、')} 没登记写进哪份行结构文件（scripts/schema-rows.ts 的 businessRowFiles）`);
  return byGroup;
}

/** rows.ts：把几份合成一张“表名 → 行结构”的表 */
function rowsIndex() {
  const parts = [...businessRowFiles, CONFIG_FILE];
  return [
    HEADER,
    "import type { z } from 'zod';",
    ...parts.map((part) => `import { ${part.name} } from './rows/${part.file}.js';`),
    '',
    '/**',
    ' * 每张表的行结构，按表名取（rows.customers）。别名、联表、聚合在调用处用 rows.x.pick({…}).extend({…}) 组；',
    ' * 读库用 server/core/storage/sqlite/sql.ts 的 one、many。',
    ' */',
    `export const rows = { ${parts.map((part) => '...' + part.name).join(', ')} };`,
    "/** 每张表一行的类型：Rows['customers'] */",
    'export type Rows = { [K in keyof typeof rows]: z.infer<(typeof rows)[K]> };',
    '',
  ].join('\n');
}

/** 生成全部行结构文件：path 是相对 server/core/schema/ 的路径（正斜杠），text 是全文 */
export function rowSchemaFiles() {
  const seen = new Set<string>();
  const files: { path: string; text: string }[] = [];
  const business = new DatabaseSync(':memory:');
  const configs = registeredVersionedSqlite()
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .map((spec) => ({ spec, db: openVersionedSqlite(':memory:', spec) }));
  try {
    const byGroup = businessGroups(business);
    for (const part of businessRowFiles) {
      const sections = part.groups.map((group) => ({
        comment: `${group}（server/core/schema/tables/ 的这一组）`,
        db: business,
        tables: byGroup.get(group) ?? [],
      }));
      files.push({ path: `rows/${part.file}.ts`, text: rowFile(part, sections, seen) });
    }
    const sections = configs.map(({ spec, db }) => ({ comment: spec.label, db, tables: tableNames(db) }));
    files.push({ path: `rows/${CONFIG_FILE.file}.ts`, text: rowFile(CONFIG_FILE, sections, seen) });
  } finally {
    business.close();
    for (const { db } of configs) db.close();
  }
  files.push({ path: 'rows.ts', text: rowsIndex() });
  return files;
}

/** 把行结构写进 server/core/schema/，返回 rows.ts 的位置 */
export function writeRowSchemas() {
  for (const file of rowSchemaFiles()) {
    const target = join(ROWS_DIRECTORY, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
  }
  return join(ROWS_DIRECTORY, 'rows.ts');
}
