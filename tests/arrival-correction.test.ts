// 更正已入库的到货单（server/flow/arrival-correction.ts）：业务账号改每行的数量和验收数，撤销原单、另出替代单，流水只追加。
// 本机管理员改单头、单价、增删行、换挂明细的在 arrival-correction-admin.test.ts。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk, localAdmin } from './flow-fixture.js';
import { correctionFixture, ofKind, orderedPurchase } from './receive-fixture.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { PurchaseReturns } from '../server/flow/returns.js';
import { AppError } from '../server/core/errors.js';
import { errorMessage } from '../shared/core/error-message.js';
import { count, one, rows } from '../server/core/index.js';

/** 出错是不是给人看的业务错误、状态码对得上 */
const failed = (e: unknown, status: number) => e instanceof AppError && e.status === status;

function fixture(received = '1000') {
  const f = flowFixture();
  return { ...f, ...correctionFixture(f, clerk, received) };
}

test('数量改少：撤销原单、另出替代单，库存按净变化少 100，采购已到货跟着变，原流水一条不改', () => {
  const f = fixture();
  try {
    const before = f.moves();
    const plan = ofKind(planCorrection(f.store, f.arrivalId, f.input(f.arrivalId, [{ index: 0, quantity: '900' }]), clerk), 'arrival');
    assert.equal(plan.stockImpact[0].delta, '-100');
    assert.equal(plan.purchaseImpact[0].lines[0].after, '900');
    assert.equal(Number(plan.beforeAmount), 2000);
    assert.equal(Number(plan.afterAmount), 1800);
    assert.equal(f.balance(), 1000000, '预览不写库');
    const result = f.correct(f.arrivalId, [{ index: 0, quantity: '900' }]);
    assert.equal(result.verified, true);
    const old = f.flow.get(f.arrivalId, 'arrival'),
      replacement = f.flow.get(result.replacementFlowId, 'arrival');
    assert.equal(old.status, 'reversed');
    assert.equal(old.replacedBy, replacement.id);
    assert.equal(replacement.status, 'confirmed');
    assert.equal(replacement.correctionOf, f.arrivalId);
    assert.equal(replacement.orderBatchId, old.orderBatchId, '替代单还挂在同一份订货单上');
    assert.deepEqual(
      replacement.lines.map((l) => [l.quantity, l.acceptedQuantity, l.rejectedQuantity, l.stockedQuantity]),
      [['900', '900', '0', '900']],
      '原来全部合格入库的行，合格数和入库数跟着数量改',
    );
    assert.equal(f.balance(), 900000);
    assert.equal(f.current().lines[0].receivedQuantity, '900');
    assert.equal(f.batch().rows[0].remainingUnits, 100000, '订货单还差的跟着变');
    // 流水只追加：原来的一条不动，多出替代单的入库和原单的扣回
    const after = f.moves();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(
      after.slice(before.length).map((m) => [m.source_kind, m.source_id, Number(m.delta_units)]),
      [
        ['flow_arrival', String(replacement.id), 900000],
        ['flow_reversal', String(f.arrivalId), -1000000],
      ],
    );
    assert.equal(count(f.store.db, 'SELECT count(*) n FROM stock_movement_revisions'), 0);
    // 采购单、原到货单、替代单的修改历史各记一条（替代单的历史从这次更正开始，不是空的）
    assert.deepEqual(
      f.store.db.prepare("SELECT entity,record_id FROM business_audit WHERE action='correct' ORDER BY id").all().map((r) => [r.entity, Number(r.record_id)]),
      [
        ['purchases', f.purchase.id],
        ['flow_arrival', f.arrivalId],
        ['flow_arrival', replacement.id],
      ],
    );
  } finally {
    f.store.close();
  }
});

test('数量改多：不超订购数量可以，超了拦下；用掉一部分以后按净变化查库存', () => {
  const f = fixture('800');
  try {
    f.correct(f.arrivalId, [{ index: 0, quantity: '950' }]);
    assert.equal(f.balance(), 950000);
    assert.equal(f.current().lines[0].receivedQuantity, '950');
    const second = f.effective();
    assert.throws(() => f.correct(second.id, [{ index: 0, quantity: '1001' }]), /更正后累计到货超过采购订购数量。/);
    // 后面的业务用掉 900 张，库里只剩 50 张
    f.use('900');
    assert.equal(f.balance(), 50000);
    // 改成 920（净少 30）：整批扣回是不够的，但净变化够，放行
    f.correct(second.id, [{ index: 0, quantity: '920' }]);
    assert.equal(f.balance(), 20000);
    // 改成 800（净少 120）：不够扣，拦下，库存和单据都不变
    const third = f.effective();
    assert.throws(
      () => f.correct(third.id, [{ index: 0, quantity: '800' }]),
      (e: unknown) => failed(e, 409) && /库存不足：现有20张，本次需扣减120张/.test(errorMessage(e)),
    );
    assert.equal(f.balance(), 20000);
    assert.equal(f.flow.get(third.id).status, 'confirmed');
  } finally {
    f.store.close();
  }
});

