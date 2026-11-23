// 业务库的约束：全部表 STRICT；状态、种类列的枚举和各模块的常量一致；日期、期间、JSON、单位、标志的约束真的拦得住；
// 约束拦下写入时给用户的是一句中文，原始错误进服务端日志。
// 建表里的枚举是写死的（基础模块不能引用别的模块的常量），这里从建好的库里把 CHECK 的值抽出来和常量逐个比对。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type PrepareOptions, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { format } from 'node:util';
import { createApp } from '../server/app.js';
import { listen, testProblems } from './http-fixture.js';
import { assistantMessageRoles, assistantRunStates } from '../server/assistant/conversation.js';
import { markSourceKinds } from '../shared/business/index.js';
import {
  Store,
  count,
  one,
  rows,
  AppError,
  constraintFailure,
  failureMessage,
  isConstraintError,
} from '../server/core/index.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { CONSTRAINT_MESSAGE } from '../server/core/http/errors.js';
import {
  isDate,
  isDateOrNull,
  isJsonArray,
  isJsonObject,
  isPeriod,
  isPeriodOrNull,
  isSha256,
} from '../server/core/schema/tables/checks.js';
import * as finance from '../server/finance/base/stored-values.js';
import { purchaseReturnStatuses } from '../shared/business/flow-results.js';
import { flowSourceKinds } from '../server/flow/documents/sources.js';
import { stockMovementActions } from '../server/operations/ledger/ledger.js';
import { movementSourceKinds } from '../shared/business/movement-filters.js';
import { purchaseBusinessStatuses } from '../shared/business/operations.js';
import { flowStates } from '../shared/business/physical-flow.js';
import { flowKinds, stockKinds } from '../shared/core/index.js';
import { attachmentKinds } from '../shared/core/assistant-attachments.js';
import { auditSources } from '../shared/core/audit-sources.js';
import { orderSchema, orderTaxModes, productSchema, statuses } from '../shared/core/domain.js';
import { FINISHED_UNIT, RAW_UNIT } from '../shared/core/units.js';
import { documentExportSchema } from '../shared/documents/business-export.js';
import {
  accountCategories,
  accountSchema,
  auxiliaryKinds,
  cashMethods,
  settingsPatchSchema,
  storedTaxModes,
  taxpayerSchema,
  termTypes,
} from '../shared/finance/finance.js';
import { convertedKinds, inboxChannels, inboxKinds, inboxStatuses } from '../shared/import/inbox.js';
import { assistantFixture } from './assistant-fixture.js';
import { accepts, rejects, sha } from './schema-fixture.js';
import { actor as assistantActor } from './actor-fixture.js';

type Row = Record<string, unknown>;
const all = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  db.prepare(sql).all(...args).map((row): Row => ({ ...row }));
const now = '2026-11-12T00:00:00.000Z';

function tables(db: DatabaseSync) {
  return all(db, "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => ({
    name: String(t.name),
    sql: String(t.sql),
  }));
}

