// 本机管理员更正已入库的到货单（server/flow/arrival-correction-plan.ts）：改日期、送货单号、单价，增删行，换挂订货单里的采购明细。
// 同样撤销原单、另出替代单；挂的明细、库存品、送货单号守登记到货的规矩。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk, localAdmin } from './flow-fixture.js';
import { errorMessage } from '../shared/core/error-message.js';
import { correctionFixture, ofKind, orderedPurchase, saveDoc } from './receive-fixture.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { AppError } from '../server/core/errors.js';
import { count } from '../server/core/index.js';
import type { Actor } from '../server/core/actor.js';
import type { arrivalCorrectionPreviewSchema } from '../shared/business/index.js';
import type { z } from 'zod';

/** 到货更正每行的输入（按原单的行号改数量，或加新行） */
type CorrectionLines = z.input<typeof arrivalCorrectionPreviewSchema>['lines'];
/** 出错是不是给人看的业务错误、状态码对得上 */
const failed = (e: unknown, status: number) => e instanceof AppError && e.status === status;

function fixture(received = '1000') {
  const f = flowFixture();
  return { ...f, ...correctionFixture(f, clerk, received) };
}

test('本机管理员改单价、日期、送货单号：同样是冲销原单出替代单，金额跟着变；业务账号改不了', () => {
  const f = fixture();
  try {
    const line = [{ index: 0, quantity: '1000', unitPrice: '2.5' }];
    assert.throws(() => f.correct(f.arrivalId, line), (e: unknown) => failed(e, 403) && /要本机管理员来做/.test(errorMessage(e)));
    assert.throws(
      () => f.correct(f.arrivalId, [{ index: 0, quantity: '1000' }], clerk, { date: '2026-10-06' }),
      (e: unknown) => failed(e, 403),
    );
    const before = f.moves().length;
    const result = f.correct(f.arrivalId, line, localAdmin(), { date: '2026-10-06', reference: '虚构送货单-改' });
    assert.equal(Number(result.beforeAmount), 2000);
    assert.equal(Number(result.afterAmount), 2500);
    const replacement = f.flow.get(result.replacementFlowId, 'arrival');
    assert.equal(replacement.date, '2026-10-06');
    assert.equal(replacement.reference, '虚构送货单-改');
    assert.equal(replacement.lines[0].unitPrice, '2.5');
    assert.equal(Number(f.current().receivedAmount), 2500);
    assert.equal(f.balance(), 1000000, '数量没变，净库存不变');
    assert.equal(f.moves().length, before + 2, '照样是一入一出两条流水');
    assert.equal(f.moves().at(-2)?.date, '2026-10-06', '替代单的入库按更正后的到货日期');
    // 原来的送货单号放出来了，新号被替代单占着
    assert.deepEqual(
      f.store.db.prepare('SELECT reference,document_id FROM flow_receipt_keys').all().map((r) => [r.reference, Number(r.document_id)]),
      [['虚构送货单-改', replacement.id]],
    );
  } finally {
    f.store.close();
  }
});

test('不挂采购单的到货也能更正；本机管理员加一行、删一行', () => {
  const f = fixture();
  try {
    const loose = f.arrive('虚构散货-01', '50');
    assert.equal(f.balance(), 1050000);
    const result = f.correct(loose.id, [{ index: 0, quantity: '40' }]);
    assert.equal(f.balance(), 1040000);
    assert.deepEqual(result.purchases, [], '不挂采购单，没有采购单受影响');
    assert.equal(f.current().lines[0].receivedQuantity, '1000');
    // 加一行新纸板（没选库存品，自动建）
    const admin = localAdmin();
    const added = f.correct(
      result.replacementFlowId,
      [{ index: 0, quantity: '40' }, { quantity: '7', item: { name: '虚构新纸板', unit: '张' } }],
      admin,
    );
    const doc = f.flow.get(added.replacementFlowId, 'arrival');
    assert.equal(doc.lines.length, 2);
    assert.ok(doc.lines[1].stockId, '新行入了库存品');
    assert.equal(f.ops.repo.balance(Number(doc.lines[1].stockId)), 7000);
    // 再把第一行删掉
    const removed = f.correct(doc.id, [{ index: 1, quantity: '7' }], admin);
    assert.equal(f.flow.get(removed.replacementFlowId, 'arrival').lines.length, 1);
    assert.equal(f.balance(), 1000000);
  } finally {
    f.store.close();
  }
});

