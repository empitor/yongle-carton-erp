// 管理员更正到货单：助手只有 arrival.correct 一个工具、网页走真实身份和原服务、入库 0 的行、新加的行、替代单的单号。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthManager } from '../server/accounts/index.js';
import { toolsOf } from './assistant-fixture.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { correctDocument, planCorrection } from '../server/flow/index.js';
import { productSchema, today } from '../shared/core/domain.js';
import { ofKind, saveDoc } from './receive-fixture.js';
import { startHttp } from './http-fixture.js';
import { flowFixture, localAdmin, clerk } from './flow-fixture.js';
import { fixture, owner } from './admin-edit-fixture.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { count, one, rows } from '../server/core/index.js';
import {
  arrivalCorrectionExtraSchema,
  arrivalCorrectionViewSchema,
  correctionResultSchema,
  flowScheduledSchema,
  type arrivalCorrectionPreviewSchema,
} from '../shared/business/index.js';
import type { z } from 'zod';
import { actor } from './actor-fixture.js';

/** 到货更正每行的输入（按原单的行号改数量，或加新行） */
type CorrectionLines = z.input<typeof arrivalCorrectionPreviewSchema>['lines'];

test('助手的到货更正（arrival.correct，id 是到货单编号，加每行新数量）：卡片就是预览，确认才改；停用后不能调', async () => {
  const f = fixture(),
    registry = new AssistantToolRegistry();
  try {
    f.receive();
    const tools = toolsOf(f.store),
      arrivalId = Number(String(f.current().receipts[0].id).replace('flow-', ''));
    const input = {
      id: arrivalId,
      expectedVersion: f.flow.get(arrivalId).version,
      reason: '虚构验收：历史录入错误',
      lines: [{ index: 0, quantity: '5000' }],
    };
    const handlers = { read: () => null, business: () => null, workflow: () => null };
    const plan = tools.prepare('arrival.correct', input, owner(), 'test');
    assert.equal(field(plan.args.input, 'previewDigest'), field(plan.after, 'previewDigest'), '卡片上的就是预览');
    assert.equal(f.current().lines[0].receivedQuantity, '10000', '出卡片不改');
    tools.commit(plan, owner(), 'test');
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
    assert.equal(f.ops.items()[0].quantity, '5000', '库存跟着变');
    // 启停助手工具要在超级管理员模式里
    const superMode = { ...owner(), superAdminMode: true, superAdminUntil: Date.now() + 60_000 };
    registry.set({ name: 'arrival.correct', enabled: false, expectedRevision: registry.view().revision }, superMode);
    await assert.rejects(() => registry.dispatch('arrival.correct', input, owner(), handlers), /停用/);
  } finally {
    registry.close();
    f.store.close();
  }
});