/** 建表语句里“列 IN ('a','b',…)”这样的枚举：'表.列' → 值。同一列写了两遍必须一样。 */
function enumChecks(db: DatabaseSync) {
  const found: Record<string, string[]> = {};
  for (const table of tables(db))
    for (const match of table.sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+IN\s*\(\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*\)/gi)) {
      const key = table.name + '.' + match[1];
      const values = [...match[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      if (found[key]) assert.deepEqual(values, found[key], key + ' 的枚举写了两遍，两遍要一样');
      found[key] = values;
    }
  return found;
}

/** 库里这张表的建表语句；没有这张表就让测试失败 */
function tableSql(db: DatabaseSync, name: string) {
  const table = tables(db).find((t) => t.name === name);
  assert.ok(table, '库里有表 ' + name);
  return table.sql;
}

test('业务库的表全部是 STRICT', () => {
  // 还没改成 STRICT 的表：'表名' → 原因。现在一张也没有；以后新表一律建成 STRICT，不往这里加。
  const notYet: Record<string, string> = {};
  const store = new Store(':memory:');
  try {
    const list = all(store.db, "SELECT name,strict FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'");
    assert.ok(list.length > 70, '读到了业务库的表');
    const loose = list.filter((t) => Number(t.strict) !== 1).map((t) => String(t.name)).sort();
    assert.deepEqual(loose, Object.keys(notYet).sort(), '新表要建成 STRICT（CREATE TABLE … ) STRICT;）');
  } finally {
    store.close();
  }
});

/** '表.列' → 所属模块里的常量。没有登记的枚举列会让下面那条测试失败：先在所属模块补常量，再登记到这里。 */
function enumOwners(): Record<string, readonly string[]> {
  const revenue = settingsPatchSchema.shape.revenueRecognition.unwrap().options;
  return {
    // 基础
    'orders.status': statuses,
    'orders.tax_mode': orderTaxModes,
    'order_lines.tax_mode': orderTaxModes,
    'orders.rounding_policy': orderSchema.shape.roundingPolicy.unwrap().options,
    'products.dimension_unit': productSchema.shape.dimensionUnit.unwrap().unwrap().options,
    // 归档标记、墓碑的记录种类不列枚举，由各模块登记（server/core/records/kinds/record-kinds.ts，tests/record-kinds.test.ts 守）
    'business_audit.source': auditSources,
    // 采购库存
    'stock_items.kind': stockKinds,
    'purchases.status': purchaseBusinessStatuses,
    'stock_movements.action': stockMovementActions,
    'stock_movements.source_kind': movementSourceKinds,
    // 单据流转
    'flow_documents.kind': flowKinds,
    'flow_documents.status': Object.keys(flowStates),
    'flow_sources.kind': flowSourceKinds,
    'purchase_returns.status': purchaseReturnStatuses,
    // 单据导出
    'document_exports.record_kind': documentExportSchema.shape.kind.options,
    'document_exports.format': documentExportSchema.shape.format.options,
    // 业务总览
    'product_marks.source_kind': markSourceKinds,
    // 识别导入
    'inbox_items.channel': inboxChannels,
    'inbox_items.kind': inboxKinds,
    'inbox_items.status': inboxStatuses,
    'inbox_items.converted_kind': convertedKinds,
    // 助手
    'assistant_messages.role': assistantMessageRoles,
    'assistant_runs.state': assistantRunStates,
    'assistant_attachments.kind': attachmentKinds,
    // 财务
    'fin_settings.taxpayer': taxpayerSchema.options,
    'fin_settings.revenue_recognition': revenue,
    'fin_settings.cost_allocation': settingsPatchSchema.shape.costAllocation.unwrap().options,
    'fin_settings_history.taxpayer': taxpayerSchema.options,
    'fin_settings_history.revenue_recognition': revenue,
    'fin_settings_history.cost_allocation': settingsPatchSchema.shape.costAllocation.unwrap().options,
    'fin_accounts.category': accountCategories,
    'fin_accounts.direction': accountSchema.shape.direction.options,
    'fin_accounts.cash_kind': accountSchema.shape.cashKind.unwrap().unwrap().options,
    'fin_accounts.auxiliary': auxiliaryKinds,
    'fin_opening.auxiliary_kind': auxiliaryKinds,
    'fin_entries.auxiliary_kind': auxiliaryKinds,
    'fin_periods.status': finance.periodStatuses,
    'fin_vouchers.status': finance.voucherStatuses,
    'fin_vouchers.module_source': finance.voucherModuleSources,
    'fin_events.source_kind': finance.eventSourceKinds,
    'fin_events.event_type': finance.eventTypes,
    'fin_events.status': finance.eventStatuses,
    'fin_events.revenue_recognition': revenue,
    'fin_events.previous_status': finance.eventStatuses,
    'fin_events.party_kind': finance.partyKinds,
    'fin_source_observations.source_kind': finance.eventSourceKinds,
    'fin_source_observations.status': finance.observationStatuses,
    'fin_templates.name': finance.templateNames,
    'fin_party_terms.kind': finance.partyKinds,
    'fin_party_terms.term_type': termTypes,
    'fin_party_terms.tax_mode': storedTaxModes,
    'fin_obligations.kind': finance.obligationKinds,
    'fin_obligations.tax_status': finance.obligationTaxStatuses,
    'fin_cash_accounts.kind': finance.cashAccountKinds,
    'fin_cash_documents.kind': finance.cashDocumentKinds,
    'fin_cash_documents.status': finance.cashDocumentStatuses,
    'fin_cash_documents.method': cashMethods,
    'fin_allocations.status': finance.allocationStatuses,
    'fin_deposits.kind': finance.depositKinds,
    'fin_deposits.party_kind': finance.partyKinds,
    'fin_deposit_actions.kind': finance.depositActionKinds,
    'fin_bad_debts.kind': finance.badDebtKinds,
    'fin_statements.kind': finance.obligationKinds,
    'fin_statements.status': finance.statementStatuses,
    'fin_notes.kind': finance.obligationKinds,
    'fin_notes.status': finance.noteStatuses,
    'fin_attachments.media_type': finance.attachmentMediaTypes,
    'fin_invoices.direction': finance.invoiceDirections,
    'fin_invoices.status': finance.invoiceStatuses,
    'fin_expenses.status': finance.expenseStatuses,
    'fin_assets.status': finance.assetStatuses,
    'fin_period_jobs.kind': finance.periodJobKinds,
    'fin_inventory_costs.unit': [RAW_UNIT, FINISHED_UNIT],
  };
}

test('建表里写死的枚举和各模块的常量逐个一致：改了一边，另一边也要改', () => {
  const expected = enumOwners();
  const store = new Store(':memory:');
  try {
    const found = enumChecks(store.db);
    assert.deepEqual(
      Object.keys(found).sort(),
      Object.keys(expected).sort(),
      '库里每个有枚举约束的列都要在这里登记所属模块的常量，登记了的列库里也要真有约束',
    );
    for (const [key, values] of Object.entries(expected))
      assert.deepEqual([...found[key]].sort(), [...values].sort(), key + ' 的枚举和模块常量不一致');
    // 库存单位不是 IN 的写法，单独比：原材料张、成品只
    const stockItems = tableSql(store.db, 'stock_items');
    assert.ok(
      stockItems.includes(`CHECK((kind='raw' AND unit='${RAW_UNIT}') OR (kind='finished' AND unit='${FINISHED_UNIT}'))`),
      'stock_items 的单位约束和 shared/core/units.ts 一致',
    );
    // 生产任务没有“待核对”（安排即下达）：flowStates 里的 draft 只给别的单据用，任务由这条约束拦
    assert.ok(tableSql(store.db, 'flow_documents').includes("CHECK(kind<>'task' OR status<>'draft')"));
    // 预置的凭证模板正好是枚举里的那些
    assert.deepEqual(
      all(store.db, 'SELECT name FROM fin_templates').map((r) => String(r.name)).sort(),
      [...finance.templateNames].sort(),
    );
  } finally {
    store.close();
  }
});

test('带版本号（version 列）的业务表都约束版本号从 1 起', () => {
  const store = new Store(':memory:');
  try {
    const tables = store.db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name")
      .all()
      .filter((table) => store.db.prepare('SELECT 1 FROM pragma_table_xinfo(?) WHERE name=?').get(String(table.name), 'version'));
    assert.ok(tables.length > 10, '找到了带版本号的表');
    const missing = tables
      .filter((table) => !/\bversion\s+INTEGER\b[^,\n]*CHECK\(\s*version\s*>=\s*1\s*\)/i.test(String(table.sql)))
      .map((table) => String(table.name));
    assert.deepEqual(missing, [], '这些表的 version 列要写 CHECK(version>=1)');
  } finally {
    store.close();
  }
});

test('约束片段的写法：日期要真有这一天，期间月份 01～12，JSON 分对象和数组，摘要是 64 位十六进制', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE d(x TEXT NOT NULL CHECK(${isDate('x')})) STRICT;
      CREATE TABLE dn(x TEXT CHECK(${isDateOrNull('x')})) STRICT;
      CREATE TABLE p(x TEXT NOT NULL CHECK(${isPeriod('x')})) STRICT;
      CREATE TABLE pn(x TEXT CHECK(${isPeriodOrNull('x')})) STRICT;
      CREATE TABLE jo(x TEXT NOT NULL CHECK(${isJsonObject('x')})) STRICT;
      CREATE TABLE ja(x TEXT NOT NULL CHECK(${isJsonArray('x')})) STRICT;
      CREATE TABLE h(x TEXT NOT NULL CHECK(${isSha256('x')})) STRICT;`);
    const check = (table: string, good: (string | null)[], bad: (string | null)[]) => {
      for (const value of good) accepts(db, `INSERT INTO ${table}(x) VALUES(?)`, [value]);
      for (const value of bad) rejects(db, `INSERT INTO ${table}(x) VALUES(?)`, [value], /CHECK constraint failed|NOT NULL constraint failed/);
    };
    check('d', ['2026-01-31', '2024-02-29', '2026-12-01'], ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '', '2026-01-31T00:00:00Z', '2026/01/31', '20260131', null]);
    check('dn', ['2026-01-31', null], ['', '2026-02-30', '2026-1-1']);
    check('p', ['2026-01', '2026-12'], ['2026-13', '2026-00', '2026-1', '2026', '2026-01-01', '', null]);
    check('pn', ['2026-06', null], ['', '2026-13']);
    check('jo', ['{}', '{"a":1}'], ['[]', 'null', '"x"', '1', '{bad', '{a:1}', '']);
    check('ja', ['[]', '[1,2]'], ['{}', 'null', '[1,', '']);
    check('h', [sha('a'), sha('0'), '0123456789abcdef'.repeat(4)], ['abc', sha('g'), sha('A'), sha('a') + 'a', '']);
  } finally {
    db.close();
  }
});

/** 临时接住 console.error，返回这段时间里打出来的内容 */
async function capturingErrors<T>(work: () => T | Promise<T>) {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await work(), logged };
  } finally {
    console.error = original;
  }
}
const text = (logged: unknown[][]) =>
  logged.map((args) => format(...args.map((a) => (a instanceof Error ? a.message : a)))).join('\n');

test('认得出数据库的约束错误：CHECK、NOT NULL、UNIQUE、外键、STRICT 类型不符；别的错误不算', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE CHECK(length(name)>0)) STRICT;
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)) STRICT;
      INSERT INTO parent(id,name) VALUES(1,'虚构');`);
    const failure = (sql: string) => {
      try {
        db.exec(sql);
      } catch (error) {
        return error;
      }
      return assert.fail('这条语句应该报错：' + sql);
    };
    for (const sql of [
      "INSERT INTO parent(name) VALUES('')",
      'INSERT INTO parent(name) VALUES(NULL)',
      "INSERT INTO parent(name) VALUES('虚构')",
      'INSERT INTO child(parent_id) VALUES(99)',
      "INSERT INTO child(parent_id) VALUES('abc')",
    ])
      assert.equal(isConstraintError(failure(sql)), true, sql);
    assert.equal(isConstraintError(failure('SELECT * FROM 没有这张表')), false);
    for (const other of [new Error('CHECK constraint failed: 只是文字像'), new AppError('业务提示'), null, undefined, 'CHECK constraint failed'])
      assert.equal(isConstraintError(other), false);

    const check = failure("INSERT INTO parent(name) VALUES('')");
    const { result, logged } = await capturingErrors(() => constraintFailure(check, '虚构入口'));
    assert.equal(result, CONSTRAINT_MESSAGE);
    assert.equal(CONSTRAINT_MESSAGE, '数据没有保存：有内容不符合数据规则，请联系维护人员。');
    assert.equal(logged.length, 1, '原始错误写进服务端日志');
    assert.match(text(logged), /虚构入口/);
    assert.match(text(logged), /CHECK constraint failed: length\(name\)>0/);
    const quiet = await capturingErrors(() => constraintFailure(new AppError('业务提示'), '虚构入口'));
    assert.equal(quiet.result, null, '不是约束错误：交回调用方照原来的办法处理');
    assert.equal(quiet.logged.length, 0);

    // 入口说明带 %d/%s（如外来请求路径）不能当格式串解释，否则会把后续错误参数吃掉
    const withSpecifiers = await capturingErrors(() => constraintFailure(check, 'POST /api/customers/%d/%s'));
    assert.equal(withSpecifiers.result, CONSTRAINT_MESSAGE);
    assert.equal(withSpecifiers.logged.length, 1);
    assert.match(text(withSpecifiers.logged), /POST \/api\/customers\/%d\/%s/);
    assert.match(text(withSpecifiers.logged), /CHECK constraint failed: length\(name\)>0/);
  } finally {
    db.close();
  }
});