test('本机管理员更正也不能把行改挂到订货单以外的采购明细：要挂别的订货单就撤销后重新登记；同一份订货单里的照常', () => {
  const f = fixture('600');
  try {
    const admin = localAdmin();
    // 另一张采购单，有自己的订货单
    const other = f.ops.savePurchase(
      { supplierId: f.supplier.id, status: '已订货', orderDate: '2026-10-01', lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '500', unitPrice: '2', priceBasis: 'quantity' }] },
      clerk,
    );
    const outside = [{ index: 0, quantity: '600', purchaseLineId: other.lines[0].id }];
    assert.throws(() => f.correct(f.arrivalId, outside, admin), /更正只能挂这张到货单的订货单里的采购明细/);
    // 不挂采购单的到货也不能借更正挂上采购明细
    const loose = f.arrive('虚构散货-02', '20');
    assert.throws(
      () => f.correct(loose.id, [{ index: 0, quantity: '20', purchaseLineId: f.purchase.lines[0].id }], admin),
      /更正只能挂这张到货单的订货单里的采购明细/,
    );
    assert.equal(f.balance(), 620000, '拦下的更正什么都没变');
    // 挂的还是原订货单里的明细：照常更正
    const ok = f.correct(f.arrivalId, [{ index: 0, quantity: '550' }], admin);
    assert.equal(f.flow.get(ok.replacementFlowId, 'arrival').orderBatchId, f.flow.get(f.arrivalId, 'arrival').orderBatchId);
  } finally {
    f.store.close();
  }
});

test('本机管理员更正时新挂上的采购明细照样查状态：同一订货单里已取消、待订货的采购单都不行', () => {
  const f = fixture('600');
  try {
    const admin = localAdmin();
    const batchId = Number(f.flow.get(f.arrivalId, 'arrival').orderBatchId);
    const other = f.ops.savePurchase(
      { supplierId: f.supplier.id, status: '已订货', orderDate: '2026-10-01', lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '500', unitPrice: '2', priceBasis: 'quantity' }] },
      clerk,
    );
    // 两张采购单并在同一份订货单里，再把后一张取消
    f.store.db.prepare('DELETE FROM order_batch_purchases WHERE purchase_id=?').run(other.id);
    f.store.db.prepare('INSERT INTO order_batch_purchases(batch_id,purchase_id) VALUES(?,?)').run(batchId, other.id);
    const current = f.ops.repo.purchases(true, other.id)[0];
    f.ops.savePurchase({ ...current, status: '已取消', version: current.version }, clerk, other.id);
    assert.throws(
      () => f.correct(f.arrivalId, [{ index: 0, quantity: '600', purchaseLineId: other.lines[0].id }], admin),
      /正常已订货的?采购单/,
    );
    // 待订货的（还没下给供应商）并进订货单也不能挂
    const draft = f.ops.savePurchase(
      { supplierId: f.supplier.id, status: '待订货', orderDate: '2026-10-01', lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '300', unitPrice: '2', priceBasis: 'quantity' }] },
      clerk,
    );
    f.store.db.prepare('INSERT INTO order_batch_purchases(batch_id,purchase_id) VALUES(?,?)').run(batchId, draft.id);
    assert.throws(
      () => f.correct(f.arrivalId, [{ index: 0, quantity: '600', purchaseLineId: draft.lines[0].id }], admin),
      /正常已订货的?采购单/,
    );
    assert.equal(f.balance(), 600000);
  } finally {
    f.store.close();
  }
});

