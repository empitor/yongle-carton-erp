import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { RecordEntity } from '../../shared/business/index';
import { deliverableOrder } from '../../shared/core/index';
import type { RecordAction } from '../ui/index';
import { newOrderFrom, newPurchaseFrom } from '../recordkit/launch';
import { notify } from '../ui/index';
import type { RecordRowOf } from './record-rows';
const DeliveryPlanDialog = lazy(() => import('../warehouse/DeliveryPlanDialog'));
const TaskPlanDialog = lazy(() => import('../flow/TaskPlanDialog'));
const PurchaseLaunch = lazy(() => import('../operations/PurchaseLaunch'));
const OrderBatchDialog = lazy(() => import('../operations/OrderBatchDialog'));

type Dialog = null | 'task' | 'product-task' | 'delivery' | 'purchase' | 'stock-delivery' | 'order-sheet';
/** 办理窗口关了（close）或办成了（done，带一句结果） */
type Ends = { close: () => void; done: (message: string) => void };
/** 一种记录的批量操作：主操作、次要、“更多”，和按开着的窗口画出来的样子（窗口里的单子按现在勾选的行算） */
type Bulk = { primary?: RecordAction; secondary?: RecordAction; more: RecordAction[]; dialog?: (d: Dialog, e: Ends) => ReactNode };
type Planner<R> = (rows: R[], open: (d: Dialog) => void) => Bulk;
const notArchived = (r: { archived?: boolean }) => !r.archived;

/** 订单：主操作“安排送货”（按客户分单），次要“安排生产”（同一产品合成一张任务），“安排订料”进更多 */
const orderBulk: Planner<RecordRowOf['orders']> = (rows, open) => {
  const live = rows.filter(notArchived),
    ids = rows.map((r) => r.id);
  const workable = live.filter(deliverableOrder);
  return {
    primary: { label: '安排送货（' + rows.length + ' 张）', disabled: !workable.length, onClick: () => open('delivery') },
    secondary: { label: '安排生产', disabled: !workable.length, onClick: () => open('task') },
    more: [{ label: '安排订料', disabled: !live.length, onClick: () => open('purchase') }],
    dialog: (d, e) =>
      d === 'task' ? (
        <TaskPlanDialog orderIds={ids} {...e} />
      ) : d === 'delivery' ? (
        <DeliveryPlanDialog orderIds={ids} {...e} />
      ) : d === 'purchase' ? (
        <PurchaseLaunch orderIds={ids} {...e} />
      ) : null,
  };
};

/** 产品：安排生产（没有订单也能备货，每种一张任务）和新建订单（每种一行），两个并列高亮 */
const productBulk: Planner<RecordRowOf['products']> = (rows, open) => {
  const live = rows.filter(notArchived);
  return {
    primary: { label: '安排生产（' + rows.length + ' 种）', disabled: !live.length, onClick: () => open('product-task') },
    secondary: {
      label: '新建订单（' + rows.length + ' 种）',
      emphasis: true,
      disabled: !live.length,
      onClick: () => newOrderFrom({ productIds: live.map((r) => r.id) }),
    },
    more: [],
    dialog: (d, e) => (d === 'product-task' ? <TaskPlanDialog products={live} {...e} /> : null),
  };
};

/** 原材料：安排订料（每种一行）；成品：安排送货（按客户分单） */
const stockBulk: Planner<RecordRowOf['stock_items']> = (rows, open) => {
  const live = rows.filter(notArchived),
    raw = live.filter((r) => r.kind === 'raw'),
    finished = live.filter((r) => r.kind === 'finished');
  const order = raw.length
    ? { label: '安排订料（' + raw.length + ' 种）', onClick: () => newPurchaseFrom({ stockIds: raw.map((r) => r.id) }) }
    : undefined;
  const deliver = finished.length
    ? { label: '安排送货（' + finished.length + ' 种）', onClick: () => open('stock-delivery') }
    : undefined;
  const stockIds = rows.filter((r) => r.kind === 'finished').map((r) => r.id);
  return {
    primary: order || deliver,
    secondary: order ? deliver : undefined,
    more: [],
    dialog: (d, e) => (d === 'stock-delivery' ? <DeliveryPlanDialog stockIds={stockIds} {...e} /> : null),
  };
};

/** 采购单：导出订货单（同一家供应商合成一份） */
const purchaseBulk: Planner<RecordRowOf['purchases']> = (rows, open) => {
  const exportable = rows.filter((r) => notArchived(r) && r.businessStatus !== '已取消');
  return {
    primary: {
      label: '导出订货单（' + rows.length + ' 张）',
      disabled: !exportable.length,
      onClick: () => {
        if (new Set(exportable.map((r) => r.supplierId)).size > 1)
          notify('只能把同一家供应商的采购单合在一份订货单里，请按供应商分开选。');
        else open('order-sheet');
      },
    },
    more: [],
    dialog: (d, e) => (d === 'order-sheet' ? <OrderBatchDialog purchaseIds={exportable.map((r) => r.id)} {...e} /> : null),
  };
};

const nothing: Planner<unknown> = () => ({ more: [] });
const planners: { [E in RecordEntity]: Planner<RecordRowOf[E]> } = {
  orders: orderBulk,
  products: productBulk,
  stock_items: stockBulk,
  purchases: purchaseBulk,
  customers: nothing,
  suppliers: nothing,
};

/**
 * 列表多选后的批量开单，放进底部选择条：订单、产品、库存品、采购单各有各的（见上面几种）。
 * 只做“拿选中的东西开单”，确认、扣库存都在各自的单据里。已归档的、没有业务编辑权限的不给操作。
 */
export function useBulkActions<E extends RecordEntity>({
  entity,
  rows,
  canEdit,
  archived,
  clear,
}: {
  entity: E;
  rows: RecordRowOf[E][];
  canEdit: boolean;
  archived: boolean;
  clear: () => void;
}): { primary?: RecordAction; secondary?: RecordAction; more: RecordAction[]; dialogs: ReactNode } {
  const [dialog, setDialog] = useState<Dialog>(null);
  const done = (message: string) => {
    setDialog(null);
    clear();
    notify(message);
  };
  const close = () => setDialog(null);
  const bulk = planners[entity](rows, setDialog);
  const shown = !archived && canEdit ? bulk : { more: [] };
  return {
    primary: shown.primary,
    secondary: shown.secondary,
    more: shown.more,
    dialogs: <Suspense fallback={null}>{dialog && bulk.dialog?.(dialog, { close, done })}</Suspense>,
  };
}
