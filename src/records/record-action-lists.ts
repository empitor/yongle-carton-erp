import { orderStatusRules, productIncomplete, purchaseStatusRules } from '../../shared/business/index';
import type { NextStep, NextSteps, RecordStatusAction } from '../../shared/business/index';
import type { Order, Product } from '../../shared/core/index';
import type { RecordAction } from '../ui/index';
import { newOrderFrom, newPurchaseFrom } from '../recordkit/launch';
import { orderStepDialog, type RecordDialog } from './order-step';

/**
 * 详情头部各类记录的动作清单：steps 是按顺序的下一步（第一个是主按钮），extra 是低频动作，danger 是取消这类危险项。
 * 只排清单，不办事：办事的函数由 useRecordActions 传进来。
 */
export type ActionLists = { steps: RecordAction[]; extra: RecordAction[]; danger: RecordAction[]; leadEdit: boolean };
export type ActionContext<R> = {
  row: R;
  plan: NextSteps | null;
  working: boolean;
  localAdmin: boolean;
  /** 改状态并提示一句 */
  saveStatus: (action: RecordStatusAction, message: string) => void;
  /** 打开取消确认窗（写原因） */
  ask: (title: string, message: string, label: string, done: string) => void;
  setDialog: (dialog: RecordDialog | null) => void;
  onEdit: () => void;
  edit: RecordAction;
};

/** 订单下一步的按钮文字：几个都要登记完工、打开送货单时带上是哪一张 */
const orderStepLabel = (s: NextStep, n: number) =>
  ({
    confirm: '确认订单',
    delivery: '安排送货',
    schedule: '安排生产',
    purchase: '安排订料',
    complete: n > 1 ? '登记完工 ' + s.title.replace(/^登记完工 /, '') : '登记完工',
    confirm_delivery: '打开送货单' + (n > 1 ? ' ' + s.title.replace(/^送货 /, '').replace(/ 待送货$/, '') : ''),
  })[s.kind as string] ||
  s.label ||
  s.title;

/** 订单的动作只看这几项 */
type OrderRow = Pick<Order, 'id' | 'number' | 'status'>;

export function orderActions(c: ActionContext<OrderRow>): ActionLists {
  const { row, working } = c;
  const run = (s: NextStep) => {
    if (s.kind === 'confirm') c.saveStatus('confirm', '订单 ' + row.number + ' 已确认。');
    else c.setDialog(orderStepDialog(row.id, s));
  };
  const list = c.plan?.steps || [];
  const seen = new Set<string>();
  const steps: RecordAction[] = [];
  for (const s of list) {
    // 几个产品都要排产、要送货时，一个“安排生产”“安排送货”窗口一起排
    if (['schedule', 'delivery'].includes(s.kind)) {
      if (seen.has(s.kind)) continue;
      seen.add(s.kind);
    }
    const n = list.filter((x) => x.kind === s.kind).length;
    steps.push({ label: orderStepLabel(s, n), disabled: working, onClick: () => run(s) });
  }
  const extra: RecordAction[] = [];
  const allowed = (action: RecordStatusAction) => orderStatusRules[action].from.includes(row.status);
  if (allowed('revert'))
    extra.push({ label: '退回待确认', disabled: working, onClick: () => c.saveStatus('revert', '订单 ' + row.number + ' 已退回待确认。') });
  if (allowed('reinstate'))
    extra.push({ label: '恢复为待确认', disabled: working, onClick: () => c.saveStatus('reinstate', '订单 ' + row.number + ' 已恢复为待确认。') });
  const danger: RecordAction[] = [];
  if (allowed('cancel'))
    danger.push({
      label: '取消订单',
      danger: true,
      disabled: working,
      onClick: () =>
        c.ask(
          '取消订单 ' + row.number,
          '取消后这张订单不再安排生产和送货；以后可以在“更多”里恢复为待确认。',
          '取消订单',
          '订单 ' + row.number + ' 已取消。',
        ),
    });
  return { steps, extra, danger, leadEdit: true };
}

/** 采购单的动作只看这几项（采购单视图在服务端 server/operations/views.ts 的 PurchaseView） */
type PurchaseRow = { id: number; number: string; businessStatus: string; arrivalProgress: string; receipts?: readonly unknown[] };