test('接口上数据库约束拦下写入：返回一句中文，不带英文原文；原始错误进服务端日志；数据没有写进去', async (t) => {
  const store = new Store(':memory:');
  const server = await listen(createApp(store, { problems: testProblems() }));
  const url = server.origin + '/api/customers';
  const post = (name: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, contact: '', phone: '', address: '', notes: '' }),
    });
  const db = store.db;
  const prepare = db.prepare.bind(db);
  try {
    assert.equal((await post('虚构客户甲')).status, 201);
    // 模拟程序写错：保存客户时把名称写成了空白（正常的保存服务不会这样，校验早就拦了）
    const broken = t.mock.method(db, 'prepare', (sql: string, options?: PrepareOptions) => {
      const statement = prepare(sql, options);
      if (!sql.startsWith('INSERT INTO customers(')) return statement;
      const run = statement.run.bind(statement);
      t.mock.method(statement, 'run', (_name: SQLInputValue, ...rest: SQLInputValue[]) => run('   ', ...rest));
      return statement;
    });
    const { result: response, logged } = await capturingErrors(() => post('虚构客户乙'));
    broken.mock.restore();
    assert.equal(response.status, 500);
    const body: unknown = await response.json();
    assert.deepEqual(body, { message: CONSTRAINT_MESSAGE, code: 'data-rule' });
    assert.doesNotMatch(JSON.stringify(body), /CHECK|constraint|trim/i, '英文原文不给用户看');
    assert.match(text(logged), /POST \/api\/customers/);
    assert.match(text(logged), /CHECK constraint failed: length\(trim\(name\)\)>0/, '原始错误在服务端日志里');
    assert.deepEqual(
      db.prepare('SELECT name FROM customers ORDER BY id').all().map((r) => r.name),
      ['虚构客户甲'],
      '被拦下的那条没有写进去',
    );
    // 照常能用
    assert.equal((await post('虚构客户丙')).status, 201);
  } finally {
    // 中途失败时换掉的 prepare 由 t.mock 在这条测试结束时还原（替身只改客户的插入，关服务、关库照常）
    await server.close();
    store.close();
  }
});