test('HTTP更正到货单与排程复用真实身份、CSRF和原服务；改单价要本机管理员，远程及转发头不能得到本机权限', async () => {
  const f = fixture(),
    h = await startHttp(f.store, {
      auth: new AuthManager(':memory:', Date.now, { localAdministration: true }),
      admin: { name: '虚构排程管理员', password: 'Fictional-schedule-password-123' },
    });
  try {
    f.receive();
    const post = (path: string, input: unknown, extra: Record<string, string> = {}) =>
      h.send(path, input, h.cookie, { headers: extra });
    // 新地址按到货单认单；数量改成 5000、单价改成 2.5（改单价是本机管理员的事）
    const receipt = f.current().receipts[0],
      path = '/flow/' + receipt.flowId,
      input = { expectedVersion: receipt.version, reason: '虚构验收：历史录入错误', lines: [{ index: 0, quantity: '5000', unitPrice: '2.5' }] };
    assert.equal(
      (await post(path + '/correction-preview', input, { 'X-Forwarded-For': '127.0.0.1' })).status,
      403,
    );
    const plan = arrivalCorrectionViewSchema.parse(await (await post(path + '/correction-preview', input)).json());
    assert.ok(plan.previewDigest);
    const denied = await post(
      path + '/correct',
      { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() },
      { 'X-ERP-Auth-Token': '' },
    );
    assert.equal(denied.status, 403);
    const saved = await post(path + '/correct', {
      ...input,
      previewDigest: plan.previewDigest,
      requestId: randomUUID(),
    });
    assert.equal(saved.status, 200);
    assert.equal(correctionResultSchema('arrival', arrivalCorrectionExtraSchema).parse(await saved.json()).verified, true);
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
    assert.equal(f.ops.items()[0].quantity, '5000');
    // 采购单下面的老地址没有了，更正只走到货单的地址
    const again = f.current().receipts.find((r) => r.effective);
    assert.ok(again);
    assert.equal((await post('/purchases/' + f.purchase.id + '/receipts/' + again.id + '/correction-preview', f.input('4000'))).status, 404);
    // 已入库的到货单不能用保存接口直接改（本机管理员也一样）
    const doc = f.flow.get(again.flowId);
    const put = await h.send('/flow/' + doc.id, { ...doc, notes: '虚构备注', requestId: randomUUID() }, h.cookie, { method: 'PUT' });
    assert.equal(put.status, 409);
    const product = sales(f.store).createProduct(productSchema.parse({ name: '虚构HTTP排程产品' }));
    const task = saveDoc(f.flow, 
      'task',
      { date: today(), productId: product.id, quantity: '20', unit: '只' },
      actor,
    );
    const schedule = {
      expectedVersion: task.version,
      plannedDate: '2027-01-02',
      requestId: randomUUID(),
    };
    assert.equal(
      (await post('/flow/' + task.id + '/schedule', schedule, { 'X-ERP-Auth-Token': '' })).status,
      403,
    );
    assert.equal(
      (await post('/flow/' + task.id + '/schedule', { ...schedule, plannedDate: '2026-02-30' }))
        .status,
      400,
    );
    const scheduled = await post('/flow/' + task.id + '/schedule', schedule);
    assert.equal(scheduled.status, 200);
    assert.equal(flowScheduledSchema.parse(await scheduled.json()).document.plannedDate, '2027-01-02');
  } finally {
    await h.close();
    f.store.close();
  }
});

test('到货更正的替代单：最后一张单据删掉过，替代单不接上它的单号，单号里的序号就是编号', () => {
  const f = fixture();
  try {
    f.receive();
    // 今天再登记一张还没核对的到货，然后直接从库里删掉：它是编号最大的单据，单号和替代单同一天、同一个前缀
    const pending = saveDoc(f.flow, 
      'arrival',
      {
        date: today(),
        supplierId: f.supplier.id,
        reference: randomUUID(),
        lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '100' }],
      },
      actor,
    );
    f.store.db.prepare('DELETE FROM flow_refs WHERE document_id=?').run(pending.id);
    f.store.db.prepare('DELETE FROM flow_documents WHERE id=?').run(pending.id);
    f.edit('4000');
    const replacement = one(
      f.store.db,
      rows.flow_documents.pick({ id: true, number: true }),
      'SELECT id,number FROM flow_documents ORDER BY id DESC LIMIT 1',
    );
    assert.ok(replacement, '有替代单');
    assert.equal(replacement.id, pending.id + 1, '替代单的编号接着往上走');
    assert.notEqual(replacement.number, pending.number, '不接上被删单据的单号');
    assert.equal(
      replacement.number,
      'DH-' + today().replaceAll('-', '') + '-' + String(replacement.id).padStart(5, '0'),
      '单号里的序号等于编号',
    );
  } finally {
    f.store.close();
  }
});