test('只改数量的更正不看订货单归属：没挂订货单的老到货、采购单已移出订货单的到货都能改；更正换订货单的版本号', () => {
  for (const make of ['没挂订货单', '移出订货单'] as const) {
    const f = fixture('600');
    try {
      const batchId = Number(f.flow.get(f.arrivalId, 'arrival').orderBatchId);
      const version = () =>
        one(f.store.db, rows.order_batches.pick({ version: true }), 'SELECT version FROM order_batches WHERE id=?', batchId)?.version ??
        assert.fail('订货单 ' + batchId + ' 读不到');
      if (make === '没挂订货单')
        f.store.db
          .prepare("UPDATE flow_documents SET order_batch_id=NULL,document=json_remove(document,'$.orderBatchId') WHERE id=?")
          .run(f.arrivalId);
      else f.store.db.prepare('DELETE FROM order_batch_purchases WHERE purchase_id=?').run(f.purchase.id);
      const before = version();
      const result = f.correct(f.arrivalId, [{ index: 0, quantity: '550' }]);
      assert.equal(f.current().lines[0].receivedQuantity, '550', make);
      assert.equal(f.balance(), 550000, make);
      assert.equal(f.flow.get(result.replacementFlowId, 'arrival').lines[0].purchaseLineId, f.purchase.lines[0].id, make);
      // 原单挂着订货单的，更正后订货单换版本号（还差多少变了）
      assert.equal(version(), make === '移出订货单' ? before + 1 : before, make);
    } finally {
      f.store.close();
    }
  }
});

test('拦下：有没撤销的退货、版本变了、每行都改成 0、内容没变、已失效的到货单', () => {
  const f = fixture();
  try {
    const lines = [{ index: 0, quantity: '900' }];
    // 版本变了
    assert.throws(
      () => planCorrection(f.store, f.arrivalId, { ...f.input(f.arrivalId, lines), expectedVersion: 99 }, clerk),
      (e: unknown) => failed(e, 409) && /到货单版本已改变/.test(errorMessage(e)),
    );
    // 预览以后库存变了：摘要对不上
    const v = f.input(f.arrivalId, lines),
      plan = planCorrection(f.store, f.arrivalId, v, clerk);
    f.use('10');
    assert.throws(
      () => correctDocument(f.store, f.arrivalId, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, clerk),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'preview-changed' && /已变化/.test(e.message),
    );
    assert.throws(() => f.correct(f.arrivalId, [{ index: 0, quantity: '0' }]), /更正后每一行都是 0.*撤销这次到货/);
    assert.throws(() => f.correct(f.arrivalId, [{ index: 0, quantity: '1000' }]), /更正数量与原登记相同，无需提交。/);
    // 有没撤销的采购退货
    const returns = new PurchaseReturns(f.store);
    const ret = returns.create(clerk, {
      arrivalId: f.arrivalId,
      date: '2026-10-07',
      reason: '虚构退货',
      requestId: randomUUID(),
      lines: [{ lineIndex: 0, quantity: '5' }],
    });
    assert.throws(() => f.correct(f.arrivalId, lines), /这张到货已有采购退货，请先撤销退货，再处理到货单。/);
    returns.reverse(localAdmin(), ret.id, { version: ret.version, reason: '虚构撤销退货' });
    // 更正以后，原单已失效，不能再更正它
    f.correct(f.arrivalId, lines);
    assert.throws(() => f.correct(f.arrivalId, lines), (e: unknown) => failed(e, 409) && /只能更正有效的已入库到货/.test(errorMessage(e)));
    assert.equal(f.flow.get(f.arrivalId).status, 'reversed');
  } finally {
    f.store.close();
  }
});

