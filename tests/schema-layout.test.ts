// 业务库结构的写法规矩：建表只在 schema/、插入写列名、该自增的自增、大字段放最后、外键子列有索引。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/core/db.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function serverFiles(dir = join(projectRoot, 'server'), found: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) serverFiles(path, found);
    else if (/\.(ts|mts|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('建表、改表、删表语句只出现在 server/core/schema/ 和各配置库自己的建表文件里', () => {
  // 配置库各是单独的 SQLite 文件，建表语句和升级步骤留在主人模块的规格文件里，用 server/core/versioned-sqlite.ts 各管各的版本
  const configDatabases: Record<string, string> = {
    'server/accounts/account-db.ts': '账号库 security/users.sqlite',
    'server/core/diagnostics/problem-log.ts': '出错记录库 logs/problems.sqlite',
    'server/ai/prompt-presets.ts': '提示词库 ai-prompts/*.sqlite',
    'server/ai/settings-repository.ts': 'AI 设置库 settings.sqlite',
    'server/assistant/tool-registry.ts': '助手工具设置库 ai-tools/tools.sqlite',
    'server/import/repository.ts': 'AI 识别工作区 ai-imports/workspaces.sqlite',
    'server/inbox/bots/settings.ts': '机器人设置库 bots/bots.sqlite',
  };
  const ddl = /\b(?:create\s+(?:temp(?:orary)?\s+)?table|alter\s+table|drop\s+table)\b/i;
  const offenders = serverFiles()
    .map((file) => file.slice(projectRoot.length + 1).split('\\').join('/'))
    .filter((file) => !file.startsWith('server/core/schema/') && !(file in configDatabases))
    .filter((file) => ddl.test(readFileSync(join(projectRoot, file), 'utf8')));
  assert.deepEqual(offenders, [], '业务库的表只在 server/core/schema/tables/ 里建，改结构写成 server/core/schema/steps.ts 里的升级步骤');
  for (const file of Object.keys(configDatabases)) assert.ok(existsSync(join(projectRoot, file)), '登记的配置库文件还在：' + file);
});

// ---------- 第 20 版结构守卫：编号、物理布局、索引、插入写列名 ----------

type TableShape = {
  name: string;
  sql: string;
  columns: { name: string; type: string; pk: number }[];
  /** 每个索引（含主键、UNIQUE 的自动索引、部分索引）的首列 */
  indexFirstColumns: Set<string>;
  /** 外键子列（多列外键取第一列）→ 父表 */
  foreignKeys: { from: string; table: string }[];
};

/** 当前程序在空库上建出来的业务库结构 */
function businessTables(): TableShape[] {
  const store = new Store(':memory:');
  try {
    const db = store.db;
    const all = (sql: string) => db.prepare(sql).all().map((row): Record<string, unknown> => ({ ...row }));
    return all("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((table) => {
      const name = String(table.name);
      const q = '"' + name + '"';
      const columns = all('PRAGMA table_xinfo(' + q + ')').map((c) => ({ name: String(c.name), type: String(c.type), pk: Number(c.pk) }));
      const indexFirstColumns = new Set<string>();
      for (const index of all('PRAGMA index_list(' + q + ')')) {
        const first = all('PRAGMA index_info("' + String(index.name) + '")').sort((a, b) => Number(a.seqno) - Number(b.seqno))[0];
        if (first?.name) indexFirstColumns.add(String(first.name));
      }
      const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)[0];
      if (pk) indexFirstColumns.add(pk.name);
      const foreignKeys = all('PRAGMA foreign_key_list(' + q + ')')
        .filter((fk) => Number(fk.seq) === 0)
        .map((fk) => ({ from: String(fk.from), table: String(fk.table) }));
      return { name, sql: String(table.sql), columns, indexFirstColumns, foreignKeys };
    });
  } finally {
    store.close();
  }
}

