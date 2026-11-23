// 整批登记完工（server/flow/production/batch-completion.ts、production-completion.ts）：预览不扣库存、共用纸板按产量比例分，
// 版本变化、库存不足整批拒绝，只登记稍后核对入库，剩余量扣掉待入库的，不挂任务的完工同一个入口。单张完工见 production-completion-single.test.ts。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, count, one, parseStoredJson, rows } from '../server/core/index.js';
import { ManualProductionCompletion } from '../server/flow/production/production-completion.js';
import { ProductionCompletion } from '../server/flow/index.js';
import { today } from '../shared/core/domain.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { assistantProductionCompletionSchema, type FlowDocView } from '../shared/business/index.js';
import { AuthManager } from '../server/accounts/index.js';
import { startHttp } from './http-fixture.js';
import { completionFixture as fixture } from './completion-fixture.js';
import { actor } from './actor-fixture.js';
import { readAs } from './read-result.js';

/** 完工单里和拆分有关的内容：合格、报废、用料、操作人、日期、批次备注（按任务排好） */
const split = (docs: FlowDocView<'production'>[]) =>
  docs
    .slice()
    .sort((a, b) => Number(a.taskId) - Number(b.taskId))
    .map((d) => ({
      good: d.goodQuantity,
      scrap: d.scrapQuantity,
      operator: d.operator,
      date: d.date,
      notes: d.notes,
      materials: d.materials.map((m) => ({ issued: m.issued, returned: m.returned })),
    }));
const movementCount = (store: Store) => count(store.db, 'SELECT COUNT(*) AS n FROM stock_movements');
const auditCount = (store: Store, action: string) =>
  count(store.db, "SELECT COUNT(*) AS n FROM business_audit WHERE entity='flow_production' AND action=?", action);
/** 自动新建、恢复库存品时审计里记的原因和哪张单据 */
const autoStockAudit = z.looseObject({ reason: z.string(), document: z.string() });

test('整批完工：预览不动库存、不建单据，执行后按共用纸板分完；同一请求再交不重复', () => {
  const f = fixture();
  try {
    const input = f.input(),
      preview = f.completion.preview(input, actor);
    assert.equal(preview.verified, false);
    assert.equal(f.ops.balance(f.raw.id), 100000);
    assert.equal(f.flow.list('production').length, 0);
    assert.equal(f.ops.items().filter((s) => s.kind === 'finished').length, 0);
    f.completion.execute({ input, previewDigest: preview.previewDigest }, actor);
    assert.equal(f.ops.balance(f.raw.id), 95000);
    assert.equal(f.flow.list('production').length, 2);
    f.completion.execute({ input, previewDigest: preview.previewDigest }, actor);
    assert.equal(f.flow.list('production').length, 2);
    assert.equal(f.ops.balance(f.raw.id), 95000);
  } finally {
    f.store.close();
  }
});

test('整批完工版本变化、错误领料分配、缺少真实产量及库存不足不产生半单', () => {
  const f = fixture();
  try {
    const input = f.input(),
      preview = f.completion.preview(input, actor);
    f.flow.schedule(f.tasks[0].id, { plannedDate: '2026-11-03', expectedVersion: f.tasks[0].version, requestId: randomUUID() }, actor);
    assert.throws(() => f.completion.execute({ input, previewDigest: preview.previewDigest }, actor), /已变化/);
    assert.throws(
      () => f.completion.preview({ ...f.input(), materials: [{ stockId: f.raw.id, unit: '张', issued: '500', returned: '0' }] }, actor),
      /库存不足/,
    );
    assert.equal(f.flow.list('production').length, 0);
    assert.equal(f.ops.balance(f.raw.id), 100000);
    assert.throws(() => f.completion.preview({ ...f.input(), quantities: undefined, goodRatePct: 90 }, actor), /须提供实际良品/);
    assert.throws(() => f.completion.preview(f.input(), { ...actor, permissions: [] }), /权限/);
  } finally {
    f.store.close();
  }
});