test('已入库到货单有一行入库 0：更正时入库 0 的行不记 0 数量流水，改成合格入库才多出一笔', async () => {
  const f = flowFixture();
  try {
    // 两行同一种纸板：一行全部不合格（入库 0），一行正常入库
    const d = f.confirm('arrival', {
      supplierId: f.supplier.id,
      reference: '虚构送货单-零入库',
      lines: [
        {
          stockId: f.raw.id,
          item: { name: f.raw.name, unit: '张' },
          quantity: '5000',
          acceptedQuantity: '0',
          rejectedQuantity: '5000',
          stockedQuantity: '0',
        },
        { stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '3000' },
      ],
    });
    const moves = () =>
      f.store.db
        .prepare('SELECT seq,id,item_id,delta_units,source_kind,source_id FROM stock_movements ORDER BY seq')
        .all()
        .map((m) => ({ ...m }));
    const record = (id: number) =>
      f.flow.arrivalRecords({ includeInactive: true }).find((r) => r.flowId === id) ?? assert.fail('没有到货单 ' + id + ' 的到货记录');
    const revisions = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_movement_revisions');
    const correct = (id: number, lines: CorrectionLines) => {
      const input = { expectedVersion: f.flow.get(id).version, reason: '虚构更正', lines };
      const plan = planCorrection(f.store, id, input, clerk);
      return ofKind(correctDocument(f.store, id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, clerk), 'arrival').replacementFlowId;
    };
    /** 一张到货单名下的入库流水 */
    const inbound = (id: number) =>
      moves()
        .filter((m) => m.source_kind === 'flow_arrival' && m.source_id === String(id))
        .map((m) => Number(m.delta_units));
    const before = moves();
    assert.deepEqual(before.map((m) => Number(m.delta_units)), [3000000], '确认时入库 0 的行不记流水');
    assert.equal(record(d.id).inventoryStatus, '部分入库');

    // 正常那一行 3000 更正成 2500：原来那笔流水不改写，替代单只记这一行的入库，入库 0 的行仍然没有流水
    const second = correct(d.id, [{ index: 0, quantity: '5000' }, { index: 1, quantity: '2500' }]);
    assert.deepEqual(moves().slice(0, before.length), before);
    assert.deepEqual(inbound(second), [2500000]);
    assert.equal(revisions(), 0);
    assert.equal(f.ops.balance(f.raw.id), 2500000);
    assert.equal(record(second).inventoryStatus, '部分入库', '不会变成入库待核对');
    assert.deepEqual(
      record(second).lines.map((l) => [l.stockedQuantity, l.inventoryMismatch]),
      [
        ['0', false],
        ['2500', false],
      ],
    );
    assert.equal(record(d.id).inventoryStatus, '原单已失效');

    // 把入库 0 的那一行更正成全部合格入库：这时才多出这一行的入库流水
    const third = correct(second, [
      { index: 0, quantity: '5000', acceptedQuantity: '5000', rejectedQuantity: '0', stockedQuantity: '5000' },
      { index: 1, quantity: '2500' },
    ]);
    assert.deepEqual(inbound(third).sort((a, b) => a - b), [2500000, 5000000]);
    assert.ok(moves().every((m) => Number(m.delta_units) !== 0), '库里没有 0 数量的流水');
    assert.equal(f.ops.balance(f.raw.id), 7500000);
    assert.equal(record(third).inventoryStatus, '已入库');
    assert.equal(revisions(), 0, '流水只追加，没有改写');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('本机管理员更正到货单时加一行数量 0、没选库存品的新行：拒收并说清怎么办，不会建出空的库存品；数量大于 0 的新行照常建库存品并入库', async () => {
  const f = flowFixture(),
    who = localAdmin();
  try {
    const d = f.arrive('虚构送货单-加行', '1000');
    const items = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_items');
    const moves = () =>
      f.store.db
        .prepare('SELECT seq,id,item_id,delta_units,source_kind,source_id FROM stock_movements ORDER BY seq')
        .all()
        .map((m) => ({ ...m }));
    const correct = (quantity: string) => {
      const input = {
        expectedVersion: f.flow.get(d.id).version,
        reason: '虚构：补登一行',
        lines: [{ index: 0, quantity: '1000' }, { quantity, item: { name: '虚构新纸板', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' } }],
      };
      const plan = planCorrection(f.store, d.id, input, who);
      return f.flow.get(ofKind(correctDocument(f.store, d.id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, who), 'arrival').replacementFlowId, 'arrival');
    };
    const before = { items: items(), moves: moves() };

    // 数量 0 又没选库存品：什么货都没有，拒收
    assert.throws(
      () => correct('0'),
      /第 2 行的数量是 0，又没有选库存品。这一行没到货就删掉这一行，到了货请填数量。/,
    );
    assert.deepEqual({ items: items(), moves: moves() }, before, '没有建出空的库存品，流水没变');
    assert.equal(f.flow.get(d.id, 'arrival').lines.length, 1);
    assert.equal(f.flow.get(d.id).status, 'confirmed');

    // 数量大于 0 的新行：照常新建库存品并入库（替代单上）
    const saved = correct('200');
    assert.equal(items(), before.items + 1);
    const created = saved.lines[1].stockId;
    assert.ok(created && created !== f.raw.id);
    assert.equal(f.ops.balance(created), 200000);
    assert.equal(f.ops.balance(f.raw.id), 1000000);
    assert.ok(moves().every((m) => Number(m.delta_units) !== 0));
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