function sourceFiles(dir: string, found: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('server/、scripts/ 里往业务库表插入都写列名：表加了列、调了列顺序，值也不会插错列', () => {
  const tables = new Set(businessTables().map((t) => t.name));
  // 允许不写列名的插入：'文件 表名' → 理由。现在一条也没有，要加先想清楚为什么不能写列名。
  const allowed: Record<string, string> = {};
  // INSERT/REPLACE INTO 表 VALUES|SELECT（表名后面直接跟 VALUES、SELECT，没有括号列名）
  const positional = /\bINTO\s+["`]?([A-Za-z_]\w*)["`]?\s+(?:VALUES|SELECT|DEFAULT\s+VALUES)\b/g;
  // 表名是拼出来的又没写列名：INTO ${表} VALUES、INTO ' + 表 + ' VALUES
  const dynamic = /\bINTO\s+(?:\$\{[^}]+\}|["'`]\s*\+\s*[\w.]+\s*\+\s*["'`])\s*(?:VALUES|SELECT)\b/g;
  const offenders: string[] = [];
  for (const file of [...sourceFiles(join(projectRoot, 'server')), ...sourceFiles(join(projectRoot, 'scripts'))]) {
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(projectRoot.length + 1).split('\\').join('/');
    for (const match of text.matchAll(positional))
      if (tables.has(match[1]) && !(rel + ' ' + match[1] in allowed)) offenders.push(rel + ' ' + match[1]);
    for (const match of text.matchAll(dynamic)) if (!(rel + ' ' + match[0] in allowed)) offenders.push(rel + ' ' + match[0]);
  }
  assert.deepEqual(offenders, [], '往业务库表插入要写列名：INSERT INTO 表(列,…) VALUES(…)');
});

test('被引用、会被删的业务表编号用 AUTOINCREMENT：删掉最大的那条以后编号也不复用', () => {
  // 页面地址、单号、审计、单据 JSON、财务快照、助手上下文引用这些编号，删除和初始化后不能把同一个编号发给新记录
  const required = [
    'customers',
    'products',
    'orders',
    'order_lines',
    'suppliers',
    'purchases',
    'purchase_lines',
    'stock_items',
    'product_marks',
    'inbox_items',
    'flow_documents',
    'purchase_returns',
    'order_batches',
    // 财务的五张主表：凭证、事件、往来、收付款单、发票。连财务一起初始化以后编号不从头来，不会和财务审计里的旧编号混在一起
    'fin_vouchers',
    'fin_events',
    'fin_obligations',
    'fin_cash_documents',
    'fin_invoices',
  ];
  const tables = new Map(businessTables().map((t) => [t.name, t]));
  for (const name of required) {
    const table = tables.get(name);
    assert.ok(table, '表还在：' + name);
    assert.match(table.sql, /\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, name + ' 的 id 要用 INTEGER PRIMARY KEY AUTOINCREMENT');
  }
});

test('库存流水、助手消息、助手附件、识别执行记录：第一列是自增顺序号 seq，原来的文本 id 唯一', () => {
  const tables = new Map(businessTables().map((t) => [t.name, t]));
  for (const name of ['stock_movements', 'assistant_messages', 'assistant_attachments', 'import_executions']) {
    const table = tables.get(name);
    assert.ok(table, '表还在：' + name);
    assert.equal(table.columns[0]?.name, 'seq', name + ' 第一列是 seq');
    assert.equal(table.columns[0]?.pk, 1, name + ' 的 seq 是主键');
    assert.match(table.sql, /\bseq\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, name + ' 的 seq 自增、不复用');
    assert.match(table.sql, /\bid\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i, name + ' 的 id 是 TEXT NOT NULL UNIQUE');
  }
});

test('存文件的大字段放在表的最后：BLOB 是最后一列，单据 JSON、识别文字这类大文本后面不再跟小列', () => {
  // 大字段溢出到别的页以后，排在它后面的小列每次都要顺着读过去；建表时调零成本，以后要调只能重建表
  // snapshot 是财务事件里整份来源单据的快照
  const bigText = new Set(['document', 'metadata', 'result', 'snapshot']);
  // '表.大字段 后面的列' → 理由
  const appended = '0.9.0 发布后的升级步骤加的列：ADD COLUMN 只能接在最后（第 21 步），挪到前面要重建整张表';
  const allowed: Record<string, string> = Object.fromEntries(
    [
      'previous_event_id',
      'previous_status',
      'party_kind',
      'party_id',
      'party_name',
      'source_number',
      'document_cents',
      'theoretical_cents',
      'missing_tax',
    ].map((column) => ['fin_events.snapshot ' + column, appended]),
  );
  const offenders: string[] = [];
  for (const table of businessTables()) {
    const last = table.columns.length - 1;
    table.columns.forEach((column, index) => {
      if (/BLOB/i.test(column.type) && index !== last) offenders.push(table.name + '.' + column.name + ' 是 BLOB 但不是最后一列');
    });
    const firstBig = table.columns.findIndex((c) => bigText.has(c.name) || /BLOB/i.test(c.type));
    if (firstBig < 0) continue;
    for (const column of table.columns.slice(firstBig + 1)) {
      if (bigText.has(column.name) || /BLOB/i.test(column.type)) continue;
      const key = table.name + '.' + table.columns[firstBig].name + ' ' + column.name;
      if (!(key in allowed)) offenders.push(key);
    }
  }
  assert.deepEqual(offenders, [], '大字段（BLOB、document、metadata、result）后面不能再有小列');
});

test('外键子列都有索引可用（是某个索引的首列）；不加的都在白名单里写明原因', () => {
  // 父行删除时 SQLite 要按子列查子表，按子列逐行查的语句也要索引；下面这些不加，'表.列' → 理由
  const voucher = '凭证只红冲、作废，不删（只删分录）；财务清空先删子表再删凭证；没有按这一列逐行查的语句';
  const account = '科目不删（初始化也保留科目表），科目代码不改';
  const noLookup = '发票、附件不单独删，没有按这一列查的语句';
  const unindexed: Record<string, string> = {
    'fin_allocations.voucher_id': voucher,
    'fin_assets.voucher_id': voucher,
    'fin_bad_debts.voucher_id': voucher,
    'fin_cash_documents.voucher_id': voucher,
    'fin_deposit_actions.voucher_id': voucher,
    'fin_deposits.voucher_id': voucher,
    'fin_depreciation.voucher_id': voucher,
    'fin_expenses.voucher_id': voucher,
    'fin_interest.voucher_id': voucher,
    'fin_invoices.voucher_id': voucher,
    'fin_notes.voucher_id': voucher,
    'fin_obligations.voucher_id': voucher,
    'fin_period_jobs.voucher_id': voucher,
    'fin_invoices.transfer_voucher_id': voucher,
    'fin_obligations.estimate_voucher_id': voucher,
    'fin_assets.expense_account': account,
    'fin_budgets.account_code': account,
    'fin_expenses.account_code': account,
    'fin_payroll.account_code': account,
    'fin_cash_documents.target_account_id':
      '资金账户只在财务清空时删；按它查的语句是 account_id=? OR target_account_id=?，单列索引帮不上',
    'fin_expenses.invoice_id': noLookup,
    'fin_expenses.attachment_id': noLookup,
    'fin_invoices.attachment_id': noLookup,
  };
  const missing: string[] = [];
  const stale: string[] = [];
  const all = new Set<string>();
  for (const table of businessTables())
    for (const fk of table.foreignKeys) {
      const key = table.name + '.' + fk.from;
      all.add(key);
      if (table.indexFirstColumns.has(fk.from)) {
        if (key in unindexed) stale.push(key + '（已经有索引）');
      } else if (!(key in unindexed)) missing.push(key + ' -> ' + fk.table);
    }
  for (const key of Object.keys(unindexed)) if (!all.has(key)) stale.push(key + '（已经不是外键）');
  assert.deepEqual(missing, [], '外键子列要加索引，确实不用加的登记到白名单并写明原因');
  assert.deepEqual(stale, [], '白名单里过时的条目要删掉');
});
