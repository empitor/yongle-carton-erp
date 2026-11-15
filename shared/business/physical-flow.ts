import { z } from 'zod';
import { FINISHED_UNIT, RAW_UNIT, finishedUnit, rawUnit } from '../core/index.js';
import { chosenId, dateSchema, exactPriceSchema } from '../core/index.js';
import { stockItemSchema } from './operations.js';
import { positiveQuantity, quantityText, quantityUnits } from '../core/index.js';
import { inspectionFields, arrivalTimeSchema } from './arrival.js';
import { NOTE_MAX_LENGTH, SQUARE_METRE_SHIFT, UNIT_MAX_LENGTH } from './limits.js';
export const flowKinds = ['arrival', 'task', 'production', 'delivery'] as const;
export type FlowKind = (typeof flowKinds)[number];
/** 是不是四种单据之一（到货、生产任务、完工、送货） */
export const isFlowKind = (kind: string): kind is FlowKind => flowKinds.some((k) => k === kind);
/** 单据的名字：全站一个说法（详情头部、窗口标题、流水来源、关联单据、“关联与历史”都用它） */
export const flowNames: Record<FlowKind, string> = {
  arrival: '到货单',
  task: '生产任务',
  production: '完工记录',
  delivery: '送货单',
};
/**
 * 单据叫法：话里、按钮里说“这张××”时用（更正送货单、“完工单 DJ-… 已更正为…”、“送货单没有这一项可改”）。
 * 和上面的 flowNames 分开：flowNames 是页面、列表、关联记录里的名字（完工的页面叫“完工记录”），这里一张一张地叫“完工单”
 */
export const flowDocNames: Record<FlowKind, string> = {
  arrival: '到货单',
  task: '生产任务',
  production: '完工单',
  delivery: '送货单',
};
export const flowStates: Record<string, string> = {
  draft: '待核对',
  confirmed: '已确认',
  cancelled: '已取消',
  reversed: '已冲销',
};
/** 单据有效：没归档、没取消、没撤销。订单“下一步”、排产计划、订单还差什么都只数有效的单据。 */
export const activeDoc = (d: { archived?: unknown; status?: unknown }) =>
  !d.archived && d.status !== 'cancelled' && d.status !== 'reversed';
/**
 * 还没核对的单据（存的是 draft）按单据说清楚在等什么，界面上不说“草稿”：
 * 送货是待送货，到货、完工是待入库。生产任务没有这一步（安排即下达，建表也拦）。
 */
export const pendingLabels: Partial<Record<FlowKind, string>> = {
  delivery: '待送货',
  arrival: '待入库',
  production: '待入库',
};
export function flowStatusLabel(doc: {
  kind: string;
  status: string;
  quantity?: string;
  completed?: string;
  pendingCompleted?: string;
  shippedAt?: string | null;
  deliveredAt?: string | null;
}) {
  if (doc.status === 'draft') return (isFlowKind(doc.kind) && pendingLabels[doc.kind]) || flowStates.draft;
  if (doc.status !== 'confirmed') return flowStates[doc.status] || doc.status;
  // 送货：出库后“送货中”，客户收到后“已送达”
  if (doc.kind === 'delivery') return doc.deliveredAt ? '已送达' : '送货中';
  // 生产任务：登记了完工单就算开工（待核对入库的也算，和 server/flow/read.ts 的 taskUntouched 同一口径）
  if (doc.kind === 'task') {
    const done = quantityUnits(doc.completed || '0'),
      waiting = quantityUnits(doc.pendingCompleted || '0'),
      planned = quantityUnits(doc.quantity || '0');
    return planned > 0 && done >= planned ? '已完工' : done > 0 || waiting > 0 ? '生产中' : '待生产';
  }
  return doc.kind === 'arrival' ? '已确认收货' : '已确认完工';
}
/**
 * 界面上的状态叫法（列表、详情、关联单据、排产板、导出、“关联与历史”都用这一个）：
 * 不说“冲销”，撤回统一叫“已撤销”；到货、完工确认后就是“已入库”，到货、送货、完工被更正过的叫“已更正”；
 * 送货出库后“送货中”，客户收到“已送达”。到货、送货页的记录用 pending / cancelled 标记，也认。
 */