test('本机管理员删一行、换挂同一订货单里的采购明细：撤销原单另出替代单，原流水不改写、不留修订，已到货按有效单据逐条明细重算；业务账号做不了', () => {
  const f = flowFixture();
  try {
    const admin = localAdmin();
    const p = orderedPurchase(f, clerk, ['10', '10']);
    const [l0, l1] = p.purchase.lines;
    const draft = saveDoc(f.flow, 'arrival', {
      date: '2026-10-10',
      supplierId: f.supplier.id,
      reference: '虚构两行到货',
      lines: [l0, l1].map((l) => ({ stockId: f.raw.id, purchaseLineId: l.id, item: { name: f.raw.name, unit: '张' }, quantity: '5', unitPrice: '2', priceBasis: 'quantity' })),
    }, clerk);
    const a = f.base.check(draft, {}, clerk);
    const moves = (id: number) =>
      f.store.db.prepare("SELECT * FROM stock_movements WHERE source_kind='flow_arrival' AND source_id=? ORDER BY rowid").all(String(id));
    const received = () => p.current().lines.map((l) => l.receivedQuantity);
    const original = moves(a.id);
    const correct = (id: number, lines: CorrectionLines, who: Actor) => {
      const input = { expectedVersion: f.flow.get(id).version, reason: '虚构更正', lines };
      const plan = planCorrection(f.store, id, input, who);
      return ofKind(correctDocument(f.store, id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, who), 'arrival');
    };
    assert.throws(() => correct(a.id, [{ index: 1, quantity: '5' }], clerk), (e: unknown) => failed(e, 403) && /要本机管理员来做/.test(errorMessage(e)));
    // 删掉第一行，只留第二行
    const first = correct(a.id, [{ index: 1, quantity: '5' }], admin);
    assert.deepEqual(moves(a.id), original, '原单的入库流水原样留着');
    const replacement = Number(first.replacementFlowId);
    assert.deepEqual(moves(replacement).map((m) => [Number(m.purchase_line_id), Number(m.delta_units)]), [[l1.id, 5000]]);
    assert.deepEqual(received(), ['0', '5']);
    // 换挂到第一条明细：数量没变，也是再出一张替代单
    const second = correct(replacement, [{ index: 0, quantity: '5', purchaseLineId: l0.id }], admin);
    assert.deepEqual(received(), ['5', '0']);
    assert.deepEqual(
      f.store.db.prepare('SELECT received_units FROM purchase_lines ORDER BY id').all().map((r) => Number(r.received_units)),
      [5000, 0],
      '已到货缓存按有效单据重算',
    );
    assert.equal(count(f.store.db, 'SELECT count(*) n FROM stock_movement_revisions'), 0);
    assert.equal(f.ops.repo.balance(f.raw.id), 5000);
    assert.equal(f.flow.get(Number(second.replacementFlowId)).correctionOf, replacement);
  } finally {
    f.store.close();
  }
});

test('本机管理员更正也守登记的规矩：换成另一张到货单已登记的送货单号、换了采购明细已关联的库存品、同一条采购明细出现两次，都拦下，什么都不变', () => {
  const f = fixture();
  try {
    const admin = localAdmin();
    const loose = f.arrive('虚构送货单-02', '20');
    const other = f.ops.saveItem({ name: '虚构纸板乙', kind: 'raw', unit: '张' }, clerk);
    const before = [f.moves().length, f.balance(), f.flow.list('arrival').length];
    const same = [{ index: 0, quantity: '1000' }];
    assert.throws(
      () => f.correct(f.arrivalId, same, admin, { reference: ' 虚构送货单-02' }),
      (e: unknown) => failed(e, 409) && /这家供应商的这个送货单号已经登记在另一张到货单上/.test(errorMessage(e)),
    );
    assert.throws(() => f.correct(f.arrivalId, [{ index: 0, quantity: '1000', stockId: other.id }], admin), /请使用采购明细已关联的原材料库存品。/);
    assert.throws(
      () =>
        f.correct(
          f.arrivalId,
          [...same, { quantity: '5', item: { name: f.raw.name, unit: '张' }, stockId: f.raw.id, purchaseLineId: f.purchase.lines[0].id }],
          admin,
        ),
      /同一采购明细不能重复出现/,
    );
    assert.deepEqual([f.moves().length, f.balance(), f.flow.list('arrival').length], before);
    assert.equal(f.flow.get(loose.id).status, 'confirmed');
  } finally {
    f.store.close();
  }
});
