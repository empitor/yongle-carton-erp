import { quantityString, safeUnits } from '../../core/index.js';
import type { TrackedOrder } from '../../core/index.js';
import { activeDoc } from '../flow/physical-flow.js';
import { pendingByOrderLine, specificationMismatch, specificationMismatchText, type OrderFacts, type OrderLineFacts } from '../flow/warehouse-delivery.js';

/** 详情面板的“下一步”：只根据已有单据和库存判断，没有依据的事情不提示。 */
export type NextStep = {
  key: string;
  kind:
    | 'confirm'
    | 'purchase'
    | 'schedule'
    | 'complete'
    | 'delivery'
    | 'confirm_delivery'
    | 'arrival'
    | 'export';
  title: string;
  detail?: string;
  label?: string;
  /** 打开单据或表单时用的参数 */
  params?: Record<string, string>;
};
type OrderLineProgress = {
  id: number;
  name: string;
  unit?: string;
  remaining: string;
  available: string;
  /** 'none' 未排产；否则是“已完工/计划” */
  production: string;
};
export type NextSteps = {
  done?: string;
  steps: NextStep[];
  notes: string[];
  lines: OrderLineProgress[];
  /** 规格和产品现在的对不上、送不了货的明细提示（同一句也在 notes 里）；今日页按它单独列出 */
  mismatches?: string[];
};

/** 判断下一步要看的订单字段（订单明细的字段见 warehouse-delivery.ts 的 OrderLineFacts） */
type StepOrder = Pick<OrderFacts, 'id' | 'status' | 'archived'> & Pick<TrackedOrder, 'materialProgress'> & { lines?: readonly OrderLineFacts[] };
/** 关联的生产任务（生产任务视图）：完工、计划数量是数量文本 */
type StepTask = {
  id: number;
  number: string;
  status?: string;
  archived?: unknown;
  productId?: number | null;
  completed?: string | number | null;
  quantity: string | number;
  unit?: string | null;
};
/** 这些产品的成品库存品：可用量是千分整数（已扣掉待送货单占的） */
type StepStock = Parameters<typeof specificationMismatch>[0] & { productId?: number | null; availableUnits?: unknown };
type StepDelivery = NonNullable<Parameters<typeof pendingByOrderLine>[0][number]> & { id: number; number: string };
type StepPurchase = { number: string; archived?: unknown; businessStatus?: string | null; arrivalProgress?: string | null };
/** 订单的关联业务（server/overview/related-business.ts）；还没读到时为空 */
type StepRelated = {
  tasks?: readonly StepTask[];
  stocks?: readonly StepStock[];
  deliveries?: readonly StepDelivery[];
  purchases?: readonly StepPurchase[];
} | null | undefined;
/** 一条明细（或同一产品合起来的几条）和还要发的数量（千分整数） */
type Remaining = { line: OrderLineFacts; remaining: number };
/** 各产品排下来的结果：有库存可发的、只够发一部分的、要订纸板的、要安排生产的、规格对不上的提示 */
type GroupPlan = {
  ready: string[];
  partial: string[];
  boards: { productId: number; name: string }[];
  schedule: NextStep[];
  mismatches: string[];
};
type PlanContext = {
  order: StepOrder;
  tasks: readonly StepTask[];
  stocks: readonly StepStock[];
  /** 订单还没做完（已确认、生产中） */
  notYetMade: boolean;
  /** 订单没有有效的采购单 */
  noPurchase: boolean;
};

const emptySteps = (): NextSteps => ({ steps: [], notes: [], lines: [], mismatches: [] });

// 关联了产品的只会是成品，订单明细和成品的单位都只有“只”（数据库约束），按产品对上；
// 规格和产品现在的对不上的（specificationMismatch，送货窗口和服务端出库同一个判断）送不了，不算“有库存可发”。
const availableFor = (stocks: readonly StepStock[], line: OrderLineFacts) =>
  stocks
    .filter((s) => s.productId === line.productId && !specificationMismatch(s, line))
    .reduce((n, s) => n + Math.max(0, Number(s.availableUnits) || 0), 0);
// 被规格拦下的明细：再排产做出来的还是产品现在的规格，也送不了，要先核对订单明细
const mismatchOf = (stocks: readonly StepStock[], line: OrderLineFacts) =>
  stocks.find((s) => s.productId === line.productId && specificationMismatch(s, line));
// 生产任务、订单明细的单位都只有“只”（数据库约束），按产品对上就行
const ownTasks = (tasks: readonly StepTask[], line: OrderLineFacts) => tasks.filter((t) => t.productId === line.productId);
const unfinished = (t: StepTask) => safeUnits(t.completed) < safeUnits(t.quantity);

