import { z } from 'zod';
import { dateSchema, quantityText } from '../core/index.js';
import { reversalRecordSchema } from './stock-flow-views.js';
import { arrivalLineSchema, arrivalSchema, deliverySchema, productionSchema, taskSchema, type FlowKind } from './physical-flow.js';

/*
 * 库里的单据：flow_documents.document 这一列 JSON。等于录入规则（physical-flow.ts）整理出来的内容，加上服务端写进去的字段
 * （确认人、流水号、取消撤销记录、更正关系、出库送达记录、名称快照、到货和送货明细的补全）。单据流转读写单据内容只走这里：
 * 读的时候 server/flow/read.ts 的 storedContent 把 flowDocumentSchema 交给 parseStoredJson（server/core，不合结构报服务端错误），
 * 写之前 server/flow/document-store.ts 用 flowDocumentContent 按同一份结构再查一遍。
 *
 * 结构用 strictObject：库里有、这里没写的字段直接报错，不悄悄丢掉（z.object 会丢，读、改、写一圈就把字段弄丢了）。
 * 从录入规则的 shape 派生，去掉只在录入时成立的校验：数量可以是 0（到货更正把一行改成 0、删掉没发的行以前的数），
 * 到货的“送货单号必填”这类整张的规则不在这里查（录入时查过）。服务端加字段时这里一起加，不然写的时候就报错。
 */

const id = z.number().int().positive();
const by = { reason: z.string(), by: z.string(), at: z.string() };
/*
 * 单据内容的字段分三类：录入的（physical-flow.ts 的录入结构）、生命周期记录（下面这几组）、服务端抄下来的快照
 * （名称、单价税率、材质楞型、面积金额……，严格结构减去前两类，登记在 flow-snapshot.ts）。
 */
/** 经办记录，每种单据都可能有：确认（server/flow/confirm.ts）、取消和撤销（undo.ts）写进去的 */
const records = {
  confirmedBy: z.string().optional(),
  confirmedAt: z.string().optional(),
  movements: z.array(z.string()).optional(),
  cancellation: z.strictObject(by).optional(),
  reversal: reversalRecordSchema.optional(),
};
/** 更正关系，每种单据都可能有：更正（server/flow/correction.ts）写进去的 */
const correction = {
  // 删除引擎删掉原单时写成 null（server/flow/deletion.ts 的 mirrors）
  correctionOf: id.nullable().optional(),
  correctionReason: z.string().optional(),
  correctedAt: z.string().optional(),
  replacedBy: id.optional(),
};
const lifecycle = { ...records, ...correction };
/** 送货单的出库（confirm.ts）、送达（FlowService.markDelivered）记录 */
const shipping = {
  shippedAt: z.string().optional(),
  shippedBy: z.string().optional(),
  deliveredAt: z.string().optional(),
  deliveredBy: z.string().optional(),
};
/** 到货更正的替代单：原单的到货记录编号（flow-原单编号） */
const receiptCorrection = { correctionOfReceiptId: z.string().optional() };
const keysOf = <T extends object>(shape: T) => Object.keys(shape).filter((k): k is Extract<keyof T, string> => Object.hasOwn(shape, k));
/**
 * 生命周期字段（四种单据合在一起）：经办记录（确认、取消撤销、送货的出库送达）和更正关系。
 * 快照登记（flow-snapshot.ts）按“严格结构减录入结构再减这些”认快照字段；拆送货单（server/business/order-edit-cascade.ts）照带经办记录
 */
export const lifecycleFields = { records: keysOf({ ...records, ...shipping }), correction: keysOf({ ...correction, ...receiptCorrection }) };
export type LifecycleField = (typeof lifecycleFields)[keyof typeof lifecycleFields][number];

/** 到货明细：核对入库（server/flow/validate-arrival.ts）补上面积、金额、采购单和供应商名 */
const arrivalLine = z.strictObject({
  ...arrivalLineSchema.shape,
  item: z.strictObject(arrivalLineSchema.shape.item.shape),
  quantity: quantityText,
  area: z.string().nullable().optional(),
  amount: z.string().nullable().optional(),
  purchaseId: id.nullable().optional(),
  purchaseNumber: z.string().optional(),
  supplierName: z.string().optional(),
});
const arrivalDocument = z.strictObject({
  ...arrivalSchema.shape,
  lines: z.array(arrivalLine),
  ...lifecycle,
  supplierName: z.string().optional(),
  ...receiptCorrection,
});
/** 生产任务、送货单的计划日：保存时没写就按单据日期补上（server/flow），库里一定有 */
const plannedDate = dateSchema;
const taskDocument = z.strictObject({
  ...taskSchema.shape,
  plannedDate,
  quantity: quantityText,
  ...lifecycle,
  productName: z.string().optional(),
});
const productionDocument = z.strictObject({
  ...productionSchema.shape,
  materials: z.array(z.strictObject({ ...productionSchema.shape.materials.element.shape, issued: quantityText })),
  ...lifecycle,
  productName: z.string().optional(),
});
/**
 * 送货明细：出库核对（server/flow/validate-delivery.ts）补上订单明细的品名、规格、单价、税率和产品尺寸、材质、楞型
 * （待送货的还没补，这几项没有）
 */
