import type { NextStep, WorkbenchApi } from '../../shared/business/index';
import { DAY_MS, flowDocHref, pageHref, type Order } from '../../shared/core/index';
import type { Slots } from '../ui/index';

/**
 * 今日待办怎么分组：每张单只在一组里出现、只给最该做的那一步，组内按逾期天数、再按日期排。
 * 只算数据（不引 React、不发请求），行上的动作也是数据，按钮由今日页（TodayQueue）照着画。
 * 每张订单进哪一组、该办哪一步由服务端按订单详情同一套规则算好（几张单抢同一批货时按交期先后分库存）。
 */

/** 行上的动作：按钮类的要业务编辑权限才显示，链接类的都显示 */
type TodayAction =
  | { kind: 'confirm'; label: string; order: Order }
  /** 按钮文字是服务端那一步的 label（下一步的类型里它可以没有） */
  | { kind: 'step'; label?: string; orderId: number; step: { kind: NextStep['kind']; params?: Record<string, string> } }
  | { kind: 'ship'; label: string; orderId: number }
  | { kind: 'export'; label: string; deliveryId: number }
  | { kind: 'orderSheet'; label: string; purchaseId: number }
  | { kind: 'receive'; label: string; purchaseId: number }
  | { kind: 'link'; label: string; href: string };

export type TodayRowData = {
  key: string;
  number?: string;
  main: string;
  /** 交期、预计到货这类时间 */
  note?: string;
  /** 订单当前状态 */
  status?: string;
  late?: number;
  ai?: boolean;
  /** 点行打开详情 */
  href: string;
  action?: TodayAction;
  /** 规格对不上、送不了货的提示，和订单详情“下一步”下面的黄色提示同一句，显示在这一行下面 */
  hints?: string[];
  /** 排序用的日期 */
  due?: string;
};
type TodayGroup = {
  id: string;
  title: string;
  rows: TodayRowData[];
  /** 有现成筛好的列表时“全部 N 条”跳过去，否则在页面里展开 */
  all?: string;
  total?: number;
  /** 标题旁另一个链接（例如 AI 导入的份数） */
  extra?: { href: string; text: string };
};

/** 服务端 GET /business/today 的回答 */
type Today = WorkbenchApi['GET /business/today']['response'];
/** 一行订单要读的几项：今日待办给的带 summary、逾期天数；待确认订单是订单本身，带明细 */
type TodayOrderRow = {
  id: number;
  number: string;
  customerName: string;
  deliveryDate: string;
  status?: string;
  summary?: string;
  lines?: readonly { productName: string }[];
  lateDays?: number;
  mismatches?: string[];
};
type TodoStep = { kind: NextStep['kind']; label?: string; params?: Record<string, string> };
/** 今日待办里的订单：可发货的直接安排送货；排产、完工的带服务端算好的那一步（可发货的用不上 step） */
type TodoOrder = TodayOrderRow & { group: 'ship' | 'schedule' | 'complete'; step?: TodoStep };
/** 分组要用的今日数据：服务端回答里的这几项 */
type TodayData = {
  todo: readonly TodoOrder[];
  specMismatch?: readonly TodayOrderRow[];
  draftDeliveries: Today['draftDeliveries'];
  toOrder: Today['toOrder'];
  arrivalsDue: Today['arrivalsDue'];
};
type Mail = Awaited<ReturnType<NonNullable<Slots['inbox']>['pending']>>;
type AiFile = Awaited<ReturnType<NonNullable<Slots['aiFiles']>['open']>>[number];

/** 每组先列最急的几条，其余点“全部 N 条”。 */
export const TODAY_SHOWN = 5;

/** 今年的日期只写月日 */
const shortDate = (date: string | null | undefined, today: string) =>
  !date ? '' : date.slice(0, 4) === today.slice(0, 4) ? date.slice(5) : date;
const lineNames = (lines: readonly { productName: string }[] = []) => {
  const names = lines.map((l) => l.productName).filter(Boolean);
  return (names[0] || '') + (names.length > 1 ? ' 等' + names.length + '项' : '');
};
/** 过了日期几天（没过是 0） */
export const daysLate = (date: string | null | undefined, today: string) =>
  date && date < today ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / DAY_MS) : 0;
