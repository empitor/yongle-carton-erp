// 更正送货单、更正完工单窗口交给服务端的输入（src/flow/delivery-correction.ts、production-correction.ts）：
// 按“更正后整张单”写，带 index 的是原单那一行，没改不去核验；核验、提交被拒（别人刚改过这张单）以后窗口怎么接着办
// （src/flow/correction-recover.ts、DocumentInfoDialog 的 mergeInfo）。只算数据，不发请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryCorrectionPreviewSchema, productionCorrectionPreviewSchema } from '../shared/business/index.js';
import { deliveryCorrectionInput, deliveryHead, deliveryRows, newDeliveryRow } from '../src/flow/delivery-correction.js';
import { keepRows, recoverCorrection } from '../src/flow/correction-recover.js';
import { mergeInfo } from '../src/flow/DocumentInfoDialog.js';
import { materialRows, newMaterialRow, productionCorrectionInput, productionHead } from '../src/flow/production-correction.js';

const delivery = {
  id: 5,
  version: 3,
  date: '2026-11-10',
  lines: [
    { orderId: 1, orderLineId: 11, stockId: 7, quantity: '300' },
    { orderId: 1, orderLineId: 12, stockId: 8, quantity: '300' },
  ],
};

test('更正送货单：改数量只写 index 和数量，删掉的行不列，管理员改日期、换挂、加行另写；没改不去核验', () => {
  const head = deliveryHead(delivery),
    rows = deliveryRows(delivery);
  assert.equal(deliveryCorrectionInput(delivery, head, rows, '虚构').changed, false, '没改不去核验');
  const less = deliveryCorrectionInput(delivery, head, [{ ...rows[0], quantity: '250' }, rows[1]], ' 点错数量 ');
  assert.equal(less.changed, true);
  assert.deepEqual(less.input, {
    expectedVersion: 3,
    reason: '点错数量',
    lines: [
      { index: 0, quantity: '250' },
      { index: 1, quantity: '300' },
    ],
  });
  deliveryCorrectionPreviewSchema.parse(less.input);
  // 第二行其实没发：删掉
  const removed = deliveryCorrectionInput(delivery, head, [rows[0]], 'x');
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.input.lines, [{ index: 0, quantity: '300' }]);
  // 本机管理员：改出库日期、第二行换挂、加一行
  const admin = deliveryCorrectionInput(
    delivery,
    { ...head, date: '2026-11-09' },
    [rows[0], { ...rows[1], orderLineId: 13 }, { ...newDeliveryRow(), quantity: '20', orderLineId: 14 }],
    'x',
  );
  assert.deepEqual(admin.input, {
    expectedVersion: 3,
    reason: 'x',
    date: '2026-11-09',
    lines: [
      { index: 0, quantity: '300' },
      { index: 1, quantity: '300', orderLineId: 13 },
      { quantity: '20', orderLineId: 14 },
    ],
  });
  deliveryCorrectionPreviewSchema.parse(admin.input);
  // 勾了超订单发货才带上，勾选本身不算改了内容
  const over = deliveryCorrectionInput(delivery, { ...head, allowOverdelivery: true, overdeliveryReason: ' 客户加订 ' }, rows, 'x');
  assert.equal(over.changed, false);
  assert.equal(over.input.allowOverdelivery, true);
  assert.equal(over.input.overdeliveryReason, '客户加订');
});

const production = {
  id: 9,
  version: 2,
  date: '2026-11-08',
  productId: 3,
  taskId: 4,
  goodQuantity: '1000',
  scrapQuantity: '0',
  materials: [
    { stockId: 21, issued: '100', returned: '0' },
    { stockId: 22, issued: '50', returned: '5' },
  ],
};