const deliveryLine = z.strictObject({
  ...deliverySchema.shape.lines.element.shape,
  quantity: quantityText,
  productName: z.string().optional(),
  specification: z.string().optional(),
  unit: z.string().optional(),
  orderNumber: z.string().optional(),
  externalPurchaseOrder: z.string().optional(),
  customerProductCode: z.string().optional(),
  unitPriceExact: z.string().optional(),
  amountExact: z.string().nullable().optional(),
  taxRate: z.string().optional(),
  taxMode: z.string().optional(),
  productId: id.optional(),
  length: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  dimensionUnit: z.string().nullable().optional(),
  /** 产品档案的材质、楞型（没填是空串），送货单导出的“材质 / 配纸”“楞型”两列印它 */
  material: z.string().optional(),
  flute: z.string().optional(),
});
const deliveryDocument = z.strictObject({
  ...deliverySchema.shape,
  plannedDate,
  lines: z.array(deliveryLine),
  ...lifecycle,
  customerName: z.string().optional(),
  ...shipping,
});

/** 每种单据库里的内容（不含种类：种类是行上的 kind 列） */
export type FlowDocuments = {
  arrival: z.output<typeof arrivalDocument>;
  task: z.output<typeof taskDocument>;
  production: z.output<typeof productionDocument>;
  delivery: z.output<typeof deliveryDocument>;
};
type Documents = { [P in FlowKind]: FlowDocuments[P] & { kind: P } }[FlowKind];
/** 一张单据的内容带上种类（读的时候从行上的 kind 列来，写的时候不进 JSON），按 kind 区分 */
export type FlowDocument<K extends FlowKind = FlowKind> = Extract<Documents, { kind: K }>;

const contentOf: { [K in FlowKind]: (raw: unknown) => FlowDocuments[K] } = {
  arrival: (raw) => arrivalDocument.parse(raw),
  task: (raw) => taskDocument.parse(raw),
  production: (raw) => productionDocument.parse(raw),
  delivery: (raw) => deliveryDocument.parse(raw),
};

/** 读出来带上种类的结构（种类不在 JSON 里，按行上的 kind 列补上） */
const documentSchemas = {
  arrival: arrivalDocument.transform((c) => ({ ...c, kind: 'arrival' as const })),
  task: taskDocument.transform((c) => ({ ...c, kind: 'task' as const })),
  production: productionDocument.transform((c) => ({ ...c, kind: 'production' as const })),
  delivery: deliveryDocument.transform((c) => ({ ...c, kind: 'delivery' as const })),
};
/**
 * 一种单据库里内容的结构（纯结构，不读库）：核对 document 列解析出来的对象，带上种类。
 * 服务端读库时交给 parseStoredJson（server/core），对不上报服务端错误，不当成“输入不对”。
 */
export function flowDocumentSchema<K extends FlowKind>(kind: K): z.ZodType<FlowDocument<K>>;
export function flowDocumentSchema(kind: FlowKind): z.ZodType<FlowDocument> {
  switch (kind) {
    case 'arrival':
      return documentSchemas.arrival;
    case 'task':
      return documentSchemas.task;
    case 'production':
      return documentSchemas.production;
    case 'delivery':
      return documentSchemas.delivery;
  }
}

/** 库里内容带上种类的结构：输入、输出都是 FlowDocument<K>（种类在对象里，不用 transform 补） */
const contentSchemas = {
  arrival: arrivalDocument.extend({ kind: z.literal('arrival') }),
  task: taskDocument.extend({ kind: z.literal('task') }),
  production: productionDocument.extend({ kind: z.literal('production') }),
  delivery: deliveryDocument.extend({ kind: z.literal('delivery') }),
};
/**
 * 一种单据带种类的内容结构（纯结构）：别的视图里原样带着的单据内容（到货记录的 document，shared/business/flow-views.ts）按它写，
 * `.shape` 取得到每一项（如 reversal、明细的 item）。
 */