const byUrgency = (a: TodayRowData, b: TodayRowData) =>
  (b.late || 0) - (a.late || 0) || String(a.due || '').localeCompare(String(b.due || ''));

/**
 * 明细规格和产品现在的对不上、送不了货的订单（服务端 specMismatch）。
 * 已经进了别的分组的，提示挂在那一行下面（每张单只在一组里出现）；没进分组的才单独列进“要核对订单”。
 */
export function specCheckOrders<S extends { id: number; mismatches?: readonly string[] }>(data: {
  todo?: readonly { id: number }[];
  specMismatch?: readonly S[];
}) {
  const placed = new Set((data.todo || []).map((o) => o.id));
  return (data.specMismatch || []).filter((o) => !placed.has(o.id) && o.mismatches?.length);
}

/** AI 识别文件已经识别出内容了：动作是“核对”，否则是“识别” */
const recognized = (w: AiFile) =>
  !!w.hasDraft || w.markStatus === 'recognized' || ['recognized', 'draft'].includes(w.arrivalStatus ?? '');

/** 一张订单的一行 */
const orderRow = (o: TodayOrderRow, today: string, prefix = 'o'): TodayRowData => ({
  key: prefix + o.id,
  number: o.number,
  main: o.customerName + ' · ' + (o.summary ?? lineNames(o.lines)),
  note: '交期 ' + shortDate(o.deliveryDate, today),
  status: o.status,
  late: o.lateDays || undefined,
  due: o.deliveryDate,
  href: pageHref('orders', { order: o.id }),
});
// 进了分组的订单有明细规格对不上（比如另一项能先发），提示挂在那一行下面
const hinted = (row: TodayRowData, o: TodayOrderRow): TodayRowData => (o.mismatches?.length ? { ...row, hints: o.mismatches } : row);

/** 待排产、待完工：服务端算好的那一步 */
function stepRows(data: TodayData, group: 'schedule' | 'complete', today: string) {
  const rows: TodayRowData[] = [];
  for (const o of data.todo) {
    if (o.group !== group) continue;
    // 服务端给排产、完工的订单一定带这一步（workbench.ts 的 buildToday）；没有就是服务端组装错了，照实报出来
    if (!o.step) throw new Error('今日待办里订单 ' + o.number + ' 缺少要办的那一步，请刷新页面再试。');
    rows.push({ ...hinted(orderRow(o, today), o), action: { kind: 'step', label: o.step.label, orderId: o.id, step: o.step } });
  }
  return rows.sort(byUrgency);
}

/** 可发货：能安排送货的订单，加上待送货、要导出送货单的送货单 */
function shipRows(data: TodayData, today: string) {
  const orders = data.todo
    .filter((o) => o.group === 'ship')
    .map((o): TodayRowData => ({ ...hinted(orderRow(o, today), o), action: { kind: 'ship', label: '安排送货', orderId: o.id } }));
  const deliveries = data.draftDeliveries.map(
    (d): TodayRowData => ({
      key: 'd' + d.id,
      number: d.number,
      main: d.customerName,
      note: '计划 ' + shortDate(d.plannedDate, today),
      status: '待送货',
      late: daysLate(d.plannedDate, today) || undefined,
      due: d.plannedDate,
      href: flowDocHref('delivery', d.id),
      action: { kind: 'export', label: '导出送货单', deliveryId: d.id },
    }),
  );
  return [...orders, ...deliveries].sort(byUrgency);
}

