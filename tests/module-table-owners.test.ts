/**
 * 数据库表也按模块管（表的归属和说明见 docs/数据模型.md）：
 * - 写（INSERT、UPDATE、DELETE）：只有表的主人能写；别的模块要改，调它的接口（比如库存流水调 operations/ledger.ts）。
 *   例外只有 tableWriteExceptions 登记的几处，各写明原因。
 * - 读：顺着代码依赖读（能引用哪个模块，就能读它的表），没有逆着读的例外。
 *   财务更严：SQL 只读自己的 fin_ 表和审计表，业务数据（连基础的 customers、orders、record_lifecycle）一律经只读窗口拿。
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
  {
    path: 'server/core/schema/',
    why:
      '业务库的建表（tables/ 按表的主人分文件）、预置数据和升级步骤：全局只有一条版本序列，表之间有跨模块外键，所以集中放在基础。' +
      '升级步骤改 CHECK 用 steps.ts 的 rebuildTable 重建（表名拼出来）：临时表 <表>_rebuilt 建完即改回原名，不是新表',
  },
];
/**
 * 财务的 SQL 只许读这些表：自己的 fin_ 表，和基础的审计表（只给财务操作记录页展示，见 auditReaders）。
 * 业务数据（单据流转、采购库存的表，基础的 customers、orders、record_lifecycle）一律经只读窗口 financeFacts 拿
 * （server/flow/finance-facts/，docs/架构说明.md“财务事件和凭证”），业务改表时财务一行不用动。
 * 不是表的名字（json_each、WITH 起的名字）不算。FROM、JOIN 后表名位置是拼进来的，看不出读谁，也报；
 * 拼的是财务自己的 SQL 片段（片段的文字也在财务文件里，同样受这条查）或类型只收 fin_ 表的表名，按“哪个文件拼的什么”登记在 financeDynamicReads。
 */
const financeSqlPath = 'server/finance/';
const financeReadable = (table: string) => table.startsWith('fin_') || table === 'business_audit';
const financeDynamicReads: { file: string; splice: string; why: string }[] = [
  { file: 'server/finance/query.ts', splice: 'table', why: 'row() 按编号取财务表的一行：表名参数的类型 FinanceIdTable 只收 fin_ 开头、有 id 列的表，业务表编译不过' },
  { file: 'server/finance/deposits-interest.ts', splice: 'effectiveInterest', why: '本文件的 SQL 片段：有效的压款利息（fin_ 表）' },
  { file: 'server/finance/obligation-sql.ts', splice: 'allocations', why: '本文件的 SQL 片段：往来的核销（fin_ 表）' },
  { file: 'server/finance/invoice-matching.ts', splice: 'snapshotLines', why: 'source-snapshot.ts 的片段：事件快照明细的 json_each' },
  { file: 'server/finance/overview.ts', splice: 'snapshotLines', why: 'source-snapshot.ts 的片段：事件快照明细的 json_each' },
];

/** 只读的目录：里面一处写 SQL 都不许有，自己模块的表也不许写。财务从业务拿数据的窗口（docs/架构说明.md“财务事件和凭证”） */
const readOnlyPaths = ['server/flow/finance-facts/'];

/**
 * 有的表除了归一个模块，还只许模块里的一个文件写：“哪些内容存在列里、哪些存在 JSON 里”的规矩集中在一处，别处不会漏。
 * deletion.ts 是登记给删除引擎的语句前缀和整表清空。
 */
