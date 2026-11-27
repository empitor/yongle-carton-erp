// 生成 docs/生成/表结构.md：业务库按 server/core/schema/tables/ 的分组拆建表语句和注释（和程序新建业务库同一套 SQL），
// 配置库见 config-db-doc.ts。说明全来自建表代码的注释，这里只放分节和开头几句。
import { z } from 'zod';
import { Store, count, many, schemaTableGroups } from '../../server/core/index.js';
import { configDatabaseLines, configTableNames } from './config-db-doc.js';
import { docHeader } from './markdown.js';
import { sqlParts } from './sql-parts.js';
import { sourceLines } from './table-doc.js';

export const SCHEMA_DOC = 'docs/生成/表结构.md';

type TableGroup = keyof typeof schemaTableGroups;
/** 业务库按业务分几节，每节含哪几个建表分组（新加的分组要在这里登记，不然生成时报错） */
const businessSections: { title: string; groups: TableGroup[] }[] = [
  { title: '基础', groups: ['migration', 'base'] },
  { title: '客户产品订单', groups: ['sales', 'marks'] },
  { title: '采购库存', groups: ['operations'] },
  { title: '单据流转', groups: ['flow'] },
  { title: '单据导出', groups: ['documents'] },
  { title: '识别导入', groups: ['import'] },
  { title: '助手', groups: ['assistant'] },
  { title: '财务', groups: ['financeLedger', 'financeDealings', 'financeCosts'] },
];

const HEADER = docHeader(
  '表结构',
  '加表、加字段、改约束或配置库之前，查现在每张表管什么、有哪些列和约束',
  '业务库来自 `server/core/schema/tables/` 的建表语句和写在每句前面的注释，配置库来自各库规格的 `create`。' +
    '要改说明就改那里的注释，再跑 `npm run docs:gen`；`tests/checks/docs-generated.test.ts` 核对这份是不是最新。',
);
const INTRO = [
  '- “说明”栏是建表语句括号里写在列、约束前面的注释。',
  '- 约定（STRICT、金额、编号、JSON 列）、派生关系、表归哪个模块，相关的见 `docs/架构/数据库约定.md`。',
  '',
];

/** 分组都登记进了某一节、没有重复 */
function checkSections() {
  const listed: string[] = businessSections.flatMap((section) => section.groups);
  const missing = Object.keys(schemaTableGroups).filter((group) => !listed.includes(group));
  const repeated = listed.filter((group, i) => listed.indexOf(group) !== i);
  if (missing.length || repeated.length)
    throw new Error(
      `建表分组要在 scripts/docs-gen/schema-doc.ts 的 businessSections 里正好登记一次：没登记 ${missing.join('、') || '无'}，重复 ${repeated.join('、') || '无'}`,
    );
}

const nameRow = z.object({ name: z.string() });
const versionRow = z.object({ version: z.number() });

/** 新库里有预置数据的表和行数（版本记录不算） */
function seedCounts(store: Store) {
  const names = many(store.db, nameRow, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid");
  return new Map(
    names
      .filter(({ name }) => name !== 'schema_migrations')
      .map(({ name }) => [name, count(store.db, `SELECT count(*) FROM "${name}"`)] as const)
      .filter(([, rows]) => rows > 0),
  );
}

function businessLines(store: Store, tableNames: ReadonlySet<string>) {
  const seeds = seedCounts(store);
  const versions = many(store.db, versionRow, 'SELECT version FROM schema_migrations ORDER BY version');
  const lines = ['## 业务库', '', `程序新建的业务库是第 ${versions.at(-1)?.version ?? 0} 版。`, ''];
  for (const section of businessSections) {
    const parts = section.groups.flatMap((group) => sqlParts(schemaTableGroups[group]));
    lines.push('### ' + section.title, '', ...sourceLines({ parts, db: store.db, seeds, tableNames }, '业务库' + section.title));
  }
  return lines;
}

/** 业务库的全部表名 */
const businessTableNames = () =>
  Object.values(schemaTableGroups).flatMap((sql) => sqlParts(sql).flatMap((part) => (part.kind === 'table' ? [part.name] : [])));

/** 表结构文档的全文 */
export function schemaDoc() {
  checkSections();
  const tableNames = new Set([...businessTableNames(), ...configTableNames()]);
  const store = new Store(':memory:');
  try {
    const lines = [...HEADER, ...INTRO, ...businessLines(store, tableNames), ...configDatabaseLines(tableNames)];
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  } finally {
    store.close();
  }
}