/** 待订货、待到货的采购单 */
function purchaseGroups(data: TodayData, today: string): TodayGroup[] {
  return [
    {
      id: 'toOrder',
      title: '待订货',
      total: data.toOrder.length,
      all: pageHref('purchases', { businessStatus: '待订货' }),
      rows: data.toOrder.map(
        (p): TodayRowData => ({
          key: 'p' + p.id,
          number: p.number,
          main: p.supplierName + ' · ' + p.summary,
          note: p.expectedDate ? '要求 ' + shortDate(p.expectedDate, today) : undefined,
          href: pageHref('purchases', { record: p.id }),
          action: { kind: 'orderSheet', label: '导出订货单', purchaseId: p.id },
        }),
      ),
    },
    {
      id: 'arrival',
      title: '待到货',
      rows: data.arrivalsDue.map(
        (p): TodayRowData => ({
          key: 'a' + p.id,
          number: p.number,
          main: p.supplierName + ' · ' + p.summary,
          note: '预计 ' + shortDate(p.expectedDate, today),
          late: daysLate(p.expectedDate, today) || undefined,
          href: pageHref('purchases', { record: p.id }),
          action: { kind: 'receive', label: '登记到货', purchaseId: p.id },
        }),
      ),
    },
  ];
}

/** 收件箱：消息和 AI 识别文件 */
function inboxGroup(mail: Mail, imports: readonly AiFile[], aiNote?: (w: AiFile) => string): TodayGroup {
  return {
    id: 'inbox',
    title: '收件箱',
    total: mail.total + imports.length,
    all: mail.total > mail.rows.length ? pageHref('inbox') : undefined,
    extra: imports.length > TODAY_SHOWN ? { href: pageHref('ai-import'), text: 'AI 导入 ' + imports.length + ' 份' } : undefined,
    rows: [
      ...mail.rows.map(
        (m): TodayRowData => ({
          key: 'm' + m.id,
          main: m.fileName || m.text || '（无内容）',
          note: m.senderName || (m.channel === 'manual' ? '手动添加' : undefined),
          href: pageHref('inbox', { item: m.id }),
          action: { kind: 'link', label: '查看', href: pageHref('inbox', { item: m.id }) },
        }),
      ),
      ...imports.map(
        (w): TodayRowData => ({
          key: 'w' + w.id,
          main: w.fileName,
          note: aiNote ? aiNote(w) : '',
          ai: true,
          href: pageHref('ai-import', { workspace: w.id }),
          action: { kind: 'link', label: recognized(w) ? '核对' : '识别', href: pageHref('ai-import', { workspace: w.id }) },
        }),
      ),
    ],
  };
}

/**
 * 把今日数据分成组。data 是服务端 /business/today；pendingConfirm 是待确认订单（前几张和总数）；
 * mail、imports 是收件箱和 AI 识别文件（插槽给的，可能没有）；aiNote 写 AI 识别文件那一行的进度。
 */
export function todayGroups(input: {
  data: TodayData;
  pendingConfirm: { rows: readonly Order[]; total: number } | null;
  mail: Mail;
  imports: readonly AiFile[];
  aiNote?: (w: AiFile) => string;
  today: string;
}): TodayGroup[] {
  const { data, pendingConfirm, today } = input;
  return [
    {
      id: 'confirm',
      title: '待确认',
      total: pendingConfirm?.total ?? 0,
      all: pageHref('orders', { view: 'pending', range: 'all', status: '待确认' }),
      rows: (pendingConfirm?.rows || []).map((o) => ({
        ...orderRow(o, today, 'c'),
        status: undefined,
        late: undefined,
        action: { kind: 'confirm', label: '确认订单', order: o },
      })),
    },
    { id: 'schedule', title: '待排产', rows: stepRows(data, 'schedule', today) },
    { id: 'complete', title: '待完工', rows: stepRows(data, 'complete', today) },
    {
      // 明细规格和产品现在的对不上：库存不分给它、送不了货，也不进“可发货”，在这里提示去核对订单明细
      id: 'specCheck',
      title: '要核对订单',
      rows: specCheckOrders(data)
        .map((o): TodayRowData => ({
          ...orderRow(o, today, 's'),
          hints: o.mismatches,
          action: { kind: 'link', label: '打开订单', href: pageHref('orders', { order: o.id }) },
        }))
        .sort(byUrgency),
    },
    { id: 'ship', title: '可发货', rows: shipRows(data, today) },
    ...purchaseGroups(data, today),
    inboxGroup(input.mail, input.imports, input.aiNote),
  ];
}
