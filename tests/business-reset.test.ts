// 清空业务数据（人工和助手）：连带清哪些、保留哪些，财务已有记录时拒绝，编号不回头，初始化的范围登记全。
import { z } from 'zod';
import { pageActor, actor as assistantActor, superActor as assistantSuperActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/auth.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { BusinessReset } from '../server/admin/business-reset.js';
import { count, many, resetCounts, resetParticipants, rows } from '../server/core/index.js';
import { AssistantAttachments } from '../server/assistant/attachments.js';
// 初始化时各模块清自己的表、删除时各模块配合：财务、识别导入、业务汇总加载时登记（server/core/deletion-rules.ts）
import '../server/finance/index.js';
import '../server/import/index.js';
import '../server/business/index.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents } from '../server/finance/events.js';
import { financePermissions } from '../shared/core/accounts.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { AssistantExtraTools } from '../server/assistant/extra-tools.js';
import { businessBase } from './business-base-fixture.js';
import { assistantDeps, assistantFixture, makeSettings, toolsOf } from './assistant-fixture.js';
import { InboxService } from '../server/inbox/service.js';
import { BotSettings } from '../server/inbox/bots/settings.js';
import { imageFixture } from './import-fixtures.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { FinanceCashAccounts } from '../server/finance/cash-accounts.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { readAs } from './read-result.js';

/** 助手的系统维护工具（清空预览只用业务库和识别导入，别的依赖是虚构的） */
function extraTools(store: Store) {
  const { deps } = assistantDeps(store, makeSettings());
  return new AssistantExtraTools({ ...deps, attachments: new AssistantAttachments(store) });
}

const who = () =>
  localAdministratorActor(pageActor({
    id: 'fixture-owner',
    name: '虚构维护',
    role: 'super_admin',
    permissions: ['business:edit'],
    superAdminMode: true,
    superAdminUntil: Date.now() + 3600000,
  }));

const financeActor = pageActor({
  id: 'maker',
  name: '虚构制单员',
  role: 'super_admin' as const,
  permissions: [...financePermissions, 'business:edit'],
});

function financeFixture(period = '2026-01') {
  const store = new Store(':memory:');
  const settings = new FinanceSettings(store);
  settings.enable(financeActor, {
    period,
    taxpayer: 'general',
    version: 1,
    requestId: 'enable',
    rows: [],
  });
  settings.update(financeActor, {
    version: 2,
    requestId: 'rates',
    taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 },
  });
  return store;
}

const actor: Actor = pageActor({ id: 'p0', name: '虚构操作员', permissions: ['business:edit'] });

const superActor = (): Actor => ({
  ...actor,
  role: 'super_admin',
  superAdminMode: true,
  superAdminUntil: Date.now() + 60000,
});