test('助手的工具被数据库约束拦下：交给模型和用户的是那句中文，英文原文只进服务端日志', async () => {
  const f = assistantFixture();
  try {
    const thread = f.manager.create(assistantActor);
    f.replies.push(
      { message: '正在调用真实业务工具。', toolCalls: [{ name: 'records.get', args: { module: 'customers', id: 1 } }] },
      { message: '已经保存好了。', toolCalls: [] },
    );
    // 模拟程序写错：工具执行时往归档标记里写了一个空的记录种类（正常代码不会这样写）
    f.manager.tools.readChecked = () =>
      f.store.db.prepare("INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES('',1,'t','x')").run();
    const events: { type: string; data: unknown }[] = [];
    const { result, logged } = await capturingErrors(() =>
      f.manager.chat(
        thread.id,
        f.input('查询客户编号 1', randomUUID()),
        assistantActor,
        's',
        (type: string, data: unknown) => void events.push({ type, data }),
        () => assistantActor,
      ),
    );
    const failed = result.messages.at(-1)?.facts?.failed;
    assert.equal(failed?.length, 1, '工具失败了一次');
    assert.equal(failed?.[0].message, CONSTRAINT_MESSAGE);
    const failedState = (data: unknown) =>
      typeof data === 'object' && data !== null && 'state' in data && data.state === 'failed';
    assert.ok(events.some((e) => e.type === 'tool' && failedState(e.data)));
    // 第二次请求模型时带着工具结果：里面是中文提示，没有英文原文
    const sent = JSON.stringify(f.requests.map((r) => r.body));
    assert.ok(sent.includes(CONSTRAINT_MESSAGE), '模型看到的是中文提示');
    assert.doesNotMatch(sent, /CHECK constraint failed/);
    assert.doesNotMatch(JSON.stringify(result.messages), /CHECK constraint failed/, '聊天记录里没有英文原文');
    assert.match(text(logged), /助手工具 records\.get/);
    assert.match(text(logged), /CHECK constraint failed: length\(entity\)>0/, '原始错误在服务端日志里');
    assert.equal(count(f.store.db, 'SELECT count(*) FROM record_lifecycle'), 0);
  } finally {
    f.close();
  }
});

