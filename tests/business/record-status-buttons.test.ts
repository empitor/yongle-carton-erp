// 订单、采购单详情上的状态按钮（src/records/record-action-lists.ts）：什么状态出现哪些按钮。
// 条件取自 shared/business/operations/record-status.ts 的规则，这里按状态逐个钉住结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderActions, purchaseActions, type ActionContext, type ActionLists } from '../../src/records/record-action-lists.js';
import type { Order } from '../../shared/core/order-view.js';
import { statuses } from '../../shared/core/domain.js';
import { purchaseBusinessStatuses } from '../../shared/business/index.js';

/** 一份不办事的上下文：只看排出来的按钮 */
function context<R>(row: R, localAdmin = false): ActionContext<R> {
  const idle = () => undefined;
  return {
    row,
    plan: null,
    working: false,
    localAdmin,
    saveStatus: idle,
    ask: idle,
    setDialog: idle,
    onEdit: idle,
    edit: { label: '编辑', onClick: idle },
  };
}
/** 按钮文字，没出现的按钮不在里面；能点不能点用“（不能点）”标出来 */
const labels = (lists: ActionLists) =>
  [...lists.steps, ...lists.extra, ...lists.danger].map((a) => a.label + (a.disabled ? '（不能点）' : ''));

const orderRow = (status: Order['status']) => ({ id: 1, number: 'SO-1', status });

test('订单详情：已确认才有退回待确认，已取消才有恢复，没取消、没发完货的才有取消订单', () => {
  const expected: Record<Order['status'], string[]> = {
    待确认: ['取消订单'],
    已确认: ['退回待确认', '取消订单'],
    生产中: ['取消订单'],
    待发货: ['取消订单'],
    已发货: [],
    已取消: ['恢复为待确认'],
  };
  for (const status of statuses) assert.deepEqual(labels(orderActions(context(orderRow(status)))), expected[status], status);
});

type PurchaseCase = { status: string; arrival: string; received: boolean; localAdmin: boolean };
const purchaseLabels = (c: PurchaseCase) =>
  labels(
    purchaseActions(
      context(
        { id: 2, number: 'PO-1', businessStatus: c.status, arrivalProgress: c.arrival, receipts: c.received ? [{}] : [] },
        c.localAdmin,
      ),
    ),
  );

test('采购单详情：待订货能导出或直接改待到货，已订货没到过货才能退回，已取消才能恢复', () => {
  const none = { arrival: '未到货', received: false, localAdmin: false };
  assert.deepEqual(purchaseLabels({ status: '待订货', ...none }), ['导出订货单', '不导出，直接改成待到货', '取消采购单']);
  assert.deepEqual(purchaseLabels({ status: '已订货', ...none }), ['登记到货', '重新导出订货单', '到货记录', '退回待订货', '取消采购单']);
  assert.deepEqual(purchaseLabels({ status: '已取消', ...none }), ['恢复为待订货']);
  for (const status of purchaseBusinessStatuses) assert.ok(purchaseLabels({ status, ...none }).length > 0, status);
});

test('采购单详情：到过货的不能退回；全部到货只有本机管理员能取消；到过货的取消单只有本机管理员能恢复', () => {
  const partial = { arrival: '部分到货', received: true };
  assert.deepEqual(purchaseLabels({ status: '已订货', ...partial, localAdmin: false }), ['登记到货', '重新导出订货单', '到货记录', '取消采购单']);
  const full = { arrival: '全部到货', received: true };
  assert.deepEqual(purchaseLabels({ status: '已订货', ...full, localAdmin: false }), ['重新导出订货单', '到货记录']);
  assert.deepEqual(purchaseLabels({ status: '已订货', ...full, localAdmin: true }), ['重新导出订货单', '到货记录', '取消采购单']);
  assert.deepEqual(purchaseLabels({ status: '已取消', ...partial, localAdmin: false }), ['恢复为待订货（不能点）']);
  assert.deepEqual(purchaseLabels({ status: '已取消', ...partial, localAdmin: true }), ['恢复为待订货']);
});