export function flowStatusText(d: {
  kind: string;
  status?: string;
  pending?: boolean;
  cancelled?: boolean;
  effective?: boolean;
  replacedBy?: unknown;
  quantity?: string;
  completed?: string;
  pendingCompleted?: string;
  shippedAt?: string | null;
  deliveredAt?: string | null;
}) {
  // 单据被更正时原单也是撤回状态，但有 replacedBy：叫“已更正”，和采购单下面的到货记录一样
  if (d.status === 'reversed') return d.replacedBy ? '已更正' : '已撤销';
  if (d.cancelled || d.status === 'cancelled') return '已取消';
  const status = d.pending ? 'draft' : d.status || 'confirmed';
  const label = flowStatusLabel({ ...d, status });
  if (status === 'confirmed' && (d.kind === 'arrival' || d.kind === 'production'))
    return d.effective === false ? '已更正' : '已入库';
  return label;
}
/**
 * 列表“状态”筛选：选项就是全站的状态叫法（flowStatusText），单据页、到货送货页、助手查记录同一个比法。
 * 行可以是单据（/api/flow），也可以是到货、送货页的记录（带 pending、cancelled 标记）；kind 按所在的页面给。
 */
export const flowStatusChoices: Record<FlowKind, string[]> = {
  task: ['待生产', '生产中', '已完工', '已取消', '已撤销'],
  production: ['待入库', '已入库', '已更正', '已取消', '已撤销'],
  arrival: ['待入库', '已入库', '已更正', '已取消', '已撤销'],
  delivery: ['待送货', '送货中', '已送达', '已更正', '已取消', '已撤销'],
};
export const matchesFlowStatus = (row: Omit<Parameters<typeof flowStatusText>[0], 'kind'>, kind: FlowKind, status: string) =>
  !status || flowStatusText({ ...row, kind }) === status;
// 要选的编号：没选、填了 0 或负数报“请选择××”（见 shared/core/domain.ts 的 chosenId），可以不关联的留空是 null
const id = (what: string) => chosenId(what);
const optionalId = (what: string) => chosenId(what, true).nullable().default(null);
/** 单据的说明文字（备注、地址、联系人这类）：去掉首尾空白，最多 2000 字；说明编辑（server/flow/document-info.ts）也用它 */
export const noteText = z.string().trim().max(NOTE_MAX_LENGTH);
/** 完工单的实际操作人员（说明编辑也用它） */
export const operatorText = z.string().trim().min(1, '请填写实际操作人员').max(100);
const text = noteText.default('');
// 更正关系（correctionOf、replacedBy）只由更正（server/flow/correction.ts）写，单据输入里不收
const base = { date: dateSchema, notes: text };
export const arrivalLineSchema = z.object({
  stockId: optionalId('库存品'),
  purchaseLineId: optionalId('采购明细'),
  item: z
    .object(stockItemSchema.shape)
    .omit({ kind: true, productId: true })
    // 到货的纸板只有“张”：空、没写的 flowInput 归成“张”，别的单位由单据保存服务拦
    .extend({ unit: z.string().trim().max(UNIT_MAX_LENGTH).default(RAW_UNIT) }),
  quantity: positiveQuantity,
  ...inspectionFields,
  statedQuantity: quantityText.nullable().default(null),
  unitPrice: exactPriceSchema.nullable().default(null),
  priceBasis: z.enum(['area', 'quantity'], { error: '计价依据只能选按平方米或按张' }).nullable().default('area'),
  statedArea: z
    .string()
    .trim()
    .regex(/^(0|[1-9]\d{0,14})(\.\d{1,12})?$/, '面积使用非负十进制数，最多12位小数')
    .nullable()
    .default(null),
  differenceReason: text,
});
const arrivalFields = {
  ...base,
  actualTime: arrivalTimeSchema,
  supplierId: id('供应商'),
  reference: z.string().trim().max(100).default(''),
  sourceId: z.uuid().nullable().default(null),
  /** 按订货批次登记的到货单记下批次（order_batches.id） */
  orderBatchId: id('订货单').optional(),
};
const arrivalDated = (v: { reference: string }) => !!v.reference;
export const arrivalDatedMessage = '请填写供应商送货单号或内部批次。';
export const arrivalSchema = z
  .object({ ...arrivalFields, lines: z.array(arrivalLineSchema).min(1, '至少要有一行明细').max(100) })
  .refine(arrivalDated, { message: arrivalDatedMessage, path: ['reference'] });
