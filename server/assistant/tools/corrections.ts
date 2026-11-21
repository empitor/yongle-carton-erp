// 助手工具：更正已生效的到货单、送货单、完工单（arrival.correct、delivery.correct、production.correct）。
// 三种和页面上的更正窗走同一个服务（server/flow 的 planCorrection、correctDocument）：撤销原单、另出一张替代单，流水只追加。
// 卡片就是预览：方案里存着预览摘要，确认时服务按同一份方案核对，单据、库存或订单变了就拒绝。
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { plainPrice } from '../../../shared/core/index.js';
import {
  UNPRICED_TEXT,
  arrivalCorrectionPreviewSchema,
  deliveryCorrectionPreviewSchema,
  deliveryCorrectionViewSchema,
  flowDocNames,
  productionCorrectionPreviewSchema,
  productionCorrectionViewSchema,
  type FlowKind,
} from '../../../shared/business/index.js';
import { correctDocument, planCorrection } from '../../flow/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { idAndInput, positive, type ToolContext } from './context.js';
import { planTool } from './define.js';

type Line = { label: string; value: string };
type Spec = { kind: FlowKind; name: string; warning: string };

/** 命令 → 它更正的单据种类、叫法（和界面按钮一样）、卡片上的提醒 */
const specs: Record<string, Spec> = {
  'arrival.correct': {
    kind: 'arrival',
    name: '更正' + flowDocNames.arrival,
    warning: '撤销原到货单、另出一张更正后的到货单；库存、采购单的已到货一起改，应付跟着变。',
  },
  'delivery.correct': {
    kind: 'delivery',
    name: '更正' + flowDocNames.delivery,
    warning: '撤销原送货单、另出一张更正后的送货单；库存和订单已发跟着变，入过账的要在财务里红字冲销并重做。',
  },
  'production.correct': {
    kind: 'production',
    name: '更正' + flowDocNames.production,
    warning: '撤销原完工单、另出一张更正后的完工单；成品和纸板库存、生产任务的已入库跟着变。',
  },
};
/** 单据种类 → 更正它的命令 */
const commandOf = new Map(Object.entries(specs).map(([command, s]) => [s.kind, command]));

/** 参数是预览输入加上单据编号（和页面更正窗的预览同一份结构） */
function buildCorrection(ctx: ToolContext, tool: string, { id, ...input }: { id: number } & Record<string, unknown>, actor: Actor): ToolPlan {
  const spec = specs[tool];
  const before = ctx.flow.get(id);
  // 命令和单据种类对不上：直接说该用哪一个（生产任务不能更正，由服务说明原因）
  const right = commandOf.get(before.kind);
  if (before.kind !== spec.kind && right)
    throw new AppError('这是' + flowDocNames[before.kind] + '，请用' + specs[right].name + '（' + right + '）。', 409);
  const after = planCorrection(ctx.store, id, input, actor);
  return {
    tool,
    args: { id, input: { ...input, requestId: randomUUID(), previewDigest: after.previewDigest } },
    label: spec.name,
    highRisk: false,
    before,
    after,
    warnings: [spec.warning, ...(after.warnings ?? [])],
  };
}

const correction = {
  build: buildCorrection,
  commit: (ctx: ToolContext, plan: ToolPlan, actor: Actor) => {
    const { id, input } = idAndInput.parse(plan.args);
    return correctDocument(ctx.store, id, input, actor);
  },
};

export const correctionTools = [
  planTool(
    {
      name: 'arrival.correct',
      risk: 'review',
      description:
        '更正到货单：到货数量或验收数登记错了时用；只想先看更正前后对比也用它，只出卡片不改数据，人确认后才改。先 records.get（arrivals）读到货单的行和 version；lines 列出原单每一行（index 是原单行号，从 0 起）和更正后的 quantity，可另写验收合格数量、拒收数量、入库数量；reason 写用户说的原因。撤销原单、另出一张替代单，原记录和更正链保留。',
      schema: arrivalCorrectionPreviewSchema.extend({ id: positive }),
    },
    correction,
  ),
  planTool(
    {
      name: 'delivery.correct',
      risk: 'review',
      description:
        '更正送货单：已出库的送货单数量登记错了、某一行其实没发时用；只想先看更正前后对比也用它，只出卡片不改数据，人确认后才改。先 records.get 读送货单的行和 version；lines 列出要留的原单行（index 从 0 起）和正确的 quantity，没列的行算没发；reason 写用户说的原因。撤销原单、另出一张替代单，出库日和送达记录照旧。',
      schema: deliveryCorrectionPreviewSchema.extend({ id: positive }),
    },
    correction,
  ),
  planTool(
    {
      name: 'production.correct',
      risk: 'review',
      description:
        '更正完工单：已入库的完工单合格数、报废数或领料登记错了时用；只想先看更正前后对比也用它，只出卡片不改数据，人确认后才改。先 records.get 读完工单和 version；只写要改的合格数、报废数，materials 写更正后的整张领料（index 是原单行号，新加的行带 stockId）；reason 写用户说的原因。撤销原单、另出一张替代单。',
      schema: productionCorrectionPreviewSchema.extend({ id: positive }),
    },
    correction,
  ),
];

