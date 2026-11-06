import { quantityString, quantityUnits } from './operations.js';

/** 详情面板的“下一步”：只根据已有单据和库存判断，没有依据的事情不提示。 */
export type NextStep = {
  key: string;
  kind: 'confirm' | 'schedule' | 'confirm_task' | 'complete' | 'delivery' | 'confirm_delivery' | 'arrival' | 'arrival_plan' | 'export';
  title: string;
  detail?: string;
  label?: string;
  /** 打开单据或表单时用的参数 */
  params?: Record<string, string>;
};
export type OrderLineProgress = {
  id: number;
  name: string;
  unit: string;
  remaining: string;
  available: string;
  /** 'none' 未排产；否则是“已完工/计划” */
  production: string;
};
export type NextSteps = { done?: string; steps: NextStep[]; notes: string[]; lines: OrderLineProgress[] };

const units = (v: unknown) => {
  try {
    return quantityUnits(String(v ?? 0));
  } catch {
    return 0;
  }
};
const active = (d: any) => !d.archived && !['cancelled', 'reversed'].includes(d.status);

export function orderNextSteps(order: any, related: any): NextSteps {
  const result: NextSteps = { steps: [], notes: [], lines: [] };
  if (order.archived) return result;
  if (order.status === '已取消') {
    result.done = '订单已取消';
    return result;
  }
  if (order.status === '草稿') {
    result.steps.push({
      key: 'confirm',
      kind: 'confirm',
      title: '确认订单',
      detail: '确认后才能安排生产和送货。',
      label: '确认订单',
    });
    return result;
  }
  const lines = (order.lines || []).map((l: any) => ({
    line: l,
    remaining: units(l.remainingQuantity ?? l.quantity),
  }));
  if (order.status === '已发货' || (lines.length && lines.every((x: any) => x.remaining <= 0))) {
    result.done = '已全部发货';
    return result;
  }
  const tasks = (related?.tasks || []).filter(active),
    stocks = related?.stocks || [],
    drafts = (related?.deliveries || []).filter((d: any) => active(d) && d.status === 'draft'),
    confirmedTasks = tasks.filter((t: any) => t.status === 'confirmed'),
    draftTasks = tasks.filter((t: any) => t.status === 'draft');
  const open = confirmedTasks.filter((t: any) => units(t.completed) < units(t.quantity));
  const ready: string[] = [],
    partial: string[] = [],
    schedule: NextStep[] = [];
  for (const { line, remaining } of lines) {
    const available = stocks
      .filter((s: any) => s.productId === line.productId && s.unit === line.unit)
      .reduce((n: number, s: any) => n + Math.max(0, Number(s.availableUnits) || 0), 0);
    const own = tasks.filter((t: any) => t.productId === line.productId);
    result.lines.push({
      id: line.id,
      name: line.productName,
      unit: line.unit,
      remaining: quantityString(Math.max(0, remaining)),
      available: quantityString(available),
      production: own.length
        ? quantityString(own.reduce((n: number, t: any) => n + units(t.completed), 0)) +
          ' / ' +
          quantityString(own.reduce((n: number, t: any) => n + units(t.quantity), 0))
        : 'none',
    });
    if (remaining <= 0) continue;
    if (available >= remaining) ready.push(line.productName);
    else if (available > 0) partial.push(line.productName);
    if (!own.length && available < remaining)
      schedule.push({
        key: 'schedule-' + line.id,
        kind: 'schedule',
        title: '安排生产 · ' + line.productName,
        detail:
          '待发 ' +
          quantityString(remaining) +
          ' ' +
          line.unit +
          '，库存可用 ' +
          quantityString(available),
        label: '安排生产',
        params: { order: String(order.id), product: String(line.productId) },
      });
  }
  const delivery = (names: string[]): NextStep => ({
    key: 'delivery',
    kind: 'delivery',
    title: '建送货单',
    detail: names.join('、') + ' 有库存可发',
    label: '建送货单',
    params: { order: String(order.id) },
  });
  for (const d of drafts)
    result.steps.push({
      key: 'draft-' + d.id,
      kind: 'confirm_delivery',
      title: '确认送货 ' + d.number,
      detail: '草稿还没有扣库存。',
      label: '打开送货单',
      params: { doc: String(d.id) },
    });
  // 库存够发的最优先；只够发一部分时，先把生产安排好
  if (ready.length) result.steps.push(delivery(ready));
  for (const t of draftTasks)
    result.steps.push({
      key: 'task-' + t.id,
      kind: 'confirm_task',
      title: '确认生产任务 ' + t.number,
      label: '打开任务',
      params: { doc: String(t.id) },
    });
  for (const t of open)
    result.steps.push({
      key: 'complete-' + t.id,
      kind: 'complete',
      title: '登记完工 ' + t.number,
      detail: '已完工 ' + (t.completed ?? 0) + ' / ' + t.quantity + ' ' + (t.unit || ''),
      label: '登记完工',
      params: { task: String(t.id) },
    });
  result.steps.push(...schedule);
  if (partial.length && !ready.length) result.steps.push(delivery(partial));
  for (const p of related?.purchases || []) {
    if (p.archived || p.businessStatus === '已取消') continue;
    if (p.businessStatus === '待订货') result.notes.push('采购 ' + p.number + ' 还没有下单');
    else if (p.arrivalProgress !== '全部到货') result.notes.push('采购 ' + p.number + ' 还没到齐');
  }
  return result;
}

export function purchaseNextSteps(purchase: any): NextSteps {
  const result: NextSteps = { steps: [], notes: [], lines: [] };
  if (purchase.archived) return result;
  if (purchase.businessStatus === '已取消') {
    result.done = '采购已取消';
  } else if (purchase.businessStatus === '待订货') {
    result.steps.push({
      key: 'export',
      kind: 'export',
      title: '下单给供应商',
      detail: '用上方“单据”导出正式订货单，交付后自动标记已订货。',
    });
  } else if (purchase.arrivalProgress === '全部到货') {
    result.done = '已全部到货';
  } else {
    result.steps.push(
      {
        key: 'arrival',
        kind: 'arrival',
        title: '登记到货',
        detail: '货到后登记实收和验收结果。',
        label: '登记实际到货',
        params: { purchase: String(purchase.id) },
      },
      {
        key: 'plan',
        kind: 'arrival_plan',
        title: '新建到货计划',
        label: '新建计划',
        params: { purchase: String(purchase.id), isPlan: '1' },
      },
    );
  }
  return result;
}