const inboxFile = { name: '虚构附件.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) };

function seedInbox(inbox: InboxService) {
  return Number(inbox.ingest({
    channel: 'manual', externalId: 'fictional-inbox', kind: 'file',
    receivedAt: '2026-11-05T10:00:00Z', file: inboxFile,
  }).id);
}


test('清空业务数据连同往来条款、资金账户一起清', () => {
  const store = financeFixture();
  try {
    // 初始化时财务清的表（财务自己登记）：往来账期、资金账户都要清
    const financeTables = resetParticipants(['财务'], true).filter((r) => r.finance).flatMap((r) => Object.keys(resetCounts(store, r)));
    assert.ok(financeTables.includes('fin_party_terms'));
    assert.ok(financeTables.includes('fin_cash_accounts'));
    new FinanceCashAccounts(store).saveAccount(financeActor, {
      kind: 'bank',
      name: '虚构资金账户',
      accountCode: '1002',
      lastFour: '0001',
      requestId: 'bank',
    });
    const actor = who();
    new BusinessReset(store).execute({ scope: 'business' }, actor);
    assert.equal(count(store.db, 'SELECT count(*) FROM fin_cash_accounts'), 0);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.close();
  }
});

test('连财务一起初始化：财务设置和它的变更历史都保留，初始化后的送货单仍按原来的口径（开票确认收入）判', () => {
  const store = financeFixture();
  try {
    const settings = new FinanceSettings(store);
    settings.update(financeActor, { version: 3, requestId: 'policy', revenueRecognition: 'invoice' });
    const history = () => store.db.prepare('SELECT * FROM fin_settings_history ORDER BY id').all();
    const before = history();
    assert.deepEqual(
      before.map((r) => r.revenue_recognition),
      ['delivery', 'delivery', 'invoice'],
      '启用、改税率、改口径各记一行',
    );
    new BusinessReset(store).execute({ scope: 'business' }, who());
    assert.deepEqual(history(), before, '变更历史跟着财务设置保留');
    const kept = settings.get(financeActor);
    assert.equal(kept.revenueRecognition, 'invoice');
    assert.equal(kept.startPeriod, null, '启用月份清掉，要重新启用');
    // 重新启用后来一张送货单（虚构，直接写单据）：按保留下来的口径等开票，不按默认的送货确认
    settings.enable(financeActor, { period: '2026-01', taxpayer: 'general', version: kept.version, requestId: 'enable-again', rows: [] });
    const at = '2026-01-10T09:00:00.000Z';
    store.db
      .prepare(
        `INSERT INTO flow_documents(kind,number,date,planned_date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES('delivery','FICT-RESET-1','2026-01-10','2026-01-10','confirmed',?,?,?,?,?)`,
      )
      .run(
        JSON.stringify({
          date: '2026-01-10',
          plannedDate: '2026-01-10',
          customerId: 1,
          customerName: '虚构客户',
          // 确认时间晚于改口径的时间
          confirmedAt: new Date(Date.now() + 1000).toISOString(),
          lines: [{ orderId: 1, orderLineId: 1, stockId: 1, unit: '只', quantity: '1', unitPriceExact: '100.0000', taxMode: '未税', taxRate: '0' }],
        }),
        financeActor.id,
        financeActor.name,
        at,
        at,
      );
    const events = new FinanceEvents(store);
    assert.equal(events.sync(financeActor).processed, 1);
    const [event] = many(store.db, rows.fin_events.pick({ status: true, revenue_recognition: true }), "SELECT status,revenue_recognition FROM fin_events WHERE source_kind='delivery'");
    assert.equal(event?.revenue_recognition, 'invoice');
    assert.equal(event?.status, 'waiting_invoice');
  } finally {
    store.close();
  }
});

test('助手清空业务数据时，财务已有记录就拒绝，不留孤儿也不替财务写入', () => {
  const store = financeFixture();
  try {
    const actor = who();
    new FinanceCashAccounts(store).saveAccount(financeActor, {
      kind: 'bank',
      name: '虚构资金账户',
      accountCode: '1002',
      lastFour: '0001',
      requestId: 'bank',
    });
    businessBase(actor, store).customer({ name: '虚构客户' });
    const tools = toolsOf(store);
    assert.throws(
      () => tools.prepare('management.reset', { scope: 'business' }, actor, 'binding'),
      /财务/,
    );
    assert.ok(count(store.db, 'SELECT count(*) FROM customers'));
    // 预览时就说清楚，不等到执行才拒绝
    const preview = readAs(
      extraTools(store).read('management.reset_preview', { scope: 'business' }, actor),
      { financeRows: z.number(), blocked: z.string() },
    );
    assert.ok(preview.financeRows > 0);
    assert.match(preview.blocked, /系统维护/);
  } finally {
    store.close();
  }
});

test('业务删除保留独立收件及附件，业务初始化清理两张表并保留机器人设置', () => {
  const store = new Store(':memory:'), inbox = new InboxService(store),
    settings = new BotSettings(':memory:', { protect: (s) => s, unprotect: (s) => s });
  try {
    const id = seedInbox(inbox);
    settings.save('wecom_bot', { appId: 'fictional-bot', secret: 'fictional-secret', enabled: true });
    const before = settings.view('wecom_bot');
    const engine = new DatabaseMaintenanceService(store);
    const base = businessBase(superActor(), store);
    const customer = base.customer({ name: '待删除虚构客户' });
    const product = base.product({ name: '待删除虚构产品' });
    for (const [module, record, who] of [
      ['customers', customer, localAdministratorActor(superActor())],
      ['products', product, superActor()],
    ] as const) {
      const selection = { module, items: [{ id: record.id, version: record.version }] };
      const { digest } = engine.preview(selection, who);
      engine.delete({ ...selection, requestId: randomUUID(), deletionDigest: digest }, who, 'session');
      assert.equal(inbox.get(id).status, 'pending');
      assert.deepEqual(inbox.file(id).content, inboxFile.bytes);
    }
    assert.equal(store.customer(customer.id, true), undefined);
    assert.equal(store.product(product.id, true), undefined);
    // 识别导入用一个空的替身：只清工作区时什么都不删
    const reset = new BusinessReset(store, { deleteAllWorkspaces: () => ({ count: 0, ids: [], failed: [] }), clearArchive: () => 0 }),
      who = localAdministratorActor(superActor());
    const counts = reset.preview('business', who).tables;
    assert.equal(counts.inbox_items, 1);
    assert.equal(counts.inbox_files, 1);
    reset.execute({ scope: 'ai-imports' }, who);
    assert.deepEqual(inbox.file(id).content, inboxFile.bytes);
    reset.execute({ scope: 'business' }, who);
    assert.equal(inbox.list().totalRecords, 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM inbox_files'), 0);
    assert.deepEqual(settings.view('wecom_bot'), before);
    assert.equal(settings.credentials('wecom_bot')?.secret, 'fictional-secret');
  } finally {
    settings.close();
    store.close();
  }
});


test('本机最高管理员可一次清空业务数据，普通账号被拒绝，清理写入审计', () => {
  const f = assistantFixture();
  try {
    const base = businessBase(assistantActor, f.store);
    const previous = base.customer({ name: '一键清空客户' });
    base.product({
      name: '一键清空产品',
      length: 30,
      width: 20,
      height: 10,
      dimensionUnit: 'cm',
      material: 'BC',
      flute: 'BC',
    });
    assert.throws(
      () => f.manager.tools.prepare('management.reset', { scope: 'business' }, assistantActor, 'binding'),
      /最高管理员/,
    );
    const who = localAdministratorActor(assistantSuperActor());
    const plan = f.manager.tools.prepare('management.reset', { scope: 'business' }, who, 'binding');
    assert.equal(field(field(plan.before, 'tables'), 'customers'), 1);
    const result = z.looseObject({ count: z.number() }).parse(f.manager.tools.commit(plan, who, 'binding'));
    assert.equal(result.scope, 'business');
    assert.ok(result.count >= 2);
    assert.equal(
      field(field(f.manager.tools.prepare('management.reset', { scope: 'business' }, who, 'binding').before, 'tables'), 'customers'),
      0,
    );
    assert.equal(count(f.store.db, "SELECT count(*) FROM business_audit WHERE action = 'business-reset'"), 1);
    const next = base.customer({ name: '初始化后的虚构客户' });
    assert(next.id > previous.id, '保留的审计与旧任务不能指向复用ID的新记录');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('初始化后编号接着往上走，不再逐行写墓碑；单号里的序号就是真正分到的编号', () => {
  const store = new Store(':memory:');
  try {
    const actor = who(),
      base = businessBase(actor, store),
      { ops } = base;
    // 六类档案和单据各建一条，返回分到的编号和单号
    const seed = (tag: string) => {
      const customer = base.customer({ name: '虚构客户' + tag }),
        product = base.product({ name: '虚构纸箱' + tag }),
        supplier = base.supplier({ name: '虚构供应商' + tag }),
        item = base.raw({ name: '虚构纸板' + tag }),
        order = base.order(customer, [base.line(product, 100)], { orderDate: '2026-10-01', deliveryDate: '2026-10-30' }),
        purchase = ops.savePurchase(
          {
            supplierId: supplier.id,
            orderDate: '2026-10-01',
            status: '待订货',
            lines: [{ stockItemId: item.id, name: item.name, quantity: '10', unit: '张', priceBasis: 'quantity' }],
          },
          actor,
        );
      return {
        ids: {
          customers: customer.id,
          products: product.id,
          suppliers: supplier.id,
          stock_items: item.id,
          orders: order.id,
          purchases: purchase.id,
          order_lines: order.lines[0].id,
          purchase_lines: purchase.lines[0].id,
        },
        orderNumber: order.number,
        purchaseNumber: purchase.number,
        updatedAt: [customer, product, supplier, item].map((row) => [row.createdAt, row.updatedAt]),
      };
    };
    seed('甲');
    const before = seed('乙');
    // 新建时最后修改时间和建立时间相同
    for (const [createdAt, updatedAt] of before.updatedAt) assert.equal(updatedAt, createdAt);
    const tombstones = () => count(store.db, 'SELECT COUNT(*) FROM permanent_record_deletions');
    const sequences = () =>
      Object.fromEntries(
        store.db
          .prepare('SELECT name,seq FROM sqlite_sequence')
          .all()
          .map((r) => [String(r.name), Number(r.seq)]),
      );
    const marks = tombstones(),
      used = sequences();
    for (const [table, id] of Object.entries(before.ids)) assert.equal(used[table], id, table + ' 的编号水位');
    new BusinessReset(store).execute({ scope: 'business' }, actor);
    assert.equal(store.customers(true).length, 0);
    assert.equal(tombstones(), marks, '初始化不再逐行写墓碑');
    assert.deepEqual(sequences(), used, '初始化只清表，不动编号水位');
    const after = seed('丙');
    for (const [table, id] of Object.entries(before.ids))
      assert.equal((after.ids as Record<string, number>)[table], id + 1, table + ' 的编号接着往上走');
    assert.equal(after.orderNumber, 'ZX-20261001-' + String(after.ids.orders).padStart(4, '0'));
    assert.equal(after.purchaseNumber, 'CG-20261001-' + String(after.ids.purchases).padStart(4, '0'));
    assert.notEqual(after.orderNumber, before.orderNumber);
    assert.notEqual(after.purchaseNumber, before.purchaseNumber);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.close();
  }
});


test('清空全部数据同时删除AI识别工作区和原件', async () => {
  const f = createOrderWorkflowFixture();
  try {
    await f.imports.upload(imageFixture(true), 'invoice.jpg', true);
    assert.equal(f.imports.status().workspaces.length, 1);
    const who = localAdministratorActor(assistantSuperActor());
    const plan = f.manager.tools.prepare('management.reset', { scope: 'all' }, who, 'binding');
    const result = z.looseObject({ aiImports: z.number() }).parse(f.manager.tools.commit(plan, who, 'binding'));
    assert.equal(result.scope, 'all');
    assert.ok(result.aiImports >= 1);
    assert.equal(f.imports.status().workspaces.length, 0);
    assert.equal(f.imports.archives().length, 0);
    assert.equal(f.store.customers().length, 0);
  } finally {
    f.close();
  }
});

test('初始化的范围：每张表要么由所属模块登记清空，要么写明为什么保留，新表不会被悄悄漏掉', () => {
  const store = new Store(':memory:');
  try {
    // 初始化后留着的表和理由；新加的表没登记清空、也不在这里，就会被拦下
    const kept: Record<string, string> = {
      schema_migrations: '数据库升级记录',
      business_audit: '审计保留，初始化本身也记一条',
      permanent_record_deletions: '永久删除的墓碑，初始化不清',
      number_sequences: '按天的流水号计数保留，初始化后单号不回头',
      document_template_settings: '单据模板设置保留',
      assistant_threads: '助手对话保留（只清业务数据）',
      assistant_messages: '同上',
      assistant_runs: '同上',
      assistant_previews: '同上',
      assistant_audit: '同上',
      assistant_attachments: '同上',
      assistant_message_attachments: '同上',
      fin_settings: '财务设置保留，只清掉启用月份',
      fin_settings_history: '财务设置的变更历史跟着财务设置保留，否则初始化后口径会按默认值判',
      fin_accounts: '科目表保留，只清掉“用过”标记',
      fin_templates: '凭证模板保留',
    };
    const all = store.db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => String(r.name));
    const cleared = new Set(
      resetParticipants(['业务汇总', '识别导入', '单据流转', '采购库存', '单据导出', '基础'], true).flatMap((r) => Object.keys(resetCounts(store, r))),
    );
    assert.deepEqual(all.filter((t) => !cleared.has(t) && !kept[t]), [], '没登记清空、也没写明保留的表');
    assert.deepEqual([...cleared].filter((t) => !all.includes(t)), [], '登记清空的表都在库里');
    assert.deepEqual(Object.keys(kept).filter((t) => cleared.has(t) || !all.includes(t)), [], '保留清单和实际一致');
  } finally {
    store.close();
  }
});