export function purchaseActions(c: ActionContext<PurchaseRow>): ActionLists {
  const { row, working, localAdmin } = c;
  const status = row.businessStatus,
    received = !!row.receipts?.length;
  const steps: RecordAction[] = [],
    extra: RecordAction[] = [],
    danger: RecordAction[] = [];
  const orderSheet = () => c.setDialog({ type: 'order-sheet', purchaseIds: [row.id] });
  const allowed = (action: RecordStatusAction) => purchaseStatusRules[action].from.includes(status);
  // 待订货：下一步导出订货单，也能不导出直接确认
  if (allowed('confirm')) {
    steps.push({ label: '导出订货单', onClick: orderSheet });
    extra.push({
      label: '不导出，直接改成待到货',
      disabled: working,
      onClick: () => c.saveStatus('confirm', '采购单 ' + row.number + ' 已改成待到货，到货页能看到。'),
    });
  }
  if (status === '已订货' && row.arrivalProgress !== '全部到货')
    steps.push({ label: '登记到货', onClick: () => c.setDialog({ type: 'receive', purchaseId: row.id }) });
  if (status === '已订货') {
    extra.push({ label: '重新导出订货单', onClick: orderSheet });
    extra.push({ label: '到货记录', href: '#warehouse?arrivals=1&purchase=' + row.id });
  }
  if (allowed('revert') && !received)
    extra.push({ label: '退回待订货', disabled: working, onClick: () => c.saveStatus('revert', '采购单 ' + row.number + ' 已退回待订货。') });
  if (allowed('reinstate'))
    extra.push({
      label: '恢复为待订货',
      disabled: working || (received && !localAdmin),
      onClick: () => c.saveStatus('reinstate', '采购单 ' + row.number + ' 已恢复。'),
    });
  if (allowed('cancel') && !(row.arrivalProgress === '全部到货' && !localAdmin))
    danger.push({
      label: '取消采购单',
      danger: true,
      disabled: working,
      onClick: () =>
        c.ask(
          '取消采购单 ' + row.number,
          received
            ? '已经到的货和库存保留不动，没到的不再等；以后可以在“更多”里恢复。'
            : '取消后不再等这张采购单的货；以后可以在“更多”里恢复为待订货。',
          '取消采购单',
          '采购单 ' + row.number + ' 已取消。',
        ),
    });
  return { steps, extra, danger, leadEdit: true };
}

/** 产品：“安排生产”是主操作，“新建订单”同样高亮；资料不全的主按钮是“补全资料” */
export function productActions(c: ActionContext<Product>): ActionLists {
  const { row } = c;
  // 看到某个产品库存少了，没有订单也能先排生产备货；和“新建订单”并列高亮
  const produce = { label: '安排生产', onClick: () => c.setDialog({ type: 'task', products: [row] }) };
  const order = { label: '新建订单', emphasis: true, onClick: () => newOrderFrom({ productIds: [row.id] }) };
  return productIncomplete(row)
    ? { steps: [{ label: '补全资料', onClick: c.onEdit }, produce, { ...order, emphasis: false }], extra: [], danger: [], leadEdit: false }
    : { steps: [produce, order], extra: [], danger: [], leadEdit: true };
}

/** 库存品：原材料安排订料、成品安排送货；“编辑”只改档案、用得少，收进更多 */
export function stockActions(c: ActionContext<{ id: number; kind: string }>, live: boolean): ActionLists {
  const { row } = c;
  const steps: RecordAction[] = live
    ? [
        row.kind === 'raw'
          ? { label: '安排订料', onClick: () => newPurchaseFrom({ stockIds: [row.id] }) }
          : { label: '安排送货', onClick: () => c.setDialog({ type: 'delivery', stockIds: [row.id] }) },
      ]
    : [];
  return { steps, extra: [c.edit], danger: [], leadEdit: false };
}

export const customerActions = (c: ActionContext<{ id: number }>): ActionLists => ({
  steps: [{ label: '新建订单', onClick: () => newOrderFrom({ customerId: c.row.id }) }],
  extra: [],
  danger: [],
  leadEdit: true,
});
export const supplierActions = (c: ActionContext<{ id: number }>): ActionLists => ({
  steps: [{ label: '新建采购单', onClick: () => newPurchaseFrom({ supplierId: c.row.id }) }],
  extra: [],
  danger: [],
  leadEdit: true,
});