/** 已取消、待确认、已全部发货的订单直接给结果；别的返回 null 接着排 */
function settledOrder(order: StepOrder, lines: readonly Remaining[]): NextSteps | null {
  const result = emptySteps();
  if (order.archived) return result;
  if (order.status === '已取消') return { ...result, done: '订单已取消' };
  if (order.status === '待确认') {
    result.steps.push({ key: 'confirm', kind: 'confirm', title: '确认订单', detail: '确认后才能安排生产和送货。', label: '确认订单' });
    return result;
  }
  if (order.status === '已发货' || (lines.length && lines.every((x) => x.remaining <= 0))) return { ...result, done: '已全部发货' };
  return null;
}

/** 每条明细的进度：还要发、库存可用、这个产品的生产任务完工/计划 */
function lineProgress({ line, remaining }: Remaining, tasks: readonly StepTask[], stocks: readonly StepStock[]): OrderLineProgress {
  const own = ownTasks(tasks, line);
  const total = (pick: (t: StepTask) => unknown) => quantityString(own.reduce((n, t) => n + safeUnits(pick(t)), 0));
  return {
    id: line.id,
    name: line.productName,
    unit: line.unit,
    remaining: quantityString(Math.max(0, remaining)),
    available: quantityString(availableFor(stocks, line)),
    production: own.length ? total((t) => t.completed) + ' / ' + total((t) => t.quantity) : 'none',
  };
}

/**
 * 同一产品分几行的，库存和任务合起来算，不能每行都把同一批货算一遍；规格对不上的行单独算。
 * 已经安排在待送货单上的数量不再算缺口：可用库存已经扣掉了待送货单占的，这里不能再要一遍。
 */
function productGroups(lines: readonly Remaining[], stocks: readonly StepStock[], pending: ReadonlyMap<number, number>) {
  const groups = new Map<string, Remaining>();
  for (const { line, remaining } of lines) {
    const key = String(line.productId) + '|' + (mismatchOf(stocks, line) ? 'mismatch-' + String(line.id) : 'ok'),
      group = groups.get(key),
      open = Math.max(0, remaining - (pending.get(Number(line.id)) || 0));
    if (group) group.remaining += open;
    else groups.set(key, { line, remaining: open });
  }
  return [...groups.values()];
}

/** 还缺多少就预填多少，用户可以改 */
const scheduleStep = (order: StepOrder, line: OrderLineFacts, remaining: number, available: number): NextStep => ({
  key: 'schedule-' + String(line.id),
  kind: 'schedule',
  title: '安排生产 · ' + line.productName,
  detail: '待发 ' + quantityString(remaining) + ' ' + String(line.unit) + '，库存可用 ' + quantityString(available),
  label: '安排生产',
  params: { order: String(order.id), product: String(line.productId), quantity: quantityString(remaining - available) },
});

/** 一个产品（还要发的不为 0、规格对得上）：够不够发、要不要订纸板、要不要接着排产 */
function planProduct(ctx: PlanContext, plan: GroupPlan, { line, remaining }: Remaining) {
  const available = availableFor(ctx.stocks, line),
    own = ownTasks(ctx.tasks, line);
  if (available >= remaining) plan.ready.push(line.productName);
  else if (available > 0) plan.partial.push(line.productName);
  // 分批做的订单，已排的做完了还差就要接着排。还在做的先等它做完。
  const working = own.some(unfinished);
  // 订单状态是整单的：别的产品还在做时整单也是“生产中”。这个产品库存已经够发，就不再提醒排产。
  const shortage = remaining - available;
  // 库存不够发、还没开工的产品才需要订纸板；已经做出过一批的，说明纸板有着落。
  const started = own.some((t) => safeUnits(t.completed) > 0);
  if (ctx.notYetMade && ctx.noPurchase && shortage > 0 && !started && !plan.boards.some((b) => b.productId === line.productId))
    plan.boards.push({ productId: line.productId, name: line.productName });
  if (ctx.notYetMade && !working && shortage > 0) plan.schedule.push(scheduleStep(ctx.order, line, remaining, available));
}

function planGroups(ctx: PlanContext, groups: readonly Remaining[]): GroupPlan {
  const plan: GroupPlan = { ready: [], partial: [], boards: [], schedule: [], mismatches: [] };
  for (const group of groups) {
    if (group.remaining <= 0) continue;
    const mismatched = mismatchOf(ctx.stocks, group.line);
    if (mismatched)
      plan.mismatches.push(group.line.productName + '：' + specificationMismatchText(mismatched, group.line) + '，核对好之前送不了货');
    else planProduct(ctx, plan, group);
  }
  return plan;
}

/**
 * 订料：服务端按有效采购单算出“未关联采购单”（materialProgress 为 none），关联记录里也没有有效采购，才提示。
 * 拿不到这两项事实时不提示。
 */
const noPurchaseFor = (order: StepOrder, purchases: readonly StepPurchase[] | undefined) =>
  order.materialProgress === 'none' &&
  purchases != null &&
  !purchases.some((p) => !p.archived && p.businessStatus !== '已取消');

