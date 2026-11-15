import { orderNextSteps, purchaseNextSteps } from '../../shared/business/index';
import type { FlowKind, NextStep, NextSteps, RecordEntity } from '../../shared/business/index';
import type { RecordRowOf } from './record-rows';

type StepData = Parameters<typeof orderNextSteps>[1];
/** 只有订单、采购单有“下一步” */
const planners: { [E in RecordEntity]: (row: RecordRowOf[E], data: StepData) => NextSteps | null } = {
  orders: (row, data) => (row.status === '待确认' || data ? orderNextSteps(row, data) : null),
  purchases: (row) => purchaseNextSteps(row),
  customers: () => null,
  products: () => null,
  suppliers: () => null,
  stock_items: () => null,
};

/** 还没读到关联记录时不猜下一步；只有确认订单这种不依赖关联的才先给。 */
export function nextPlan<E extends RecordEntity>(entity: E, row: RecordRowOf[E], data: StepData, canEdit: boolean): NextSteps | null {
  if (!canEdit || row.archived) return null;
  return planners[entity](row, data);
}

/** “下一步”卡片里的一句话：为什么是这一步。按钮在详情头部。 */
export function stepSentence(step: NextStep): string {
  switch (step.kind) {
    case 'confirm':
      return '订单还待确认，确认后才能安排生产和送货。';
    case 'delivery':
      return (step.detail || '有库存可发') + '，可以安排送货。';
    case 'schedule':
      return step.title.replace(/^安排生产 · /, '') + (step.detail ? '：' + step.detail : '') + '，要安排生产。';
    case 'purchase':
      return (step.detail || '') + '，先安排订料。';
    case 'complete':
      return step.title.replace(/^登记完工 /, '生产任务 ') + (step.detail ? '：' + step.detail : '') + '，做完后登记完工。';
    case 'confirm_delivery':
      return step.title + '，导出送货单时出库。';
    case 'export':
      return '还没把订货单发给供应商；导出订货单后自动变成待到货。';
    case 'arrival':
      return '供应商送货到了，按送货单登记实到数量，确认后直接入库；没到齐的继续待到货。';
    default:
      return step.title;
  }
}

/** 按产品备货时带进安排生产窗口的产品（产品详情的“安排生产”） */
type TaskProduct = { id: number; name: string };

/** 从订单、采购单、档案详情或今日页打开的办理窗口。 */
export type RecordDialog =
  /** 单据窗口（登记完工、打开生产任务、打开送货单……），参数和链接参数一样 */
  | { type: 'flow'; mode: FlowKind; params: Record<string, string> }
  /** 安排订料：新建关联这张订单的采购单 */
  | { type: 'purchase'; orderId: number; productIds: number[] }
  /** 安排送货：按订单，或按成品库存 */
  | { type: 'delivery'; orderIds?: number[]; stockIds?: number[] }
  /** 安排生产：按订单，或按产品（备货） */
  | { type: 'task'; orderIds?: number[]; products?: TaskProduct[] }
  /** 导出订货单 */
  | { type: 'order-sheet'; purchaseIds: number[] }
  /** 登记到货 */
  | { type: 'receive'; purchaseId: number };

/** 订单“下一步”用哪个窗口打开：订单详情和今日页同一套，几个产品要排产、要送货时一个窗口一起排。 */
export function orderStepDialog(
  orderId: number,
  step: { kind: NextStep['kind']; params?: Record<string, string> },
): RecordDialog | null {
  if (step.kind === 'delivery') return { type: 'delivery', orderIds: [orderId] };
  if (step.kind === 'schedule') return { type: 'task', orderIds: [orderId] };
  if (step.kind === 'purchase')
    return {
      type: 'purchase',
      orderId: Number(step.params?.order || orderId),
      productIds: (step.params?.products || '')
        .split(',')
        .map(Number)
        .filter((id) => id > 0),
    };
  if (step.kind === 'complete') return { type: 'flow', mode: 'production', params: step.params || {} };
  if (step.kind === 'confirm_delivery') return { type: 'flow', mode: 'delivery', params: step.params || {} };
  return null;
}