test('重复提交：同一个请求号原样返回，不会再出一张替代单；换了内容拒绝', () => {
  const f = fixture();
  try {
    const v = f.input(f.arrivalId, [{ index: 0, quantity: '900' }]),
      plan = planCorrection(f.store, f.arrivalId, v, clerk),
      request = { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() };
    const first = ofKind(correctDocument(f.store, f.arrivalId, request, clerk), 'arrival');
    const arrivals = () => count(f.store.db, "SELECT count(*) n FROM flow_documents WHERE kind='arrival'");
    const documents = arrivals(),
      moves = f.moves().length;
    const again = ofKind(correctDocument(f.store, f.arrivalId, request, clerk), 'arrival');
    assert.equal(again.replacementFlowId, first.replacementFlowId);
    assert.equal(arrivals(), documents);
    assert.equal(f.moves().length, moves);
    assert.equal(f.balance(), 900000);
    assert.throws(() => correctDocument(f.store, f.arrivalId, { ...request, reason: '虚构另一个原因' }, clerk), (e: unknown) => failed(e, 409));
  } finally {
    f.store.close();
  }
});

test('更正结果里的采购单、库存品是更正后读回的完整视图，一个字段不少', () => {
  const f = fixture();
  try {
    const result = f.correct(f.arrivalId, [{ index: 0, quantity: '900' }]);
    assert.equal(result.purchases.length, 1);
    assert.equal(result.stock.length, 1);
    assert.deepEqual(result.purchases, f.flow.views.purchases(true, result.purchases.map((p) => p.id)));
    assert.deepEqual(result.stock, f.flow.views.items(true, result.stock.map((s) => s.id)));
  } finally {
    f.store.close();
  }
});

test('更正写库失败（扣回原单那一步）整批回滚，库存、单据、采购单都不变；没有业务权限连方案都出不了', () => {
  const f = fixture('12');
  try {
    const snapshot = () =>
      Object.fromEntries(
        ['stock_movements', 'flow_documents', 'flow_receipt_keys', 'purchase_lines', 'operation_requests', 'business_audit'].map((t) => [
          t,
          f.store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all(),
        ]),
      );
    const lines = [{ index: 0, quantity: '9' }];
    assert.throws(() => planCorrection(f.store, f.arrivalId, f.input(f.arrivalId, lines), { ...clerk, permissions: [] }), /权限/);
    const before = snapshot();
    f.store.db.exec(`CREATE TRIGGER fail_receipt_reversal BEFORE INSERT ON stock_movements
      WHEN NEW.source_kind='flow_reversal' BEGIN SELECT RAISE(ABORT, 'fictional receipt reversal failed'); END;`);
    assert.throws(() => f.correct(f.arrivalId, lines), /fictional receipt reversal failed/);
    assert.deepEqual(snapshot(), before);
    f.store.db.exec('DROP TRIGGER fail_receipt_reversal');
    const corrected = f.correct(f.arrivalId, lines);
    assert.deepEqual([corrected.movements.replacement.length, corrected.movements.reversal.length], [1, 1]);
    assert.equal(f.balance(), 9000);
  } finally {
    f.store.close();
  }
});

test('原来有不合格或没全入库的行：改数量要把合格、不合格、实际入库写清；几种纸板各按净变化入库，零入库的行不出流水', () => {
  const f = flowFixture();
  try {
    const glue = f.ops.saveItem({ name: '虚构衬板', kind: 'raw', unit: '张' }, clerk);
    const p = orderedPurchase(f, clerk, [[f.raw, '10000'], [glue, '10000']]);
    const arrival = p.receive(
      [
        { quantity: '5000', rejectedQuantity: '500', stockedQuantity: '4000' },
        { quantity: '1000', rejectedQuantity: '1000', stockedQuantity: '0' },
      ],
      '虚构混合验收',
    ).arrival;
    const record = () => f.flow.arrivalRecords().find((r) => r.effective) ?? assert.fail('没有有效的到货记录');
    const balances = () => [f.ops.balance(f.raw.id), f.ops.balance(glue.id)];
    assert.deepEqual([record().inspectionStatus, record().inventoryStatus], ['含不合格品', '部分入库']);
    assert.deepEqual(balances(), [4000000, 0]);
    assert.equal(count(f.store.db, 'SELECT count(*) n FROM stock_movements'), 1, '零入库的行不出流水');
    const correct = (id: number, row: Record<string, string>) => {
      const v = { expectedVersion: f.flow.get(id).version, reason: '虚构验收更正', lines: [{ index: 0, ...row }, { index: 1, quantity: '1000' }] };
      const plan = planCorrection(f.store, id, v, clerk);
      return correctDocument(f.store, id, { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() }, clerk);
    };
    assert.throws(() => correct(arrival.id, { quantity: '4000' }), /同时明确/);
    const result = correct(arrival.id, { quantity: '4000', acceptedQuantity: '3500', rejectedQuantity: '500', stockedQuantity: '3000' });
    assert.equal(result.stockImpact.find((s) => s.stockId === f.raw.id)?.delta, '-1000');
    assert.deepEqual(balances(), [3000000, 0]);
    assert.deepEqual(p.current().lines.map((l) => l.receivedQuantity), ['4000', '1000']);
    assert.deepEqual([record().lines[0].acceptedQuantity, record().lines[1].rejectedQuantity], ['3500', '1000']);
    correct(record().flowId, { quantity: '4000', acceptedQuantity: '3600', rejectedQuantity: '400', stockedQuantity: '3200' });
    assert.deepEqual(balances(), [3200000, 0]);
    assert.equal(f.flow.arrivalRecords().filter((r) => r.effective).length, 1);
  } finally {
    f.store.close();
  }
});