const singleWriterTables: Record<string, string[]> = {
  // 采购明细关联的客户订单只存在 customer_order_id 列里，document 里不存
  purchase_lines: ['server/operations/ledger/ledger.ts', 'server/operations/deletion.ts'],
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

/**
 * 助手只读自己的表（assistant_ 开头的、助手的配置库）：业务数据一律经各模块的读函数和服务拿，表名拼出来的读也算
 * （docs/架构说明.md“助手”）。SQLite 自己的伪表（pragma_ 开头、json_each）不是谁的表；别的例外登记在这里，写明原因。
 */
const assistantReadExceptions: { table: string; why: string }[] = [];
const sqliteOwn = (t: string) => t.startsWith('pragma_') || t === 'json_each';

type Facts = {
  writes: { table: string; line: number }[];
  dynamicWrites: number[];
  reads: { table: string; line: number }[];
  /** 表名位置是拼进来的读：拼进来的是什么（表达式开头的名字） */
  dynamicReads: { splice: string; line: number }[];
  /** 交给读写库函数（one、many、count、exists、prepare、exec）的 SQL 不是本文件写的（别处导入的、参数传进来的、函数算出来的） */
  foreignSql: { sql: string; line: number }[];
  creates: string[];
};

/** FROM 后的表清单到这里结束：括号外遇到这些词 */
const fromListEnd = /\s+(?:where|join|inner|left|right|cross|full|natural|outer|group|order|limit|having|union|except|intersect|window|on|using|returning|select)\b/iy;
/** 看一项开头的多少个字就够认出表名（空白、库名、引号、表名） */
const ITEM_HEAD = 200;
/** 一项开头的表名，带库名（main.t、"main"."t"）的取点后面的 */
const qualifiedTable = /^(?:["`[]?[a-z_][a-z0-9_]*["`\]]?\s*\.\s*)?["`[]?([a-z_][a-z0-9_]*)/i;

/** FROM 后面那段表清单（从 from 起，到括号外的右括号、分号、WHERE、JOIN 这类词为止），按括号外的逗号切开，给每一项的起点 */
function fromList(sql: string, from: number): number[] {
  const starts = [from];
  let depth = 0;
  for (let i = from; i < sql.length; i++) {
    const c = sql[i];
    if (depth === 0 && (c === ')' || c === ';')) break;
    if (depth === 0 && /\s/.test(c)) {
      fromListEnd.lastIndex = i;
      if (fromListEnd.test(sql)) break;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) starts.push(i + 1);
  }
  return starts;
}

/**
 * 一段 SQL 读的表：JOIN 后的那一项、FROM 后逗号分开的每一项（FROM a x, b y），带库名的取表名（main.t）；
 * 括号开头的子查询由它里面的 FROM 自己取。表名位置是拼进来的（\u0001），记下拼进来的是什么（splices 里同位置的名字）。
 */
function sqlReads(sql: string, splices: readonly string[]) {
  const tables: string[] = [];
  const dynamic: string[] = [];
  const item = (at: number) => {
    const p = sql.slice(at, at + ITEM_HEAD).trimStart();
    if (/^["`[]?\u0001/.test(p)) dynamic.push(splices[sql.slice(0, sql.indexOf('\u0001', at)).split('\u0001').length - 1] ?? '?');
    const m = qualifiedTable.exec(p);
    if (m) tables.push(m[1].toLowerCase());
  };
  for (const m of sql.matchAll(/\bjoin\s+/gi)) item(m.index + m[0].length);
  for (const m of sql.matchAll(/\bfrom\s+/gi)) fromList(sql, m.index + m[0].length).forEach(item);
  return { tables, dynamic };
}
const isPlus = (n: ts.Node): n is ts.BinaryExpression => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
/** 字符串的 .concat(…)：接在本文件写出来的 SQL 文字后面的才算（数组的 concat 不算） */
const isConcat = (n: ts.Node): n is ts.CallExpression & { expression: ts.PropertyAccessExpression } =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'concat' && writtenSql(n.expression.expression);
/** 本文件里写出来的 SQL 文字：字面量、模板、+ 拼接（有一段是写出来的）、字符串的 concat、两边都是这些的 ?: */
function writtenSql(n: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(n)) return writtenSql(n.expression);
  if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) return true;
  if (isPlus(n)) return writtenSql(n.left) || writtenSql(n.right);
  if (ts.isConditionalExpression(n)) return writtenSql(n.whenTrue) && writtenSql(n.whenFalse);
  return isConcat(n);
}
/** 读写库的函数和 SQL 是第几个参数：server/core 的 one、many 第 3 个，count、exists 第 2 个（按引入时的原名认，改了名也认） */
const SQL_ARG: Record<string, number> = { one: 2, many: 2, count: 1, exists: 1 };
/**
 * 交给读写库函数的 SQL 不是本文件写的：one、many、count、exists 和库连接（…db）的 prepare、exec，SQL 参数既不是写出来的文字，
 * 也不是本文件里用写出来的文字定义的常量（别处导入的 SQL、参数传进来的、函数算出来的）。这种读看不出读的是谁的表。
 */
function foreignSql(source: ts.SourceFile): Facts['foreignSql'] {
  const helpers = new Map<string, number>(),
    written = new Set<string>(),
    found: Facts['foreignSql'] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && Object.hasOwn(SQL_ARG, (n.propertyName ?? n.name).text)) helpers.set(n.name.text, SQL_ARG[(n.propertyName ?? n.name).text]);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && writtenSql(n.initializer)) written.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  const sqlAt = (callee: ts.Expression) => {
    if (ts.isIdentifier(callee)) return helpers.get(callee.text);
    const onDb = ts.isPropertyAccessExpression(callee) && /\bdb$/.test(callee.expression.getText(source));
    return onDb && ['prepare', 'exec'].includes(callee.name.text) ? 0 : undefined;
  };
  const check = (n: ts.Node): void => {
    const at = ts.isCallExpression(n) ? sqlAt(n.expression) : undefined;
    const arg = at === undefined || !ts.isCallExpression(n) ? undefined : n.arguments[at];
    if (arg && !writtenSql(arg) && !(ts.isIdentifier(arg) && written.has(arg.text)))
      found.push({ sql: arg.getText(source), line: source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1 });
    ts.forEachChild(n, check);
  };
  collect(source);
  check(source);
  return found;
}
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
  const strings: { text: string; line: number; splices: string[] }[] = [];
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const templateText = (n: ts.TemplateExpression) => n.head.text + n.templateSpans.map((s) => '\u0001' + s.literal.text).join('');
  /** 拼进来的是什么：表达式开头的名字（snapshotLines('e.snapshot') 记 snapshotLines，this.t 记 this.t） */
  const spliceName = (e: ts.Node) => /^[\w.$]+/.exec(e.getText(source))?.[0] ?? '?';
  const chain = (n: ts.Expression, parts: string[], rest: ts.Node[]) => {
    if (isPlus(n)) chain(n.left, parts, rest), chain(n.right, parts, rest);
    else if (isConcat(n)) [n.expression.expression, ...n.arguments].forEach((a) => chain(a, parts, rest));
    else if (ts.isParenthesizedExpression(n) && (isPlus(n.expression) || isConcat(n.expression))) chain(n.expression, parts, rest);
    else if (ts.isStringLiteralLike(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) parts.push(templateText(n)), n.templateSpans.forEach((s) => rest.push(s.expression));
    else parts.push('\u0001'), rest.push(n);
  };
  const visit = (n: ts.Node): void => {
    if (isPlus(n) || isConcat(n)) {
      const parts: string[] = [], rest: ts.Node[] = [];
      chain(n, parts, rest);
      strings.push({ text: parts.join(''), line: lineOf(n), splices: rest.map(spliceName) });
      return rest.forEach(visit);
    }
    if (ts.isStringLiteralLike(n)) strings.push({ text: n.text, line: lineOf(n), splices: [] });
    else if (ts.isTemplateExpression(n))
      strings.push({ text: templateText(n), line: lineOf(n), splices: n.templateSpans.map((s) => spliceName(s.expression)) });
    ts.forEachChild(n, visit);
  };
  visit(source);
  const name = '["`\\[]?([a-z_][a-z0-9_]*)';
  // ON UPDATE CASCADE、DO UPDATE SET 这类不是写表
  const notTable = new Set(['set', 'cascade', 'restrict', 'no']);
  const facts: Facts = { writes: [], dynamicWrites: [], reads: [], dynamicReads: [], foreignSql: foreignSql(source), creates: [] };
  for (const s of strings) {
    for (const m of s.text.matchAll(new RegExp('\\b(?:into|update(?:\\s+or\\s+\\w+)?|delete\\s+from|drop\\s+(?:table|view)(?:\\s+if\\s+exists)?|alter\\s+table)\\s+' + name, 'gi')))
      if (!notTable.has(m[1].toLowerCase())) facts.writes.push({ table: m[1].toLowerCase(), line: s.line });
    if (/\b(?:into|update|delete\s+from|drop\s+table(?:\s+if\s+exists)?|alter\s+table)\s*["`[]?\u0001/i.test(s.text)) facts.dynamicWrites.push(s.line);
    const read = sqlReads(s.text, s.splices);
    for (const table of read.tables) facts.reads.push({ table, line: s.line });
    for (const splice of read.dynamic) facts.dynamicReads.push({ splice, line: s.line });
    for (const m of s.text.matchAll(new RegExp('\\bcreate\\s+(?:temp(?:orary)?\\s+)?(?:table|view)\\s+(?:if\\s+not\\s+exists\\s+)?' + name, 'gi')))
      facts.creates.push(m[1].toLowerCase());
  }
  if (text === undefined) factsCache.set(f, facts);
  return facts;
}

/** 财务文件的读：只许 fin_ 表和 business_audit；拼表名的读只许登记过的文件 */
function financeReadViolations(f: string, facts: Facts) {
  const bad: string[] = [];
  for (const r of facts.reads) {
    const owner = tableOwner(r.table);
    if (owner && !financeReadable(r.table)) bad.push(f + ':' + r.line + '（财务）读 ' + r.table + '（' + owner + '）：财务的 SQL 只读 fin_ 表和 business_audit，业务数据在 server/flow/finance-facts/ 加只读函数、经 financeFacts 拿');
  }
  for (const d of facts.dynamicReads)
    if (!financeDynamicReads.some((e) => e.file === f && e.splice === d.splice))
      bad.push(f + ':' + d.line + '（财务）读的表名位置拼进来的是 ' + d.splice + '，看不出读的是不是 fin_ 表：把表名写成字面量；拼的确实是财务自己的 SQL 片段或只收 fin_ 表的表名的，在 financeDynamicReads 写明原因');
  return bad;
}

/** 一个服务端文件的读写违规（回归测试直接喂样例） */
function sqlViolations(f: string, facts = sqlFacts(f)) {
  const mod = ownerModule(f);
  const bad: string[] = [];
  const writeAny = tableWriteExceptions.some((e) => (e.path.endsWith('/') ? f.startsWith(e.path) : f === e.path));
  if (readOnlyPaths.some((p) => f.startsWith(p)))
    for (const line of [...facts.writes.map((w) => w.line), ...facts.dynamicWrites])
      bad.push(f + ':' + line + '：只读目录里写了库。这里只给数据，要改数据调表主人模块的服务');
  if (!writeAny) for (const line of facts.dynamicWrites) bad.push(f + ':' + line + '：表名是拼出来的写入，看不出写的是谁的表。把表名写成字面量，或改调表主人模块的接口');
  for (const w of facts.writes) {
    const owner = tableOwner(w.table);
    if (!owner) bad.push(f + ':' + w.line + '：写了没登记的表 ' + w.table + '。在本文件的 tableOwnerList 登记它归哪个模块');
    else if (owner !== mod.name && !writeAny) bad.push(f + ':' + w.line + '（' + mod.name + '）写 ' + w.table + '（' + owner + '）：表只由主人写，改调' + owner + '的接口去写');
  }
  if (f.startsWith(financeSqlPath)) bad.push(...financeReadViolations(f, facts));
  if (f.startsWith('server/core/schema/') || mod.allow.includes('*')) return bad;
  for (const r of facts.reads) {
    const owner = tableOwner(r.table);
    if (!owner || owner === mod.name || mod.allow.includes(owner)) continue;
    bad.push(f + ':' + r.line + '（' + mod.name + '）逆着读 ' + r.table + '（' + owner + '）：只顺着依赖读，改成由' + owner + '的接口给数据（调用方传进来、低层定义接口高层登记）');
  }
  return bad;
}

const serverFiles = all.filter((x) => x.startsWith('server/'));
const runtimeFiles = serverFiles.filter((x) => !x.startsWith('server/core/schema/'));

test('数据库表只由主人写，读只顺着代码依赖读，财务的 SQL 只读 fin_ 表和审计表', () => {
  const bad = serverFiles.flatMap((f) => sqlViolations(f));
  assert.deepEqual([...new Set(bad)], []);
});

test('建的每张表都登记了主人，登记的每张表都还有人建（业务库和各配置库）', () => {
  const created = new Set(serverFiles.flatMap((f) => sqlFacts(f).creates));
  assert.deepEqual([...created].filter((t) => !tableOwner(t)), [], '新表要登记属于哪个模块');
  assert.deepEqual([...tableOwnerMap.keys()].filter((t) => !created.has(t)), [], '没人建的表要从登记里删掉');
});

test('只许一个文件写的表：采购明细只由 operations/ledger/ledger.ts 写，单据只由 flow/document-store.ts 写', () => {
  const bad: string[] = [];
  for (const f of runtimeFiles)
    for (const w of sqlFacts(f).writes)
      if (singleWriterTables[w.table] && !singleWriterTables[w.table].includes(f)) bad.push(f + ':' + w.line + ' 写 ' + w.table + '：这张表只许 ' + singleWriterTables[w.table].join('、') + ' 写，改调它的函数');
  assert.deepEqual(bad, []);
});

test('财务登记的拼表名读取都还用得上', () => {
  const used = (e: { file: string; splice: string }) => all.includes(e.file) && sqlFacts(e.file).dynamicReads.some((d) => d.splice === e.splice);
  assert.deepEqual(
    financeDynamicReads.filter((e) => !used(e)).map((e) => e.file + ' 的 ' + e.splice + '：已经不这样拼了，从 financeDynamicReads 删掉'),
    [],
  );
});

const auditReadersOf =(files: readonly string[], facts = sqlFacts) =>
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
  assert.ok(sqlCheck('server/lifecycle/database-maintenance.ts', "db.prepare('UPDATE ' + quote(t) + ' SET a=1')").length, '删除引擎按表名写');
  assert.ok(sqlCheck('server/admin/business-reset.ts', "db.prepare('update fin_settings set a=1')").length, '初始化写财务的表');
  assert.ok(sqlCheck('server/admin/business-reset.ts', "db.prepare('DELETE FROM \"' + name + '\"')").length, '初始化按表名清空');
  assert.ok(sqlCheck('server/admin/data-management-service.ts', "db.prepare('DELETE FROM order_lines WHERE order_id=?')").length, '数据管理删基础的表');
  assert.ok(sqlCheck('server/admin/workspace-management.ts', "db.prepare('update flow_documents set a=1')").length, '数据管理的其他文件');
  // 读也逐张查：数据管理读财务、助手的表都拦（初始化前查已结账期间由财务自己说）
  assert.ok(sqlCheck('server/admin/business-reset.ts', "db.prepare('select 1 from fin_periods where closed=1')").length, '数据管理逆着读财务的表');
  assert.ok(sqlCheck('server/admin/workspace-management.ts', "db.prepare('select * from assistant_messages')").length, '数据管理逆着读助手的表');
  // 财务只读 fin_ 表和审计表：业务表（连基础的客户、订单、记录状态）顺着依赖也不许直接读，要经只读窗口
  for (const s of [
    "db.prepare('SELECT document FROM flow_documents WHERE id=?')",
    "db.prepare('select e.id from fin_events e join customers c on c.id=e.party_id')",
    "db.prepare(`SELECT id FROM orders WHERE created_at>=${from}`)",
    "db.prepare('SELECT 1 FROM record_lifecycle WHERE record_id=?')",
    "db.prepare('SELECT quantity FROM stock_movements')",
    // 逗号连接的第二、三项，带库名，括号里的子查询，表名拼出来的
    "db.prepare('SELECT e.id FROM fin_events e, flow_documents f WHERE f.id=e.source_id')",
    "db.prepare('SELECT 1 FROM fin_events e,json_each(e.snapshot) j , \"orders\" o WHERE 1')",
    "db.prepare('SELECT status FROM main.flow_documents WHERE id=?')",
    "db.prepare('SELECT e.id FROM fin_events e JOIN \"main\".\"customers\" c ON c.id=e.party_id')",
    "db.prepare('SELECT * FROM fin_events WHERE id IN (SELECT a FROM fin_vouchers v, stock_items s)')",
    'db.prepare(`SELECT id FROM ${table} WHERE id=?`)',
    "db.prepare('SELECT e.id FROM fin_events e, ' + other + ' o')",
  ])
    assert.ok(sqlCheck('server/finance/sample.ts', s).some((x) => x.includes('（财务）读')), '财务里应拦住：' + s);
  for (const s of [
    "db.prepare('SELECT j.value FROM json_each(?) j JOIN fin_events e ON e.source_id=j.value')",
    "db.prepare('WITH x AS (SELECT id FROM fin_vouchers) SELECT * FROM x')",
    "db.prepare('SELECT at FROM business_audit')",
    "db.prepare('SELECT v.id FROM fin_vouchers v, fin_voucher_lines l, json_each(v.links) j WHERE l.voucher_id=v.id ORDER BY v.id')",
    "db.prepare('SELECT count(*) FROM (' + sql + ')')",
    "db.prepare('SELECT * FROM main.fin_events')",
  ])
    assert.deepEqual(sqlCheck('server/finance/sample.ts', s), [], '财务里不该拦：' + s);
  // 表的主人在自己的删除规则里写自己的表不拦
  assert.deepEqual(sqlCheck('server/operations/deletion.ts', "db.prepare('DELETE FROM stock_movements WHERE rowid=?')"), []);
  assert.deepEqual(sqlCheck('server/flow/sample.ts', "db.exec('drop table if exists flow_tmp')"), [], '删自己的表不拦');
  // 建表要登记归属
  assert.deepEqual(sqlFacts('server/flow/sample.ts', "db.exec('create table if not exists \"flow_new\"(id integer)')").creates, ['flow_new']);
});

test('只读目录里没有写库的 SQL，自己模块的表也不写；登记的目录都还在', () => {
  assert.deepEqual(readOnlyPaths.filter((p) => !all.some((f) => f.startsWith(p))), [], '只读目录已经没有文件了，从 readOnlyPaths 删掉');
  const sqlCheck = (text: string) => sqlViolations('server/flow/finance-facts/sample.ts', sqlFacts('server/flow/finance-facts/sample.ts', text));
  for (const s of [
    "db.prepare('update flow_documents set version=1')",
    "db.prepare('INSERT INTO flow_refs(document_id) VALUES(?)')",
    "db.prepare('delete from customers where id=?')",
    "db.prepare('UPDATE ' + table + ' SET a=1')",
  ])
    assert.ok(sqlCheck(s).some((x) => x.includes('只读目录')), '只读目录里应拦住：' + s);
  assert.deepEqual(sqlCheck("db.prepare('SELECT p.name FROM customers p JOIN flow_documents f ON f.id=p.id')"), [], '只读目录里读不该拦');
});

/** 助手的文件里读了别人的表、或表名是拼出来的读（回归测试直接喂样例） */
function assistantReadViolations(f: string, facts = sqlFacts(f)) {
  if (!f.startsWith('server/assistant/')) return [];
  const bad = facts.dynamicReads.map((d) => f + ':' + d.line + '：表名是拼出来的读（拼进来的是 ' + d.splice + '），看不出读的是谁的表。助手只读自己的表，业务数据调各模块的读函数');
  for (const s of facts.foreignSql)
    bad.push(f + ':' + s.line + '：交给读库函数的 SQL（' + s.sql + '）不是本文件写的，看不出读的是谁的表。助手的 SQL 写在本文件里且只读自己的表，业务数据调各模块的读函数');
  for (const r of facts.reads)
    if (tableOwner(r.table) !== '助手' && !sqliteOwn(r.table) && !assistantReadExceptions.some((e) => e.table === r.table))
      bad.push(f + ':' + r.line + '：助手直接读了 ' + r.table + '（' + (tableOwner(r.table) ?? '没登记') + '）。助手只读自己的表，业务数据调表主人模块的读函数或服务');
  return bad;
}

test('助手不直接读业务表：server/assistant/ 下的 SQL 只读助手自己的表，拼出来的读也拦；登记的例外都还用得上', () => {
  assert.deepEqual(serverFiles.flatMap((f) => assistantReadViolations(f)), []);
  const read = new Set(serverFiles.filter((f) => f.startsWith('server/assistant/')).flatMap((f) => sqlFacts(f).reads.map((r) => r.table)));
  assert.deepEqual(assistantReadExceptions.filter((e) => !read.has(e.table)).map((e) => e.table), [], '已经不读了，从 assistantReadExceptions 删掉');
  const check = (text: string) => assistantReadViolations('server/assistant/sample.ts', sqlFacts('server/assistant/sample.ts', text));
  for (const s of [
    "one(db, row, 'SELECT * FROM stock_items WHERE id=?', id)",
    'many(db, row, `SELECT t.id,t.version FROM ${table} t ORDER BY t.id`)',
    "count(db, 'SELECT COUNT(*) AS n FROM \"' + table + '\"')",
    "many(db, row, 'SELECT a.id FROM assistant_runs a JOIN flow_documents d ON d.id=a.thread_id')",
    "one(db, row, 'select kind,status from flow_documents where id=?', id)",
    // 用 .concat 拼表名
    "many(db, row, 'SELECT * FROM '.concat(table))",
    "one(db, row, 'SELECT id FROM assistant_runs WHERE x IN (SELECT id FROM '.concat(table, ')'))",
    // SQL 在别的模块写好、导入进来再交给读库函数（改了名也认）
    "import { many as rowsOf } from '../core/index.js';\nimport { stockSql } from '../operations/index.js';\nrowsOf(store.db, row, stockSql);",
    "import { count } from '../core/index.js';\ncount(store.db, sqlFor(table));",
    "store.db.prepare(STOCK_SQL).all()",
  ])
    assert.ok(check(s).length, '助手里应拦住：' + s);
  for (const s of [
    "one(db, row, 'SELECT seq FROM assistant_messages WHERE id=?', id)",
    "one(db, row, 'SELECT enabled FROM tool_settings WHERE name=?', name)",
    "count(db, 'SELECT COUNT(*) FROM pragma_foreign_key_check')",
    // 本文件写的 SQL 放进常量再交给读库函数；不是库连接的 exec（正则）不算
    "import { many } from '../core/index.js';\nconst SQL = 'SELECT seq FROM assistant_messages WHERE thread_id=?';\nmany(db, row, SQL, id);",
    "const m = /x/.exec(text);",
    "store.db.exec('BEGIN IMMEDIATE')",
  ])
    assert.deepEqual(check(s), [], '助手里不该拦：' + s);
});