test('更正完工单：合格、报废改了才写，领料一处变了就写整张领料表，管理员改日期、产品、任务；没改不去核验', () => {
  const head = productionHead(production),
    rows = materialRows(production);
  assert.equal(productionCorrectionInput(production, head, rows, '虚构').changed, false, '没改不去核验');
  const good = productionCorrectionInput(production, { ...head, good: '900' }, rows, '多登了 100 只');
  assert.deepEqual(good.input, { expectedVersion: 2, reason: '多登了 100 只', goodQuantity: '900' });
  productionCorrectionPreviewSchema.parse(good.input);
  // 第一种纸板少领 10 张、第二种换成别的纸板、再加一种：写更正后的整张领料
  const materials = productionCorrectionInput(
    production,
    head,
    [{ ...rows[0], issued: '90' }, { ...rows[1], stockId: 23 }, { ...newMaterialRow(), stockId: 24, issued: '5' }],
    'x',
  );
  assert.deepEqual(materials.input.materials, [
    { index: 0, issued: '90', returned: '0' },
    { index: 1, stockId: 23, issued: '50', returned: '5' },
    { stockId: 24, issued: '5', returned: '0' },
  ]);
  productionCorrectionPreviewSchema.parse(materials.input);
  // 删掉一种纸板也是改了领料
  assert.deepEqual(productionCorrectionInput(production, head, [rows[0]], 'x').input.materials, [
    { index: 0, issued: '100', returned: '0' },
  ]);
  // 本机管理员：改完工日期、产品，改成不挂任务（null）
  const admin = productionCorrectionInput(production, { ...head, date: '2026-11-07', productId: 6, taskId: null }, rows, 'x');
  assert.deepEqual(admin.input, { expectedVersion: 2, reason: 'x', date: '2026-11-07', productId: 6, taskId: null });
  productionCorrectionPreviewSchema.parse(admin.input);
});

test('预览后单据被别人改了：提交被拒以后读回最新的、按新版本重新核验，窗口不卡住；人填的行和说明能留的留着', async () => {
  let reads = 0;
  const refresh = (version: number) => async () => (reads++, { version });
  const stale = Object.assign(new Error('送货单版本已改变，请刷新后重新核对。'), { status: 409, code: 'validation' });
  // 版本变了：读回一次，输入换成新版本自己会再核验（不用显式再核验），窗口里说一句
  const r1 = await recoverCorrection(stale, 3, refresh(4));
  assert.deepEqual(r1, { notice: '这张单或关联的订单、库存刚被改过，已按最新的重新预览，请核对后再提交。', repreview: false });
  assert.equal(reads, 1);
  // 版本没变、核验以后关联的订单或库存变了：显式再核验一次
  const changed = Object.assign(new Error('x'), { status: 409, code: 'preview-changed' });
  assert.equal((await recoverCorrection(changed, 3, refresh(3)))?.repreview, true);
  // 别的拒绝（库存不足、已被替代）版本也没变：照服务端原话显示
  assert.equal(await recoverCorrection(Object.assign(new Error('库存不足'), { status: 409 }), 3, refresh(3)), null);
  // 不是 409 的错误不去读单据
  reads = 0;
  assert.equal(await recoverCorrection(Object.assign(new Error('没有权限'), { status: 403 }), 3, refresh(4)), null);
  assert.equal(reads, 0);
  // 最新单据上还在的行留着人填的数；少了的行去掉；新加的行留着
  const rows = [{ index: 0, quantity: '250' }, { index: 1, quantity: '280' }, { quantity: '5' }];
  assert.equal(keepRows(rows, [{}, {}]), rows, '行都还在：原样');
  assert.deepEqual(keepRows(rows, [{}]), [{ index: 0, quantity: '250' }, { quantity: '5' }]);
  // 说明编辑窗：人改过的留着，没动的换成最新的
  const before = { notes: '原备注', address: '虚构老地址' },
    fresh = { notes: '别人改的备注', address: '虚构新地址' };
  assert.deepEqual(mergeInfo(['notes', 'address'], { notes: '原备注', address: '虚构我改的地址' }, before, fresh), {
    notes: '别人改的备注',
    address: '虚构我改的地址',
  });
});