export function flowContentSchema<K extends FlowKind>(kind: K): (typeof contentSchemas)[K] {
  return contentSchemas[kind];
}

/** 写单据：按同一份结构核对后的内容（种类不在里面），document 列存它的 JSON 文字 */
export function flowDocumentContent(doc: FlowDocument): FlowDocuments[FlowKind] {
  const { kind, ...content } = doc;
  return contentOf[kind](content);
}

/** 单据行上的列（编号、单号、日期、状态、版本、经手人、时间）和归档标记 */
const flowRow = z.object({
  id: z.number(),
  number: z.string(),
  date: z.string(),
  status: z.string(),
  version: z.number(),
  actorName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type FlowRow = z.output<typeof flowRow>;
/** 生产任务、送货单的实际日：已出库送货单的单据日期；任务是 null（计划日是单据内容，不是派生的） */
const scheduled = { actualDate: z.string().nullable() };
/** 生产任务的完工进度：有没有完工登记（含待入库的）、实际开工和完工日、已入库和待入库数量、百分比（shared/business/task-progress.ts） */
const taskDerived = z.object({
  ...scheduled,
  hasProduction: z.boolean(),
  actualStartDate: z.string().nullable(),
  actualCompletionDate: z.string().nullable(),
  completed: z.string(),
  pendingCompleted: z.string(),
  progress: z.number(),
});
type TaskDerived = z.output<typeof taskDerived>;
type Derived = { arrival: Record<never, never>; task: TaskDerived; production: Record<never, never>; delivery: Pick<TaskDerived, 'actualDate'> };
type Views = { [P in FlowKind]: FlowDocuments[P] & { kind: P } & FlowRow & Derived[P] }[FlowKind];
/** 每种单据都有的：行上的列、种类、确认取消撤销更正的记录（种类还没定的泛型代码里也能直接读） */
type Common<K extends FlowKind> = FlowRow & Pick<FlowDocuments['task'], keyof typeof lifecycle> & { kind: K };
/** 单据视图（server/flow/read.ts 组装，接口和别的模块读到的单据）：单据内容 + 行上的列 + 派生字段，按 kind 区分 */
export type FlowDocView<K extends FlowKind = FlowKind> = Extract<Views, { kind: K }> & Common<K>;

/** 每种单据视图的结构：库里内容 + 种类 + 行上的列 + 派生字段（和上面的类型同一份字段） */
const viewSchemas = {
  arrival: arrivalDocument.extend({ ...flowRow.shape, kind: z.literal('arrival') }),
  task: taskDocument.extend({ ...flowRow.shape, ...taskDerived.shape, kind: z.literal('task') }),
  production: productionDocument.extend({ ...flowRow.shape, kind: z.literal('production') }),
  delivery: deliveryDocument.extend({ ...flowRow.shape, ...scheduled, kind: z.literal('delivery') }),
};
const anyView = z.discriminatedUnion('kind', [viewSchemas.arrival, viewSchemas.task, viewSchemas.production, viewSchemas.delivery]);
/**
 * 单据视图的结构（纯结构）：同一个请求号再交时，按它核对上次存下的结果（server/core 的 onceByRequest）。
 * 给了种类只认这一种，不给是四种任一种。
 */
export function flowViewSchema<K extends FlowKind>(kind: K): z.ZodType<FlowDocView<K>>;
export function flowViewSchema(): z.ZodType<FlowDocView>;
export function flowViewSchema(kind?: FlowKind): z.ZodType<FlowDocView> {
  switch (kind) {
    case 'arrival':
      return viewSchemas.arrival;
    case 'task':
      return viewSchemas.task;
    case 'production':
      return viewSchemas.production;
    case 'delivery':
      return viewSchemas.delivery;
    case undefined:
      return anyView;
  }
}

/** 视图里不是单据内容的字段：行上的列和派生字段（单据日期两边都有，算内容） */
const viewOnly: Record<Exclude<keyof FlowRow | keyof TaskDerived, 'date'>, true> = {
  id: true,
  number: true,
  status: true,
  version: true,
  actorName: true,
  createdAt: true,
  updatedAt: true,
  archived: true,
  actualDate: true,
  hasProduction: true,
  actualStartDate: true,
  actualCompletionDate: true,
  completed: true,
  pendingCompleted: true,
  progress: true,
};
/** 按视图改好的单据取回单据内容：去掉行上的列和派生字段，按库里的单据结构核对（本机管理员连带改单据时用） */
export function flowDocumentOfView(view: FlowDocView): FlowDocument {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) if (key !== 'kind' && !Object.hasOwn(viewOnly, key)) content[key] = value;
  return flowDocumentSchema(view.kind).parse(content);
}
