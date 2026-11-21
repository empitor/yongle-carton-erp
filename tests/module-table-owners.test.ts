/**
 * 数据库表也按模块管（表的归属和说明见 docs/数据模型.md）：
 * - 写（INSERT、UPDATE、DELETE）：只有表的主人能写；别的模块要改，调它的接口（比如库存流水调 operations/ledger.ts）。
 *   例外只有 tableWriteExceptions 登记的几处，各写明原因。
 * - 读：顺着代码依赖读（能引用哪个模块，就能读它的表）；逆着读的登记在 tableReadExceptions，都是只读的派生数据。
 * - 新建的表要在这里登记属于哪个模块；登记了却没人建的表也拦。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { all, ownerModule, scriptKind } from './module-map.js';

const tableOwnerList: [module: string, tables: string][] = [
  ['基础', 'customers products orders order_lines business_audit schema_migrations users auth_events auth_sessions account_requests operation_requests number_sequences record_lifecycle permanent_record_deletions'],
  // 出错记录库（单独的 logs/problems.sqlite，server/core/diagnostics/problem-log.ts）
  ['基础', 'recent_problems'],
  ['采购库存', 'suppliers purchases purchase_lines stock_items stock_movements stock_movement_revisions order_batches order_batch_purchases'],
  // flow_ 开头的都归单据流转
  ['单据流转', 'purchase_returns'],
  ['业务汇总', 'product_marks mark_files'],
  ['识别导入', 'import_executions inbox_files inbox_items workspaces recognition_failures bots'],
  // 导出记录（文件内容和交付状态）、单据模板设置；订货批次的 export_id 指向导出记录，采购库存只存编号不读这张表
  ['单据导出', 'document_exports document_template_settings'],
  ['AI接入', 'prompt_settings ai_settings'],
  // assistant_ 开头的都归助手
  ['助手', 'tool_settings tool_settings_revision'],
];
/** SQLite 自己的自增计数表：只有升级执行器（server/core/schema/upgrade.ts）在重建表以后把计数补回去，业务代码只读 */
const sqliteSequence = 'sqlite_sequence';
const tableOwnerMap = new Map(tableOwnerList.flatMap(([m, list]) => list.split(' ').map((t) => [t, m] as const)));
const tableOwner = (t: string) =>
  t === sqliteSequence
    ? '基础'
    : tableOwnerMap.get(t) ??
      (t.startsWith('fin_') ? '财务' : t.startsWith('flow_') ? '单据流转' : t.startsWith('assistant_') ? '助手' : undefined);

// 删除记录、初始化也不例外：各模块登记自己的删除、初始化规则（server/core/deletion-rules.ts），
// 删除引擎、初始化只调登记的规则
const tableWriteExceptions: { path: string; why: string }[] = [
  { path: 'server/core/schema/', why: '业务库的建表（tables/ 按表的主人分文件）、预置数据和升级步骤：全局只有一条版本序列，表之间有跨模块外键，所以集中放在基础' },
];
const tableReadExceptions: { reader: string; owner: string; why: string }[] = [
  { reader: '财务', owner: '采购库存', why: '财务按表读业务数据生成凭证、成本和往来，不调用业务代码，只读' },
  { reader: '财务', owner: '单据流转', why: '同上' },
];

/**
 * 有的表除了归一个模块，还只许模块里的一个文件写：“哪些内容存在列里、哪些存在 JSON 里”的规矩集中在一处，别处不会漏。
 * deletion.ts 是登记给删除引擎的语句前缀和整表清空。
 */
const singleWriterTables: Record<string, string[]> = {
  // 采购明细关联的客户订单只存在 customer_order_id 列里，document 里不存
  purchase_lines: ['server/operations/ledger.ts', 'server/operations/deletion.ts'],
  // 单据表有 5 列是 document 里字段的镜像（计划日、送达日、订货批次、更正关系），列的值只在 document-store.ts 里从要写的内容算
  flow_documents: ['server/flow/document-store.ts', 'server/flow/deletion.ts'],
  // 识别原件的用途（kind）是列，不在 document 里；存原件、去掉原件里的内容都在 sources.ts
  flow_sources: ['server/flow/sources.ts', 'server/flow/deletion.ts'],
};

/**
 * 审计表（business_audit）只追加、只给人看，业务计算不读它：要算数的数据存进自己的表
 * （比如财务设置的变更历史在 fin_settings_history），以后审计才能归档。
 * 读它的文件登记在这里，写明读来做什么；新增读审计的地方会被下面的测试拦下。
 */