/**
 * 库里的到货单内容：和 arrivalSchema 只差一处，明细数量可以是 0。到货更正能把某一行改成 0（这一行其实没到货），
 * 替代单里就留着这一行，以后还能再更正回来；这样的单据要读得出来，管理员也要改得了。
 * flowInput 用这一份；新登记、待入库的到货单每行必须大于 0，由服务端保存时按 arrivalSchema 拦
 * （server/flow/validate.ts 的 documentInput）。
 */
const arrivalDocumentSchema = z
  .object({
    ...arrivalFields,
    lines: z.array(arrivalLineSchema.extend({ quantity: quantityText })).min(1, '至少要有一行明细').max(100),
  })
  .refine(arrivalDated, { message: arrivalDatedMessage, path: ['reference'] });
export const taskSchema = z.object({
  ...base,
  plannedDate: dateSchema.nullable().optional(),
  plannedTime: arrivalTimeSchema,
  productId: id('产品'),
  quantity: positiveQuantity,
  // 生产任务按成品算，单位只有“只”（“个”、没写都存成“只”；新建或改成别的单位由单据保存服务拦，数据库也有约束）
  unit: z.string().trim().max(UNIT_MAX_LENGTH).default(FINISHED_UNIT),
  orderIds: z.array(id('订单')).max(100).default([]),
});
export const productionSchema = z
  .object({
    ...base,
    taskId: optionalId('生产任务'),
    productId: id('产品'),
    // 入哪个成品库存由产品决定（一个产品只有一个成品库存），不用传；服务端保存时按产品对应上、存进单据。
    // 传了的必须就是这个产品的那一个
    finishedStockId: optionalId('入库的成品'),
    goodQuantity: quantityText,
    scrapQuantity: quantityText.default('0'),
    operator: operatorText,
    materials: z
      .array(
        z.object({ stockId: id('领用的库存品'), issued: positiveQuantity, returned: quantityText.default('0') }),
      )
      .min(1, '至少要有一行领料')
      .max(100),
  })
  .refine((v) => v.materials.every((m) => quantityUnits(m.returned) <= quantityUnits(m.issued)), {
    message: '退料数量不能超过领料数量',
    path: ['materials'],
    // 数量写法不对的已经报过校验错误：不再比（quantityUnits 遇到非法值会抛普通错误，服务端就成了 500）
    when: (payload) => payload.issues.length === 0,
  });