const deliveryStep = (order: StepOrder, names: string[]): NextStep => ({
  key: 'delivery',
  kind: 'delivery',
  title: '建送货单',
  detail: names.join('、') + ' 有库存可发',
  label: '建送货单',
  params: { order: String(order.id) },
});
const draftStep = (d: StepDelivery): NextStep => ({
  key: 'draft-' + String(d.id),
  kind: 'confirm_delivery',
  title: '送货 ' + d.number + ' 待送货',
  detail: '导出送货单时出库扣库存。',
  label: '打开送货单',
  params: { doc: String(d.id) },
});
const completeStep = (t: StepTask): NextStep => ({
  key: 'complete-' + String(t.id),
  kind: 'complete',
  title: '登记完工 ' + t.number,
  detail: '已完工 ' + String(t.completed ?? 0) + ' / ' + String(t.quantity) + ' ' + (t.unit || ''),
  label: '登记完工',
  params: { task: String(t.id) },
});
/** 先订纸板再排产：订料放在安排生产前面。尺寸和张数没有展开计算的依据，留给人填。 */
const purchaseStep = (order: StepOrder, boards: GroupPlan['boards']): NextStep => ({
  key: 'purchase',
  kind: 'purchase',
  title: '安排订料',
  detail: boards.map((b) => b.name).join('、') + ' 要生产，还没有关联采购单',
  label: '安排订料',
  params: { order: String(order.id), products: boards.map((b) => b.productId).join(',') },
});
/** 关联的有效采购单还没下单、还没到齐的提示 */
const purchaseNotes = (purchases: readonly StepPurchase[]) =>
  purchases.flatMap((p) => {
    if (p.archived || p.businessStatus === '已取消') return [];
    if (p.businessStatus === '待订货') return ['采购 ' + p.number + ' 还没有下单'];
    return p.arrivalProgress !== '全部到货' ? ['采购 ' + p.number + ' 还没到齐'] : [];
  });

export function orderNextSteps(order: StepOrder, related: StepRelated): NextSteps {
  const lines = (order.lines || []).map((line) => ({ line, remaining: safeUnits(line.remainingQuantity) }));
  const settled = settledOrder(order, lines);
  if (settled) return settled;
  const tasks = (related?.tasks || []).filter(activeDoc),
    stocks = related?.stocks || [],
    drafts = (related?.deliveries || []).filter((d) => activeDoc(d) && d.status === 'draft');
  const open = tasks.filter((t) => t.status === 'confirmed' && unfinished(t));
  const ctx: PlanContext = {
    order,
    tasks,
    stocks,
    notYetMade: ['已确认', '生产中'].includes(order.status),
    noPurchase: noPurchaseFor(order, related?.purchases),
  };
  const plan = planGroups(ctx, productGroups(lines, stocks, pendingByOrderLine(drafts, order.id)));
  const { ready, partial, boards } = plan;
  return {
    steps: [
      ...drafts.map(draftStep),
      // 库存够发的最优先；只够发一部分时，先把生产安排好
      ...(ready.length ? [deliveryStep(order, ready)] : []),
      ...open.map(completeStep),
      ...(boards.length ? [purchaseStep(order, boards)] : []),
      ...plan.schedule,
      ...(partial.length && !ready.length ? [deliveryStep(order, partial)] : []),
    ],
    notes: [...plan.mismatches, ...purchaseNotes(related?.purchases || [])],
    lines: lines.map((x) => lineProgress(x, tasks, stocks)),
    mismatches: plan.mismatches,
  };
}

/** 采购单的下一步：下单给供应商、登记到货 */
export function purchaseNextSteps(purchase: Omit<StepPurchase, 'number'> & { id: number }): NextSteps {
  const result: NextSteps = { steps: [], notes: [], lines: [] };
  if (purchase.archived) return result;
  if (purchase.businessStatus === '已取消') {
    result.done = '采购已取消';
  } else if (purchase.businessStatus === '待订货') {
    result.steps.push({
      key: 'export',
      kind: 'export',
      title: '下单给供应商',
      detail: '导出订货单交给供应商，下载完成后采购单变成待到货，到货页能看到。可以在采购单列表里勾选同一家供应商的几张一起导出。',
      label: '导出订货单',
    });
  } else if (purchase.arrivalProgress === '全部到货') {
    result.done = '已全部到货';
  } else {
    // 已订货的采购单已经在订货批次里待到货了，到货安排在订货单上
    result.steps.push({
      key: 'arrival',
      kind: 'arrival',
      title: '登记到货',
      detail: '供应商送货到了，按送货单填实到多少，确认后直接入库；没到齐的继续待到货。',
      label: '登记到货',
      params: { purchase: String(purchase.id) },
    });
  }
  return result;
}