const auditReaders: { file: string; why: string }[] = [
  { file: 'server/business/record-context.ts', why: '记录的修改历史，展示' },
  { file: 'server/finance/audit-log.ts', why: '财务操作记录页，展示和筛选' },
  { file: 'server/admin/reset-archive.ts', why: '初始化后确认自己刚写的那条审计已经提交，再删原件归档；技术用途' },
];

type Facts = {
  writes: { table: string; line: number }[];
  dynamicWrites: number[];
  reads: { table: string; line: number }[];
  creates: string[];
};
const factsCache = new Map<string, Facts>();
/**
 * 取一个文件里的 SQL 读写（text 不给就读文件并记住结果）。只看字符串，不看注释；不分大小写（update、Update、UPDATE 一样）。
 * `+` 拼接、模板字符串先合成一段，拼进来的变量部分记作 \u0001，所以
 * (x ? 'INSERT OR IGNORE' : 'INSERT') + ' INTO 表' 认得出写的是“表”，'UPDATE ' + quote(t) + ' SET' 认得出表名是拼出来的。
 * 表名带引号（"t"、`t`、[t]）也认。
 */
function sqlFacts(f: string, text?: string): Facts {
  const cached = text === undefined ? factsCache.get(f) : undefined;
  if (cached) return cached;
  const source = ts.createSourceFile(f, text ?? readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(f));
  const strings: { text: string; line: number }[] = [];
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const isPlus = (n: ts.Node): n is ts.BinaryExpression => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const templateText = (n: ts.TemplateExpression) => n.head.text + n.templateSpans.map((s) => '\u0001' + s.literal.text).join('');
  const chain = (n: ts.Expression, parts: string[], rest: ts.Node[]) => {
    if (isPlus(n)) chain(n.left, parts, rest), chain(n.right, parts, rest);
    else if (ts.isParenthesizedExpression(n) && isPlus(n.expression)) chain(n.expression, parts, rest);
    else if (ts.isStringLiteralLike(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) parts.push(templateText(n)), n.templateSpans.forEach((s) => rest.push(s.expression));
    else parts.push('\u0001'), rest.push(n);
  };
  const visit = (n: ts.Node): void => {
    if (isPlus(n)) {
      const parts: string[] = [], rest: ts.Node[] = [];
      chain(n, parts, rest);
      strings.push({ text: parts.join(''), line: lineOf(n) });
      return rest.forEach(visit);
    }
    if (ts.isStringLiteralLike(n)) strings.push({ text: n.text, line: lineOf(n) });
    else if (ts.isTemplateExpression(n)) strings.push({ text: templateText(n), line: lineOf(n) });
    ts.forEachChild(n, visit);
  };
  visit(source);
  const name = '["`\\[]?([a-z_][a-z0-9_]*)';
  // ON UPDATE CASCADE、DO UPDATE SET 这类不是写表
  const notTable = new Set(['set', 'cascade', 'restrict', 'no']);
  const facts: Facts = { writes: [], dynamicWrites: [], reads: [], creates: [] };
  for (const s of strings) {
    for (const m of s.text.matchAll(new RegExp('\\b(?:into|update(?:\\s+or\\s+\\w+)?|delete\\s+from|drop\\s+(?:table|view)(?:\\s+if\\s+exists)?|alter\\s+table)\\s+' + name, 'gi')))
      if (!notTable.has(m[1].toLowerCase())) facts.writes.push({ table: m[1].toLowerCase(), line: s.line });
    if (/\b(?:into|update|delete\s+from|drop\s+table(?:\s+if\s+exists)?|alter\s+table)\s*["`[]?\u0001/i.test(s.text)) facts.dynamicWrites.push(s.line);
    for (const m of s.text.matchAll(new RegExp('\\b(?:from|join)\\s+' + name, 'gi'))) facts.reads.push({ table: m[1].toLowerCase(), line: s.line });
    for (const m of s.text.matchAll(new RegExp('\\bcreate\\s+(?:temp(?:orary)?\\s+)?(?:table|view)\\s+(?:if\\s+not\\s+exists\\s+)?' + name, 'gi')))
      facts.creates.push(m[1].toLowerCase());
  }
  if (text === undefined) factsCache.set(f, facts);
  return facts;
}

/** 一个服务端文件的读写违规（回归测试直接喂样例） */
function sqlViolations(f: string, facts = sqlFacts(f)) {
  const mod = ownerModule(f);
  const bad: string[] = [];
  const writeAny = tableWriteExceptions.some((e) => (e.path.endsWith('/') ? f.startsWith(e.path) : f === e.path));
  if (!writeAny) for (const line of facts.dynamicWrites) bad.push(f + ':' + line + '：表名是拼出来的写入，看不出写的是谁的表。把表名写成字面量，或改调表主人模块的接口');
  for (const w of facts.writes) {
    const owner = tableOwner(w.table);
    if (!owner) bad.push(f + ':' + w.line + '：写了没登记的表 ' + w.table + '。在本文件的 tableOwnerList 登记它归哪个模块');
    else if (owner !== mod.name && !writeAny) bad.push(f + ':' + w.line + '（' + mod.name + '）写 ' + w.table + '（' + owner + '）：表只由主人写，改调' + owner + '的接口去写');
  }
  if (f.startsWith('server/core/schema/') || mod.allow.includes('*')) return bad;
  for (const r of facts.reads) {
    const owner = tableOwner(r.table);
    if (!owner || owner === mod.name || mod.allow.includes(owner)) continue;
    if (tableReadExceptions.some((e) => e.reader === mod.name && e.owner === owner)) continue;
    bad.push(f + ':' + r.line + '（' + mod.name + '）逆着读 ' + r.table + '（' + owner + '）：只顺着依赖读，改成由' + owner + '的接口给数据（调用方传进来、低层定义接口高层登记）；确实要这样读的在 tableReadExceptions 写明原因');
  }
  return bad;
}

const serverFiles = all.filter((x) => x.startsWith('server/'));
const runtimeFiles = serverFiles.filter((x) => !x.startsWith('server/core/schema/'));

test('数据库表只由主人写，读只顺着代码依赖读（逆着读的都登记了原因）', () => {
  const bad = serverFiles.flatMap((f) => sqlViolations(f));
  assert.deepEqual([...new Set(bad)], []);
});

test('建的每张表都登记了主人，登记的每张表都还有人建（业务库和各配置库）', () => {
  const created = new Set(serverFiles.flatMap((f) => sqlFacts(f).creates));
  assert.deepEqual([...created].filter((t) => !tableOwner(t)), [], '新表要登记属于哪个模块');
  assert.deepEqual([...tableOwnerMap.keys()].filter((t) => !created.has(t)), [], '没人建的表要从登记里删掉');
});

test('只许一个文件写的表：采购明细只由 operations/ledger.ts 写，单据只由 flow/document-store.ts 写', () => {
  const bad: string[] = [];
  for (const f of runtimeFiles)
    for (const w of sqlFacts(f).writes)
      if (singleWriterTables[w.table] && !singleWriterTables[w.table].includes(f)) bad.push(f + ':' + w.line + ' 写 ' + w.table + '：这张表只许 ' + singleWriterTables[w.table].join('、') + ' 写，改调它的函数');
  assert.deepEqual(bad, []);
});

test('登记的逆向读表都还用得上', () => {
  const used = new Set<string>();
  for (const f of runtimeFiles) {
    const mod = ownerModule(f).name;
    for (const r of sqlFacts(f).reads) {
      const owner = tableOwner(r.table);
      if (owner && owner !== mod) used.add(mod + ' → ' + owner);
    }
  }
  assert.deepEqual(
    tableReadExceptions.filter((e) => !used.has(e.reader + ' → ' + e.owner)).map((e) => e.reader + ' → ' + e.owner + '：已经没有这样读了，从 tableReadExceptions 删掉'),
    [],
  );
});

const auditReadersOf = (files: readonly string[], facts = sqlFacts) =>
  files.filter((f) => facts(f).reads.some((r) => r.table === 'business_audit'));
test('审计表不当业务数据读：读 business_audit 的文件都登记了用途', () => {
  const readers = auditReadersOf(runtimeFiles);
  const listed = new Set(auditReaders.map((r) => r.file));
  assert.deepEqual(
    readers.filter((f) => !listed.has(f)),
    [],
    '业务计算不读审计：要用的数据存进自己的表；确实只是展示或技术用途的，登记到 auditReaders 并写明读来做什么',
  );
  assert.deepEqual([...listed].filter((f) => !readers.includes(f)), [], '登记了却不再读审计的条目要删掉');
  // 回归：检查器认得出读审计的写法（拼接、JOIN、小写），写审计不算读
  const sample = (text: string) => auditReadersOf(['server/operations/sample.ts'], (f) => sqlFacts(f, text)).length;
  assert.equal(sample("db.prepare(\"SELECT * FROM business_audit WHERE action='receipt-data-edit'\" + (scoped ? ' AND 1' : '')).all()"), 1);
  assert.equal(sample("db.prepare('select a.at from fin_events e join business_audit a on a.record_id=e.id').all()"), 1);
  assert.equal(sample("db.prepare('INSERT INTO business_audit(at,actor_id) VALUES(?,?)').run(at, id)"), 0);
});

test('回归：SQL 读写检查不分大小写，认得出带引号的表名、拼出来的动词和表名，合法写法和登记的例外不误报', () => {
  const sqlCheck = (f: string, text: string) => sqlViolations(f, sqlFacts(f, text));
  const blocked = [
    "db.prepare('update fin_events set status=1')",
    "db.prepare('UPDATE fin_events SET status=1')",
    "db.prepare('Delete From \"fin_events\" where id=?')",
    "db.prepare('insert or ignore into `fin_events` values(?)')",
    "db.prepare('update [fin_events] set a=1')",
    "db.prepare((x ? 'INSERT OR IGNORE' : 'INSERT') + ' INTO fin_events VALUES(?)')",
    "db.prepare('UPDATE ' + quote(table) + ' SET a=1')",
    'db.prepare(`delete from ${table} where id=?`)',
    "db.prepare('DELETE FROM \"' + name + '\"')",
    "db.prepare('select * from fin_events')",
    "db.prepare('insert into no_such_table values(1)')",
    "db.exec('DROP TABLE IF EXISTS fin_events')",
    "db.exec('alter table fin_events add column x text')",
  ];
  for (const s of blocked) assert.ok(sqlCheck('server/flow/sample.ts', s).length, '单据流转里应拦住：' + s);
  const allowed = [
    "db.prepare('update flow_documents set version=version+1 where id=?')",
    "db.prepare('INSERT INTO flow_refs(document_id) VALUES(?) ON CONFLICT(document_id) DO UPDATE SET document_id=excluded.document_id')",
    "db.prepare('select quantity from stock_movements where id=?')",
    '// UPDATE fin_events SET a=1 只是注释\nconst x = 1;',
    "throw new Error('请先刷新再更新');",
  ];
  for (const s of allowed) assert.deepEqual(sqlCheck('server/flow/sample.ts', s), [], '单据流转里不该拦：' + s);
  // 登记的例外只有建表和升级步骤（server/core/schema/），照样放行
  assert.deepEqual(sqlCheck('server/core/schema/steps.ts', "db.exec('update purchases set version=1')"), []);
  assert.deepEqual(sqlCheck('server/core/schema/tables/sample.ts', "export const t = 'CREATE TABLE fin_sample(id INTEGER PRIMARY KEY); INSERT INTO fin_settings(id) VALUES(1);'"), []);
  // 数据库连接（Store）不整个文件免查：运行时只能写基础自己的表，按表名拼出来的写入也拦
  assert.ok(sqlCheck('server/core/db.ts', "db.exec('update purchases set version=1')").length, 'Store 写采购库存的表');
  assert.ok(sqlCheck('server/core/db.ts', "db.prepare('INSERT OR REPLACE INTO ' + table + ' VALUES(?,?)')").length, 'Store 按表名写');
  assert.deepEqual(sqlCheck('server/core/db.ts', "db.prepare('UPDATE orders SET version=version+1 WHERE id=?')"), []);
  // 删除和初始化不例外：删除引擎、初始化按表名写、写别的模块的表都拦（要调各模块登记的规则）
  assert.ok(sqlCheck('server/business/database-maintenance.ts', "db.prepare('UPDATE ' + quote(t) + ' SET a=1')").length, '删除引擎按表名写');
  assert.ok(sqlCheck('server/admin/business-reset.ts', "db.prepare('update fin_settings set a=1')").length, '初始化写财务的表');
  assert.ok(sqlCheck('server/admin/business-reset.ts', "db.prepare('DELETE FROM \"' + name + '\"')").length, '初始化按表名清空');
  assert.ok(sqlCheck('server/admin/data-management-service.ts', "db.prepare('DELETE FROM order_lines WHERE order_id=?')").length, '数据管理删基础的表');
  assert.ok(sqlCheck('server/admin/workspace-management.ts', "db.prepare('update flow_documents set a=1')").length, '数据管理的其他文件');
  // 读也逐张查：数据管理读财务、助手的表都拦（初始化前查已结账期间由财务自己说）
  assert.ok(sqlCheck('server/admin/business-reset.ts', "db.prepare('select 1 from fin_periods where closed=1')").length, '数据管理逆着读财务的表');
  assert.ok(sqlCheck('server/admin/workspace-management.ts', "db.prepare('select * from assistant_messages')").length, '数据管理逆着读助手的表');
  // 表的主人在自己的删除规则里写自己的表不拦
  assert.deepEqual(sqlCheck('server/operations/deletion.ts', "db.prepare('DELETE FROM stock_movements WHERE rowid=?')"), []);
  assert.deepEqual(sqlCheck('server/flow/sample.ts', "db.exec('drop table if exists flow_tmp')"), [], '删自己的表不拦');
  // 建表要登记归属
  assert.deepEqual(sqlFacts('server/flow/sample.ts', "db.exec('create table if not exists \"flow_new\"(id integer)')").creates, ['flow_new']);
});