test('批量操作逐条结果被数据库约束拦下：那一条给中文提示，英文原文只进带 [数据规则] 的日志；别的条照常', async () => {
  // 逐条处理的小函数：不是约束错误就照旧用原来的提示，不记日志
  const plain = await capturingErrors(() => [
    failureMessage(new AppError('记录已修改，请刷新。', 409), '虚构批量', '保存失败'),
    failureMessage('不是 Error', '虚构批量', '保存失败'),
  ]);
  assert.deepEqual(plain.result, ['记录已修改，请刷新。', '保存失败']);
  assert.equal(plain.logged.length, 0);

  const store = new Store(':memory:');
  const markArchived = store.markArchived.bind(store);
  try {
    const add = (name: string) =>
      Number(
        store.db
          .prepare("INSERT INTO customers(name,contact,phone,address,notes,created_at,updated_at) VALUES(?,'','','','',?,?)")
          .run(name, now, now).lastInsertRowid,
      );
    const first = add('虚构客户甲'),
      second = add('虚构客户乙');
    const version = (id: number) => {
      const row = one(store.db, rows.customers.pick({ version: true }), 'SELECT version FROM customers WHERE id=?', id);
      assert.ok(row, '客户 ' + id + ' 在库里');
      return row.version;
    };
    // 模拟程序写错：归档第二条时往归档标记里写了一个空的记录种类（正常代码不会这样写）
    store.markArchived = (entity, id, actorId, options) =>
      id === second
        ? void store.db.prepare("INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES('',?,'t','x')").run(id)
        : markArchived(entity, id, actorId, options);
    const { result, logged } = await capturingErrors(() =>
      changeLifecycle(
        store,
        'customers',
        {
          action: 'archive',
          items: [
            { id: first, version: version(first) },
            { id: second, version: version(second) },
          ],
        },
        assistantActor,
      ),
    );
    assert.deepEqual(
      result.results.map((r) => [r.id, r.success]),
      [
        [first, true],
        [second, false],
      ],
    );
    assert.equal(result.results[1].message, CONSTRAINT_MESSAGE);
    assert.doesNotMatch(JSON.stringify(result), /CHECK|constraint/i, '英文原文不给用户看');
    assert.equal(logged.length, 1);
    assert.match(text(logged), /^\[数据规则\] 批量归档 customers #\d+/);
    assert.match(text(logged), /CHECK constraint failed: length\(entity\)>0/, '原始错误在服务端日志里');
    assert.deepEqual(
      store.db.prepare('SELECT entity,record_id FROM record_lifecycle').all().map((r) => [r.entity, r.record_id]),
      [['customers', first]],
      '被拦下的那条整条回滚，前一条照常归档',
    );
  } finally {
    store.markArchived = markArchived;
    store.close();
  }
});