test('改数量、金额只有更正一条路：已入库的到货单普通保存被拒（本机管理员也一样），提示改数量用更正、只改备注用编辑', () => {
  const f = fixture();
  try {
    const doc = f.flow.get(f.arrivalId);
    assert.throws(
      () => f.flow.save('arrival', { ...doc, notes: '虚构备注', version: doc.version }, localAdmin(), f.arrivalId),
      (e: unknown) => failed(e, 409) && /只能修改还没核对的单据；已生效的到货、送货、完工单改数量用“更正到货单”.*只改备注这类用“编辑”/.test(errorMessage(e)),
    );
    assert.equal(f.flow.get(f.arrivalId).version, doc.version);
  } finally {
    f.store.close();
  }
});

test('一条完整的算例：登记 1000 → 更正成 900 → 用掉 880 以后再更正 → 本机管理员改单价', () => {
  const f = fixture();
  try {
    const state = () => ({
      库存: f.balance() / 1000,
      已到货: f.current().lines[0].receivedQuantity,
      到货金额: Number(f.current().receivedAmount),
      流水: f.moves().map((m) => Number(m.delta_units) / 1000),
    });
    assert.deepEqual(state(), { 库存: 1000, 已到货: '1000', 到货金额: 2000, 流水: [1000] });
    f.correct(f.arrivalId, [{ index: 0, quantity: '900' }]);
    assert.deepEqual(state(), { 库存: 900, 已到货: '900', 到货金额: 1800, 流水: [1000, 900, -1000] });
    f.use('880');
    const second = f.effective();
    // 净少 50，库里只有 20：拦下，什么都没变
    assert.throws(() => f.correct(second.id, [{ index: 0, quantity: '850' }]), /库存不足：现有20张，本次需扣减50张/);
    assert.deepEqual(state(), { 库存: 20, 已到货: '900', 到货金额: 1800, 流水: [1000, 900, -1000, -880] });
    // 净少 10：够扣，放行
    f.correct(second.id, [{ index: 0, quantity: '890' }]);
    assert.deepEqual(state(), { 库存: 10, 已到货: '890', 到货金额: 1780, 流水: [1000, 900, -1000, -880, 890, -900] });
    // 本机管理员把单价从 2 改成 2.5：数量不变，库存不变，金额跟着变，照样一入一出
    f.correct(f.effective().id, [{ index: 0, quantity: '890', unitPrice: '2.5' }], localAdmin());
    assert.deepEqual(state(), { 库存: 10, 已到货: '890', 到货金额: 2225, 流水: [1000, 900, -1000, -880, 890, -900, 890, -890] });
    // 四张到货单：前三张已撤销并各指向下一张，最后一张有效
    const chain = f.store.db.prepare("SELECT status,replaced_by IS NOT NULL AS replaced FROM flow_documents WHERE kind='arrival' ORDER BY id").all();
    assert.deepEqual(chain.map((d) => [d.status, Number(d.replaced)]), [['reversed', 1], ['reversed', 1], ['reversed', 1], ['confirmed', 0]]);
    assert.equal(count(f.store.db, 'SELECT count(*) n FROM stock_movement_revisions'), 0);
  } finally {
    f.store.close();
  }
});
