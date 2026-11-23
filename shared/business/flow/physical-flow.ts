import { z } from 'zod';
import { FINISHED_UNIT, finishedUnit, isFlowKind, rawUnit, type FlowKind } from '../../core/index.js';
import { chosenId, dateSchema, exactPriceSchema, fieldLabel } from '../../core/index.js';
import { arrivalItemSchema, arrivalPriceBasisSchema, noteText } from '../operations/operations.js';
import { positiveQuantity, quantityText, quantityUnits } from '../../core/index.js';
import { inspectionFields } from './arrival.js';
import { arrivalTimeSchema } from '../operations/schedule.js';
import { UNIT_MAX_LENGTH } from '../operations/limits.js';
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
/**
 * 单据存的状态（flow_documents.status）：代码和 SQL 里按名字引用（flowStatus.confirmed），不写字面值，
 * 单据流转以外的 SQL 由 scripts/eslint-local-rules.mjs 的 no-flow-literals 拦。
 */
export const flowStatus = { draft: 'draft', confirmed: 'confirmed', cancelled: 'cancelled', reversed: 'reversed' } as const;
type FlowStatus = (typeof flowStatus)[keyof typeof flowStatus];
/**
 * 单据在归档标记、审计、库存流水来源里记的种类：前缀加单据种类（flowEntity('delivery') 是 flow_delivery）。
 * SQL 里按单据种类列拼的写 '${flowEntityPrefix}'||kind。
 */
export const flowEntityPrefix = 'flow_';
export const flowEntity = <K extends FlowKind>(kind: K): `${typeof flowEntityPrefix}${K}` => `${flowEntityPrefix}${kind}`;
/** 单据存的状态的叫法（建表的枚举，tests/schema-constraints.test.ts 比对）；给人看的叫法按单据种类，见 storedFlowStatusName */
export const flowStates: Record<string, string> = {
  draft: '待核对',
  confirmed: '已确认',
  cancelled: '已取消',
  // 业务单据不说“冲销”（那是财务凭证的词），撤回统一叫“已撤销”
  reversed: '已撤销',
} satisfies Record<FlowStatus, string>;
/** 已确认的单据按种类叫：到货、完工“已入库”，送货“已出库”，生产任务“已下达”（页面和使用手册上的说法） */
const confirmedNames: Record<FlowKind, string> = {
  arrival: '已入库',
  production: '已入库',
  delivery: '已出库',
  task: '已下达',
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
  return confirmedNames.arrival;
}
/**
 * 数据管理改单据状态的下拉、存的状态一个词说清（不看进度）：待核对按单据说（待入库、待送货），
 * 已确认按种类（已入库、已出库、已下达），已取消，已撤销。用的都是页面上已有的词。
 */
export function storedFlowStatusName(kind: FlowKind, status: string) {
  if (status === 'draft') return pendingLabels[kind] || flowStates.draft;
  if (status === 'confirmed') return confirmedNames[kind];
  return flowStates[status] || status;
}
/**
 * 人说的旧叫法（以前界面上出现过、助手查记录时还会有人这么说）：只用来认，不再显示。按存的状态比，和以前一样：
 * “已冲销”是撤回的（撤销的、被更正替代的原单都算），“已确认收货”“已确认完工”只是确认了的到货单、完工单。
 */
const flowStatusSayings: Record<string, { status: string; kind?: FlowKind }> = {
  已冲销: { status: 'reversed' },
  已确认收货: { status: 'confirmed', kind: 'arrival' },
  已确认完工: { status: 'confirmed', kind: 'production' },
};
/** 按旧叫法认一张单据；说的不是旧叫法返回 undefined（交给界面叫法 matchesFlowStatus 去比） */
export function matchesFlowSaying(row: { status?: string; replacedBy?: unknown }, kind: FlowKind, word: string) {
  const saying = Object.hasOwn(flowStatusSayings, word) ? flowStatusSayings[word] : undefined;
  return saying && row.status === saying.status && (!saying.kind || saying.kind === kind);
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
/** 完工单的机台操作（说明编辑也用它） */
export const operatorText = z.string().trim().min(1, '请填写机台操作').max(100);
const text = noteText.default('');
// 更正关系（correctionOf、replacedBy）只由更正（server/flow/correction.ts）写，单据输入里不收
const base = { date: dateSchema, notes: text };
export const arrivalLineSchema = z.object({
  stockId: optionalId('库存品'),
  purchaseLineId: optionalId('采购明细'),
  item: arrivalItemSchema,
  quantity: positiveQuantity,
  ...inspectionFields,
  statedQuantity: quantityText.nullable().default(null),
  unitPrice: exactPriceSchema.nullable().default(null),
  // 没写计价方式就留空（不猜按平方米）：照常入库，金额待定，财务按缺价格等人补
  priceBasis: arrivalPriceBasisSchema.default(null),
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
    finishedStockId: optionalId(fieldLabel('finishedStockId')),
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