export const deliverySchema = z.object({
  ...base,
  plannedDate: dateSchema.nullable().optional(),
  plannedTime: arrivalTimeSchema,
  actualTime: arrivalTimeSchema,
  customerId: id('客户'),
  address: text,
  contact: text,
  phone: text,
  allowOverdelivery: z.boolean().default(false),
  overdeliveryReason: text,
  lines: z
    .array(
      z.object({
        orderId: id('订单'),
        orderLineId: id('订单明细'),
        stockId: id('出库的库存品'),
        quantity: positiveQuantity,
        notes: text,
      }),
    )
    .min(1, '至少要有一行明细')
    .max(100),
});
export const flowScheduleSchema = z.strictObject({
  plannedDate: dateSchema,
  plannedTime: arrivalTimeSchema.optional(),
  expectedVersion: z.number().int().positive(),
  requestId: z.uuid(),
});
/** 每种单据的输入整理后的样子（flowInput 的结果） */
type FlowInputs = {
  arrival: z.output<typeof arrivalDocumentSchema>;
  task: z.output<typeof taskSchema>;
  production: z.output<typeof productionSchema>;
  delivery: z.output<typeof deliverySchema>;
};
// 生产任务的单位存成“只”（“个”、没写都算“只”）；到货明细的单位存成“张”（空、没写都算“张”）。
// 归一后仍是别的单位的原样返回，由服务端 server/flow/validate.ts 的 documentInput 拒收
const inputOf: { [K in FlowKind]: (raw: unknown) => FlowInputs[K] } = {
  arrival: (raw) => {
    const v = arrivalDocumentSchema.parse(raw);
    return { ...v, lines: v.lines.map((l) => ({ ...l, item: { ...l.item, unit: rawUnit(l.item.unit) } })) };
  },
  task: (raw) => {
    const v = taskSchema.parse(raw);
    return { ...v, unit: finishedUnit(v.unit) };
  },
  production: (raw) => productionSchema.parse(raw),
  delivery: (raw) => deliverySchema.parse(raw),
};
/**
 * 把表单或库里的单据内容整理成单据输入。到货明细的数量在这里可以是 0（见 arrivalDocumentSchema）：
 * 新登记和待入库的到货单不许有 0，由服务端保存时拦，不在这里拦。
 */
export function flowInput<K extends FlowKind>(kind: K, raw: unknown): FlowInputs[K] {
  return inputOf[kind](raw);
}
/** 十进制数里科学记数法的指数最多多大（再大就当无效数，不去算天文数字） */
const MAX_DECIMAL_EXPONENT = 400;
/** 一个十进制数写成整数系数和小数位数：12.5 是 125 和 1 位 */
function decimalTerm(v: string) {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(v);
  if (!match || Math.abs(Number(match[3] || 0)) > MAX_DECIMAL_EXPONENT) throw new Error('无效十进制数');
  const [, a, b = '', exponent = '0'] = match,
    termScale = b.length - Number(exponent),
    digits = BigInt(a + b);
  return {
    coefficient: termScale < 0 ? digits * 10n ** BigInt(-termScale) : digits,
    scale: Math.max(0, termScale),
  };
}
// 十进制精确面积/金额。尺寸单位未知时返回null，不把未知尺寸当作毫米。
function multiplyDecimal(values: [string, ...string[]], divisionScale = 0): string {
  const terms = values.map(decimalTerm);
  const value = terms.map((t) => t.coefficient).reduce((product, c) => product * c),
    scale = terms.reduce((n, t) => n + t.scale, divisionScale);
  const s = String(value).padStart(scale + 1, '0');
  return scale ? (s.slice(0, -scale) + '.' + s.slice(-scale)).replace(/\.?0+$/, '') : s;
}
/** 算纸板面积要用的库存品资料：单位、长、宽和尺寸单位 */
export type SheetItem = {
  unit?: string | null;
  length?: number | null;
  width?: number | null;
  dimensionUnit?: string | null;
};
export function sheetArea(item: SheetItem, quantity: string): string | null {
  const unit = item.dimensionUnit;
  if (item.unit !== RAW_UNIT || (unit !== 'mm' && unit !== 'cm') || !((item.length ?? 0) > 0) || !((item.width ?? 0) > 0))
    return null;
  return multiplyDecimal([String(item.length), String(item.width), quantity], SQUARE_METRE_SHIFT[unit]);
}
/** 采购、到货一行的金额：数量、单价和计价依据（按面积时还要纸板资料） */
type PricedLine = SheetItem & { quantity: string; unitPrice?: string | null; priceBasis?: string | null };
export function purchaseLineAmount(line: PricedLine): string | null {
  if (line.unitPrice == null || line.priceBasis === null) return null;
  const basis = line.priceBasis === 'area' ? sheetArea(line, line.quantity) : line.quantity;
  return basis == null ? null : multiplyDecimal([basis, line.unitPrice]);
}