test('登记完工的接口：预览不扣库存、执行才扣；单独 POST /flow/production 不再新建完工单', async () => {
  const f = fixture(),
    h = await startHttp(f.store, { auth: new AuthManager(':memory:', Date.now, { localAdministration: true }) });
  try {
    const input = f.input();
    let r = await h.post('/flow/production-completion/preview', input);
    assert.equal(r.status, 200);
    const preview = readAs(await r.json(), { previewDigest: z.string() });
    assert.equal(f.ops.balance(f.raw.id), 100000);
    r = await h.post('/flow/production-completion/execute', { input, previewDigest: preview.previewDigest });
    assert.equal(r.status, 200);
    assert.equal(f.ops.balance(f.raw.id), 95000);
    r = await h.post('/flow/production', { date: today(), productId: f.tasks[0].productId, goodQuantity: '1', operator: '虚构', materials: [{ stockId: f.raw.id, issued: '1' }] });
    assert.equal(r.status, 409);
    assert.match(readAs(await r.json(), { message: z.string() }).message, /登记完工请用“登记完工”/);
  } finally {
    h.server.closeAllConnections();
    await h.close();
    f.store.close();
  }
});

test('批量完工入哪个成品库存由产品决定：没有就按产品新建，已归档的自动恢复再入库（写审计），不能另行指定；批次备注记到每张完工单', () => {
  const f = fixture();
  try {
    const [first, second] = f.tasks;
    // 第二个产品原来有成品库存，后来归档了（有没做完的任务时界面不让归档，这里直接打归档标记造出这种样子）
    const parked = f.ops.saveItem({ name: '随便写', kind: 'finished', unit: '只', productId: second.productId }, actor);
    f.store.markArchived('stock_items', parked.id, actor.id);
    // 入哪个成品库存不用指定，参数里也没有这一项
    assert.throws(() =>
      new ProductionCompletion(f.store).execute({ ...f.input(), finishedStocks: [{ taskId: first.id, stockId: parked.id }] }, actor),
    );
    assert.equal(f.flow.list('production').length, 0);
    assert.equal(f.store.archived('stock_items', parked.id), true);
    // 批次备注：一次登记写一句，生成的每张完工单都记上
    const result = new ProductionCompletion(f.store).execute({ ...f.input(), notes: '  这批用的B楞纸板，边上有点潮  ' }, actor);
    const docs = f.flow.list('production');
    assert.equal(docs.length, 2);
    for (const d of docs) assert.equal(d.notes, '这批用的B楞纸板，边上有点潮');
    // 第一个产品新建了成品库存（名称、尺寸、材质、楞型按产品），第二个产品用恢复的那个
    const finished = f.ops.items(true).filter((s) => s.kind === 'finished');
    assert.equal(finished.length, 2);
    const made = finished.find((s) => s.productId === first.productId);
    assert.ok(made);
    assert.deepEqual([made.name, made.length, made.width, made.height, made.dimensionUnit, made.material, made.flute], ['虚构纸箱甲', 300, 200, 150, 'mm', 'K=A', 'B']);
    assert.deepEqual(result.results.map((r) => r.finishedStockId), [made.id, parked.id]);
    assert.equal(result.count, 6, '新建一个成品库存、恢复一个、两张完工各登记和确认（任务安排时已下达）');
    assert.equal(f.store.archived('stock_items', parked.id), false);
    assert.equal(f.ops.balance(parked.id), 2000);
    // 审计看得出是登记哪张任务的完工时自动恢复、自动新建的，和人手动新建分得开
    const auditOf = (id: number, action: string) => {
      const row = one(
        f.store.db,
        rows.business_audit.pick({ source: true, document: true }),
        "SELECT source,document FROM business_audit WHERE entity='stock_items' AND record_id=? AND action=?",
        id,
        action,
      );
      assert.ok(row, '库存品 ' + id + ' 应有 ' + action + ' 审计');
      return { source: row.source, document: parseStoredJson(autoStockAudit, row.document, 'business_audit.document') };
    };
    const restored = auditOf(parked.id, 'restore').document;
    assert.match(restored.reason, /完工入库时自动恢复已归档的库存品/);
    assert.equal(restored.document, '生产任务 ' + second.number);
    const created = auditOf(made.id, 'create');
    assert.equal(created.source, AUDIT_SOURCE.page, '登记完工是在页面上做的，自动新建的那条也记页面');
    assert.deepEqual(
      [created.document.reason, created.document.document],
      ['登记完工时按产品自动新建', '生产任务 ' + first.number],
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('只登记、稍后核对入库：同一组输入和直接入库拆得一样，不动库存；逐张核对入库后和直接入库结果相同；重复提交不重复', () => {
  const a = fixture(),
    b = fixture();
  try {
    // 合格数和报废不整除，按比例分整张时要用到最大余数
    const quantities = (f: typeof a) => [
      { taskId: f.tasks[0].id, goodQuantity: '3', scrapQuantity: '0' },
      { taskId: f.tasks[1].id, goodQuantity: '1', scrapQuantity: '1' },
    ];
    const input = { ...a.input(), quantities: quantities(a), notes: '虚构批次：边上有点潮', pending: true };
    const movements = movementCount(a.store);
    const preview = a.completion.preview(input, actor);
    assert.equal(preview.inventoryChanged, false);
    const result = a.completion.execute({ input, previewDigest: preview.previewDigest }, actor);
    assert.deepEqual([result.pending, result.inventoryChanged, result.message], [true, false, '已登记2张完工，待核对入库']);
    assert.equal(result.count, 4, '两个产品各新建成品库存、两张待入库完工单（任务安排时已下达）');
    // 不动库存：流水一条没多，原料没扣，成品库存（保存时按产品新建）余额是 0
    assert.equal(movementCount(a.store), movements);
    assert.equal(a.ops.balance(a.raw.id), 100000);
    for (const r of result.results) assert.equal(a.ops.balance(r.finishedStockId), 0);
    const pending = a.flow.list('production');
    assert.ok(pending.length === 2 && pending.every((d) => d.status === 'draft'));
    // 存待入库走的是单张完工的保存服务，每张都有“新建待核对单据”的审计
    assert.equal(auditCount(a.store, 'create-draft'), 2);
    // 同一组输入直接入库：拆分（合格、报废、用料、操作人、日期、批次备注）完全一样
    const direct = new ProductionCompletion(b.store).execute({ ...b.input(), quantities: quantities(b), notes: '虚构批次：边上有点潮' }, actor);
    assert.equal(direct.pending, false);
    const stocked = b.flow.list('production');
    assert.deepEqual(split(pending), split(stocked));
    assert.deepEqual(
      pending.map((d) => d.materials.reduce((n, m) => n + Number(m.issued), 0)).sort(),
      [2, 3],
      '5 张按 3:2 分到两张任务',
    );
    // 重复提交（双击、网络重试）原样返回，不再存一遍
    assert.deepEqual(a.completion.execute({ input, previewDigest: preview.previewDigest }, actor), result);
    assert.equal(a.flow.list('production').length, 2);
    assert.equal(auditCount(a.store, 'create-draft'), 2);
    // 之后逐张核对入库：库存、流水和直接入库的一样
    for (const d of pending) {
      a.base.check(d, {}, actor);
    }
    assert.equal(a.ops.balance(a.raw.id), 95000);
    assert.equal(b.ops.balance(b.raw.id), 95000);
    assert.equal(movementCount(a.store), movementCount(b.store));
    const finished = (f: typeof a) =>
      f.ops
        .items()
        .filter((s) => s.kind === 'finished')
        .map((s) => [s.productId, f.ops.balance(s.id)])
        .sort();
    assert.deepEqual(finished(a), finished(b));
    assert.deepEqual(split(a.flow.list('production')), split(stocked));
    assert.ok(a.flow.list('production').every((d) => d.status === 'confirmed'));
    assert.deepEqual(a.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    a.store.close();
    b.store.close();
  }
});

test('只登记：库存够不够照单张待入库的规则（登记不拦、核对入库时拦）；没有权限被拒', () => {
  const f = fixture();
  try {
    const short = { ...f.input(), materials: [{ stockId: f.raw.id, unit: '张', issued: '500', returned: '0' }] };
    // 直接入库：库存不够整批拒绝
    assert.throws(() => new ProductionCompletion(f.store).execute(short, actor), /库存不足/);
    assert.equal(f.flow.list('production').length, 0);
    // 只登记：和单张完工存成待入库一样不拦，核对入库时才拦
    assert.equal(new ProductionCompletion(f.store).execute({ ...short, pending: true }, actor).results.length, 2);
    assert.equal(f.ops.balance(f.raw.id), 100000);
    const first = f.flow.list('production')[0];
    assert.throws(() => {
      f.base.check(first, {}, actor);
    }, /库存不足/);
    assert.equal(f.ops.balance(f.raw.id), 100000);
    assert.throws(() => new ProductionCompletion(f.store).execute({ ...f.input(), pending: true }, { ...actor, permissions: [] }), /权限/);
  } finally {
    f.store.close();
  }
});

test('只登记中途一张出错（产品归档了）：整批不写，失败记一条审计', () => {
  const f = fixture();
  try {
    const product = sales(f.store).product(f.tasks[1].productId);
    assert.ok(product);
    assert.ok(changeLifecycle(f.store, 'products', { action: 'archive', items: [{ id: product.id, version: product.version }] }, actor).results[0].success);
    const movements = movementCount(f.store);
    assert.throws(() => new ProductionCompletion(f.store).execute({ ...f.input(), pending: true }, actor), /关联产品不可用/);
    assert.equal(f.flow.list('production').length, 0);
    assert.ok(f.flow.list('task').every((t) => t.status === 'confirmed'));
    assert.equal(f.ops.items(true).filter((s) => s.kind === 'finished').length, 0);
    assert.equal(auditCount(f.store, 'create-draft'), 0);
    assert.equal(movementCount(f.store), movements);
    assert.ok(f.store.db.prepare("SELECT 1 FROM business_audit WHERE action='failed-completion'").get());
  } finally {
    f.store.close();
  }
});

test('剩余量扣掉待入库的完工单：先登记过全部剩余量的，再登记（只登记或直接入库）都被拒；“全部待完工”不再带上它', () => {
  const f = fixture();
  try {
    const one = (extra: object) => ({ ...f.input(), taskIds: [f.tasks[0].id], quantities: [{ taskId: f.tasks[0].id, goodQuantity: '3', scrapQuantity: '0' }], ...extra });
    new ProductionCompletion(f.store).execute(one({ pending: true }), actor);
    for (const pending of [true, false])
      assert.throws(() => new ProductionCompletion(f.store).execute(one({ pending }), actor), /剩下的数量已经登记过完工，在等核对入库/);
    assert.equal(f.flow.list('production').length, 1);
    const all = (extra: object = {}) =>
      new ProductionCompletion(f.store).execute({ ...f.input(), taskIds: undefined, allActive: true, quantities: undefined, ...extra }, actor);
    assert.deepEqual(all({ pending: true }).results.map((r) => r.taskId), [f.tasks[1].id], '“全部待完工”只剩第二张任务');
    assert.throws(() => all(), /没做完的生产任务剩下的数量都已经登记过完工，在等核对入库/);
  } finally {
    f.store.close();
  }
});

test('剩余量扣掉待入库的完工单：计划 3 只先登记 1 只待入库，再登记最多 2 只（不传产量时默认的“全部剩余”也是 2 只）', () => {
  const f = fixture(),
    g = fixture();
  try {
    const one = (h: typeof f, good: string | null, extra: object = {}) => ({
      ...h.input(),
      taskIds: [h.tasks[0].id],
      quantities: good === null ? undefined : [{ taskId: h.tasks[0].id, goodQuantity: good, scrapQuantity: '0' }],
      ...extra,
    });
    new ProductionCompletion(f.store).execute(one(f, '1', { pending: true }), actor);
    // 报错用界面上的叫法（合格、还差），说清还差多少、扣掉了多少待核对入库的
    assert.throws(
      () => new ProductionCompletion(f.store).execute(one(f, '3'), actor),
      (e: unknown) => e instanceof Error && /^生产任务 \S+ 的合格数不能超过还差的 2 只（已扣掉已登记、待核对入库的 1 只），请核对实际产量。$/.test(e.message),
    );
    assert.throws(() => new ProductionCompletion(f.store).execute(one(f, '3', { pending: true }), actor), /合格数不能超过还差的 2 只/);
    assert.equal(new ProductionCompletion(f.store).execute(one(f, '2'), actor).results[0].goodQuantity, '2');
    new ProductionCompletion(g.store).execute(one(g, '1', { pending: true }), actor);
    assert.equal(new ProductionCompletion(g.store).execute(one(g, null, { pending: true }), actor).results[0].goodQuantity, '2');
  } finally {
    f.store.close();
    g.store.close();
  }
});

test('登记完工的日期不能填未来：直接入库和只登记同一条规则，登记时就拦，不等核对入库', () => {
  const tomorrow = today(new Date(Date.now() + 86400000));
  for (const pending of [false, true]) {
    const f = fixture();
    try {
      const input = { ...f.input(), date: tomorrow, pending };
      assert.throws(() => f.completion.preview(input, actor), /完工日期不能晚于今天/);
      assert.throws(() => new ProductionCompletion(f.store).execute(input, actor), /完工日期不能晚于今天/);
      assert.equal(f.flow.list('production').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('登记完工一个入口：不挂任务的完工（打样、补做）和挂任务的同一批登记、领料按产量比例一起分', () => {
  const f = fixture();
  try {
    const productId = f.tasks[0].productId;
    const alone = {
      requestId: randomUUID(),
      date: today(),
      allocation: 'shared-proportional' as const,
      materials: [{ stockId: f.raw.id, unit: '张' as const, issued: '1', returned: '0' }],
      untasked: [{ productId, goodQuantity: '2', scrapQuantity: '0' }],
    };
    const manual = new ManualProductionCompletion(f.store);
    const done = manual.execute({ input: alone, previewDigest: manual.preview(alone, actor).previewDigest }, actor);
    assert.deepEqual(done.results.map((r) => [r.taskId, r.productId]), [[null, productId]]);
    const doc = f.flow.get(done.results[0].productionId, 'production');
    assert.deepEqual([doc.status, doc.taskId ?? null, doc.goodQuantity], ['confirmed', null, '2']);
    // 挂任务的和不挂任务的一起登记：领料按产量比例分到每一张
    const both = new ProductionCompletion(f.store).execute({ ...f.input(), untasked: [{ productId, goodQuantity: '1', scrapQuantity: '0' }] }, actor);
    assert.equal(both.results.length, f.tasks.length + 1);
    assert.equal(both.results.at(-1)?.taskId, null);
    // 逐任务给定领料时不能带不挂任务的行
    assert.throws(
      () => new ProductionCompletion(f.store).execute({ ...alone, requestId: randomUUID(), allocation: 'explicit', distribution: [] }, actor),
      /有不挂任务的完工时，领料按产量比例分/,
    );
    assert.throws(() => new ProductionCompletion(f.store).execute({ ...alone, requestId: randomUUID(), untasked: [] }, actor), /请选生产任务，或者填不挂任务的完工/);
  } finally {
    f.store.close();
  }
});

test('不挂任务的完工和挂任务的同一个规则：废品数要明确写，给了良品率要对得上，100% 良品不能有废品', () => {
  const f = fixture();
  try {
    const productId = f.tasks[0].productId;
    const base = { requestId: randomUUID(), date: today(), allocation: 'shared-proportional' as const, materials: [{ stockId: f.raw.id, unit: '张' as const, issued: '1', returned: '0' }] };
    const run = (extra: object) => new ProductionCompletion(f.store).execute({ ...base, requestId: randomUUID(), ...extra }, actor);
    // 废品数没写：不替人按 0 补（人工和助手同一份结构，助手那份另外要求日期）
    assert.throws(() => run({ untasked: [{ productId, goodQuantity: '2' }] }), /scrapQuantity|废品/);
    assert.equal(assistantProductionCompletionSchema.safeParse({ ...base, untasked: [{ productId, goodQuantity: '2' }] }).success, false);
    assert.throws(() => run({ goodRatePct: 100, untasked: [{ productId, goodQuantity: '2', scrapQuantity: '1' }] }), /良品率与实际良品\/废品数量不一致|100%良品与非零废品数量矛盾/);
    assert.throws(() => run({ goodRatePct: 50, untasked: [{ productId, goodQuantity: '3', scrapQuantity: '1' }] }), /良品率与实际良品\/废品数量不一致（按实际产量为75.00%）/);
    assert.equal(f.flow.list('production').length, 0, '拦下的什么都没写');
    const ok = run({ goodRatePct: 75, untasked: [{ productId, goodQuantity: '3', scrapQuantity: '1' }] });
    assert.deepEqual([ok.results[0].goodQuantity, ok.results[0].scrapQuantity], ['3', '1']);
  } finally {
    f.store.close();
  }
});