type DeliveryView = z.output<typeof deliveryCorrectionViewSchema>;
type ProductionView = z.output<typeof productionCorrectionViewSchema>;

const money = (v: string | null | undefined) => (v == null ? UNPRICED_TEXT : plainPrice(v) + ' 元');
const qty = (v: string | null | undefined, unit: string | undefined) => (v ?? '0') + (unit ? ' ' + unit : '');
const change = (before: string | null | undefined, after: string, unit: string | undefined) =>
  before === after ? qty(after, unit) + '（不变）' : qty(before, unit) + ' → ' + qty(after, unit);
/** 原单第几行（新加的是 null）：卡片上从 1 数 */
const rowText = (index: number | null, added: string, prefix: string, suffix: string) =>
  index === null ? added : prefix + String(index + 1) + suffix;

/** 改了单据日期写一行：送货是出库日期，完工是完工日期 */
const dateLine = (label: string, date: DeliveryView['date']): Line[] =>
  date.before !== date.after ? [{ label, value: date.before + ' → ' + date.after }] : [];

/** 送货：每行数量前后、每条订单明细的已发前后、送货金额前后 */
function deliveryLines(view: DeliveryView): Line[] {
  const lines = view.lines.map((l) => ({
    label: rowText(l.index, '新加一行', '第 ', ' 行'),
    value: String(l.productName) + ' ' + change(l.before, l.after, l.unit),
  }));
  const orders = view.orderImpact.map((o) => ({
    label: '订单 ' + o.orderNumber + ' 已发',
    value: o.productName + ' ' + change(o.before, o.after, o.unit) + '（订货 ' + qty(o.ordered, o.unit) + '）',
  }));
  const amount = view.beforeAmount !== view.afterAmount && view.afterAmount != null
    ? [{ label: '送货金额', value: money(view.beforeAmount) + ' → ' + money(view.afterAmount) }]
    : [];
  return [...dateLine('出库日期', view.date), ...lines, ...orders, ...amount];
}

/** 完工：产品、合格、报废、每行领料和退料、生产任务的已入库前后 */
function productionLines(view: ProductionView): Line[] {
  const product = view.product.before.id !== view.product.after.id
    ? [{ label: '产品', value: view.product.before.name + ' → ' + view.product.after.name }]
    : [];
  const materials = view.materials.map((m) => ({
    label: rowText(m.index, '新加领料', '领料第 ', ' 行') + '（' + m.name + '）',
    value: '领用 ' + change(m.issued.before, m.issued.after, m.unit) + '，退料 ' + change(m.returned.before, m.returned.after, m.unit),
  }));
  const tasks = view.taskImpact.map((t) => ({
    label: '生产任务 ' + t.number + ' 已入库',
    value: change(t.before, t.after, t.unit) + '（计划 ' + qty(t.planned, t.unit) + '）',
  }));
  return [
    ...dateLine('完工日期', view.date),
    ...product,
    { label: '合格', value: change(view.good.before, view.good.after, view.unit) },
    { label: '报废', value: change(view.scrap.before, view.scrap.after, view.unit) },
    ...materials,
    ...tasks,
  ];
}

/** 命令 → 按它的预览结构读方案里的预览、写成卡片上的几行 */
const cardLines: Record<string, (after: unknown) => Line[]> = {
  'delivery.correct': (after) => deliveryLines(deliveryCorrectionViewSchema.parse(after)),
  'production.correct': (after) => productionLines(productionCorrectionViewSchema.parse(after)),
};

/**
 * 送货、完工更正卡片上原单那几行：每行更正前后（删掉的写 0，新加的从 0 起）、订单已发或任务已入库前后，都取自预览。
 * 到货的预览没有逐行前后，照普通单据列原单每行（返回 null）。
 */
export function correctionCardLines(plan: ToolPlan): Line[] | null {
  const lines = Object.hasOwn(cardLines, plan.tool) ? cardLines[plan.tool] : undefined;
  return lines && plan.after ? lines(plan.after) : null;
}
