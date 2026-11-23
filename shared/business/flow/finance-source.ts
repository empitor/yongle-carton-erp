import { z } from 'zod';
import { isRecord, type FinanceSourceKind } from '../../core/index.js';
import { flowContentSchema, type FlowDocuments } from './flow-document.js';
import { documentInfoSchema } from './flow-requests.js';

/*
 * 单据和财务之间的约定，归业务管：财务读到的单据长什么样（财务口径），单据的每个栏目算不算进财务的来源指纹。
 * 业务改单据结构（shared/business/flow/flow-document.ts）时在这里当场编译报错，财务代码不跟着改。
 *
 * - 财务口径（financeSourceSchemas）：送货、到货、完工单和盘点流水里财务点名读的几项，每项的结构从业务的严格结构里取。
 *   财务事件快照的 doc 只存它（加上单号），读快照、生成凭证、“改了什么”、成本和发票都只读这几项。
 * - 栏目归类（financeFieldClasses）：单据每一层（表头、明细、到货明细的纸板资料、完工领料）的每个栏目都归一类，
 *   业务多一个栏目缺键、改名多键，都编译不过。归“说明”的是“编辑”能改的说明和备注（documentInfoFields 从这里取），改了不动财务。
 * - 算进来源指纹的内容（fingerprintRules、financeFingerprint）：归“算”的栏目，按财务口径的名字取出来。
 *   改名表的键是业务的栏目名、值是财务口径的名字，键必须正好是归类表里归“算”的那些（多了、少了都编译不过）；
 *   业务改栏目名只改这张表的键，财务口径的名字不变，库里存的来源指纹也不变。
 */

const delivery = flowContentSchema('delivery').shape;
const deliveryLine = delivery.lines.element.shape;
const arrival = flowContentSchema('arrival').shape;
const arrivalLine = arrival.lines.element.shape;
const arrivalItem = arrivalLine.item.shape;
const production = flowContentSchema('production').shape;

/**
 * 每种来源的财务口径。库里的单据已经补过默认值，这里取业务结构时去掉默认值（unwrap）：
 * 快照不记种类，读快照时四种合在一起读（server/finance/source-snapshot.ts），补了默认值别的种类会多出不相干的项。
 * 盘点流水没有单据，是库存流水的几项拼成的（server/flow/finance-facts/sources.ts 的 texts）。
 */
export const financeSourceSchemas = {
  delivery: z.object({
    confirmedAt: delivery.confirmedAt,
    customerId: delivery.customerId,
    customerName: delivery.customerName,
    correctionOf: delivery.correctionOf,
    replacedBy: delivery.replacedBy,
    lines: z.array(
      z.object({
        quantity: deliveryLine.quantity,
        unit: deliveryLine.unit,
        productName: deliveryLine.productName,
        unitPriceExact: deliveryLine.unitPriceExact,
        taxMode: deliveryLine.taxMode,
        taxRate: deliveryLine.taxRate,
        stockId: deliveryLine.stockId,
        orderId: deliveryLine.orderId,
        orderLineId: deliveryLine.orderLineId,
        orderNumber: deliveryLine.orderNumber,
        productId: deliveryLine.productId,
      }),
    ),
  }),
  arrival: z.object({
    reference: arrival.reference.unwrap(),
    confirmedAt: arrival.confirmedAt,
    supplierId: arrival.supplierId,
    supplierName: arrival.supplierName,
    correctionOf: arrival.correctionOf,
    correctionOfReceiptId: arrival.correctionOfReceiptId,
    replacedBy: arrival.replacedBy,
    lines: z.array(
      z.object({
        quantity: arrivalLine.quantity,
        unitPrice: arrivalLine.unitPrice.unwrap(),
        priceBasis: arrivalLine.priceBasis.unwrap(),
        stockId: arrivalLine.stockId.unwrap(),
        purchaseLineId: arrivalLine.purchaseLineId.unwrap(),
        purchaseId: arrivalLine.purchaseId,
        purchaseNumber: arrivalLine.purchaseNumber,
        stockedQuantity: arrivalLine.stockedQuantity,
        acceptedQuantity: arrivalLine.acceptedQuantity,
        item: z.object({
          name: arrivalItem.name,
          unit: arrivalItem.unit.unwrap(),
          length: arrivalItem.length,
          width: arrivalItem.width,
          dimensionUnit: arrivalItem.dimensionUnit.unwrap(),
        }),
      }),
    ),
  }),
  production: z.object({
    confirmedAt: production.confirmedAt,
    correctionOf: production.correctionOf,
    replacedBy: production.replacedBy,
  }),
  stock: z.object({ stockId: z.number(), deltaUnits: z.number(), reason: z.string().nullable(), createdAt: z.string() }),
} satisfies Record<FinanceSourceKind, z.ZodType>;
/** 一种来源的财务口径 */
export type FinanceSource<K extends FinanceSourceKind = FinanceSourceKind> = z.output<(typeof financeSourceSchemas)[K]>;
/** 业务交给财务的完整内容：单据是库里的内容（不带种类），盘点流水是拼出来的那几项 */
type BusinessContents = Pick<FlowDocuments, 'delivery' | 'arrival' | 'production'> & { stock: FinanceSource<'stock'> };

const pickers: { [K in FinanceSourceKind]: (content: BusinessContents[K]) => FinanceSource<K> } = {
  delivery: (content) => financeSourceSchemas.delivery.parse(content),
  arrival: (content) => financeSourceSchemas.arrival.parse(content),
  production: (content) => financeSourceSchemas.production.parse(content),
  stock: (content) => financeSourceSchemas.stock.parse(content),
};
/** 业务的完整内容转成财务口径：只留财务点名的几项 */
export const toFinanceSource = <K extends FinanceSourceKind>(kind: K, content: BusinessContents[K]): FinanceSource<K> =>
  pickers[kind](content);

/** 栏目归类：count 算进来源指纹；info 是说明（“编辑”能改的说明和备注），skip 是别的不算的 */
type FieldClass = 'count' | 'info' | 'skip';
/** 一层的归类：每个栏目一个，不多不少 */
type Classes<T> = { readonly [K in keyof Required<T>]: FieldClass };
/** 说明编辑能改的栏目（POST /flow/:id/info 的输入，版本号以外的那几项） */
type InfoField = Exclude<keyof z.input<typeof documentInfoSchema>, 'expectedVersion'>;
/** 单据表头的归类：归“说明”的只能是说明编辑能改的栏目 */
type DocClasses<T> = { readonly [K in keyof Required<T>]: K extends InfoField ? FieldClass : Exclude<FieldClass, 'info'> };
type Line<K extends 'delivery' | 'arrival'> = FlowDocuments[K]['lines'][number];

/**
 * 每种来源每一层栏目的归类（直接列键，不用展开：展开的对象里多出来的键编译时查不出）。不算的理由：
 * - 单据日期（date）和单据表的日期列一样，指纹另从列取；状态也从列取（撤销、取消记录不算）。
 * - 确认、取消、撤销、更正记录：确认时间（决定收入确认口径）和更正、替代关系算，别的只记人、原因、时刻、流水编号。
 * - 计划日、计划时间（进财务的都是已确认单据）；对方单号（reference：财务的单号按单据表的单号列补）。
 * - 经办记录：出库的人和时刻（日期就是单据日期），送达（出库就记收入，送达不改金额、往来和日期），超量送货的批准和原因。
 * - 别处的编号：原始文件、订货批次（批次删掉时会从单据里去掉）、完工单挂的生产任务和产品名（成本按流水算）。
 * - 抄来的资料：送货明细里抄的订单资料（财务按订单、订单明细、产品编号认）、产品尺寸材质楞型（只印在送货单上）、
 *   按数量和单价算出来的金额（财务自己算）；到货明细里对方单据写的原文数量面积、不合格数、差异原因、
 *   按实收算的面积金额、抄的采购单和供应商名（财务按采购明细认、往来单位按表头）。纸板资料只算品名、单位和长宽。
 * 完工单的产品、成品库存、良品和报废数量、领料都算：它们决定库存流水，月末成本按流水算。
 */
export const financeFieldClasses = {
  delivery: {
    doc: {
      notes: 'info', address: 'info', contact: 'info', phone: 'info', actualTime: 'info',
      customerId: 'count', customerName: 'count', lines: 'count', confirmedAt: 'count', correctionOf: 'count', replacedBy: 'count',
      date: 'skip', plannedDate: 'skip', plannedTime: 'skip', allowOverdelivery: 'skip', overdeliveryReason: 'skip',
      confirmedBy: 'skip', movements: 'skip', cancellation: 'skip', reversal: 'skip', correctionReason: 'skip', correctedAt: 'skip',
      shippedAt: 'skip', shippedBy: 'skip', deliveredAt: 'skip', deliveredBy: 'skip',
    },
    lines: {
      orderId: 'count', orderLineId: 'count', stockId: 'count', quantity: 'count', productId: 'count', productName: 'count',
      unit: 'count', unitPriceExact: 'count', taxRate: 'count', taxMode: 'count', notes: 'info', amountExact: 'skip',
      specification: 'skip', orderNumber: 'skip', externalPurchaseOrder: 'skip', customerProductCode: 'skip',
      length: 'skip', width: 'skip', height: 'skip', dimensionUnit: 'skip', material: 'skip', flute: 'skip',
    },
  },
  arrival: {
    doc: {
      notes: 'info', actualTime: 'info',
      supplierId: 'count', supplierName: 'count', lines: 'count', correctionOfReceiptId: 'count',
      confirmedAt: 'count', correctionOf: 'count', replacedBy: 'count',
      date: 'skip', reference: 'skip', sourceId: 'skip', orderBatchId: 'skip',
      confirmedBy: 'skip', movements: 'skip', cancellation: 'skip', reversal: 'skip', correctionReason: 'skip', correctedAt: 'skip',
    },
    lines: {
      stockId: 'count', purchaseLineId: 'count', item: 'count', quantity: 'count', acceptedQuantity: 'count',
      stockedQuantity: 'count', unitPrice: 'count', priceBasis: 'count', rejectedQuantity: 'skip', statedQuantity: 'skip',
      statedArea: 'skip', differenceReason: 'skip', area: 'skip', amount: 'skip',
      purchaseId: 'skip', purchaseNumber: 'skip', supplierName: 'skip',
    },
    item: {
      name: 'count', unit: 'count', length: 'count', width: 'count', dimensionUnit: 'count', notes: 'info',
      specification: 'skip', height: 'skip', material: 'skip', flute: 'skip',
    },
  },
  production: {
    doc: {
      notes: 'info', operator: 'info',
      productId: 'count', finishedStockId: 'count', goodQuantity: 'count', scrapQuantity: 'count', materials: 'count',
      confirmedAt: 'count', correctionOf: 'count', replacedBy: 'count',
      date: 'skip', taskId: 'skip', productName: 'skip',
      confirmedBy: 'skip', movements: 'skip', cancellation: 'skip', reversal: 'skip', correctionReason: 'skip', correctedAt: 'skip',
    },
    materials: { stockId: 'count', issued: 'count', returned: 'count' },
  },
  stock: { doc: { stockId: 'count', deltaUnits: 'count', createdAt: 'count', reason: 'info' } },
} as const satisfies {
  delivery: { doc: DocClasses<FlowDocuments['delivery']>; lines: Classes<Line<'delivery'>> };
  arrival: { doc: DocClasses<FlowDocuments['arrival']>; lines: Classes<Line<'arrival'>>; item: Classes<Line<'arrival'>['item']> };
  production: { doc: DocClasses<FlowDocuments['production']>; materials: Classes<FlowDocuments['production']['materials'][number]> };
  stock: { doc: Classes<FinanceSource<'stock'>> };
};

type Layer = Readonly<Record<string, FieldClass>>;
const keysWhere = (layer: Layer, keep: (c: FieldClass) => boolean) => Object.keys(layer).filter((key) => keep(layer[key]));

const isInfoField = (key: string): key is InfoField => key !== 'expectedVersion' && Object.hasOwn(documentInfoSchema.shape, key);
const infoFieldsOf = (layer: Layer) => keysWhere(layer, (c) => c === 'info').filter(isInfoField);
/** 每种已生效单据能改的说明字段：表头归“说明”的那些（说明编辑和数据管理按它判断一次修改是不是只改说明） */
export const documentInfoFields = {
  arrival: infoFieldsOf(financeFieldClasses.arrival.doc),
  delivery: infoFieldsOf(financeFieldClasses.delivery.doc),
  production: infoFieldsOf(financeFieldClasses.production.doc),
};

/** 一层归“算”的栏目的改名表：键是业务的栏目名（正好是归类表这一层归“算”的那些，多了少了都编译不过），值是财务口径的名字 */
type Counted<C> = { readonly [K in keyof C as C[K] extends 'count' ? K : never]: string };
/** 算进指纹的一层：改名表，和这一层里还要往下取一层的栏目（一组明细、纸板资料、领料；键是业务的栏目名） */
type FingerprintLayer = { names: Readonly<Record<string, string>>; nested?: Readonly<Record<string, FingerprintLayer>> };
const classes = financeFieldClasses;
/** 各层的改名表（直接列键，不用展开：展开进来的键多了少了编译时查不出） */
const names = {
  deliveryDoc: {
    customerId: 'customerId', customerName: 'customerName', lines: 'lines',
    confirmedAt: 'confirmedAt', correctionOf: 'correctionOf', replacedBy: 'replacedBy',
  },
  deliveryLine: {
    orderId: 'orderId', orderLineId: 'orderLineId', stockId: 'stockId', quantity: 'quantity', productId: 'productId',
    productName: 'productName', unit: 'unit', unitPriceExact: 'unitPriceExact', taxRate: 'taxRate', taxMode: 'taxMode',
  },
  arrivalDoc: {
    supplierId: 'supplierId', supplierName: 'supplierName', lines: 'lines', correctionOfReceiptId: 'correctionOfReceiptId',
    confirmedAt: 'confirmedAt', correctionOf: 'correctionOf', replacedBy: 'replacedBy',
  },
  arrivalLine: {
    stockId: 'stockId', purchaseLineId: 'purchaseLineId', item: 'item', quantity: 'quantity', acceptedQuantity: 'acceptedQuantity',
    stockedQuantity: 'stockedQuantity', unitPrice: 'unitPrice', priceBasis: 'priceBasis',
  },
  arrivalItem: { name: 'name', unit: 'unit', length: 'length', width: 'width', dimensionUnit: 'dimensionUnit' },
  productionDoc: {
    productId: 'productId', finishedStockId: 'finishedStockId', goodQuantity: 'goodQuantity', scrapQuantity: 'scrapQuantity',
    materials: 'materials', confirmedAt: 'confirmedAt', correctionOf: 'correctionOf', replacedBy: 'replacedBy',
  },
  material: { stockId: 'stockId', issued: 'issued', returned: 'returned' },
  stock: { stockId: 'stockId', deltaUnits: 'deltaUnits', createdAt: 'createdAt' },
} satisfies {
  deliveryDoc: Counted<typeof classes.delivery.doc>;
  deliveryLine: Counted<typeof classes.delivery.lines>;
  arrivalDoc: Counted<typeof classes.arrival.doc>;
  arrivalLine: Counted<typeof classes.arrival.lines>;
  arrivalItem: Counted<typeof classes.arrival.item>;
  productionDoc: Counted<typeof classes.production.doc>;
  material: Counted<typeof classes.production.materials>;
  stock: Counted<typeof classes.stock.doc>;
};

/**
 * 一层里要往下取一层的栏目（一组明细、纸板资料、领料）：归“算”、业务结构里的值是一组对象或一个对象的那些，
 * 键是业务的栏目名。必须正好写这几个：业务改了外层栏目名、新加了这种栏目，少写、多写都编译不过；没有的层写 {}。
 */
type Nested<T, C> = OnlyKeys<{
  readonly [K in keyof C & keyof T as C[K] extends 'count' ? (NonNullable<T[K]> extends object ? K : never) : never]: FingerprintLayer;
}>;
/** 一个键都没有的层写成 Record<string, never>：空对象类型 {} 什么键都收，多写了查不出 */
type OnlyKeys<N> = keyof N extends never ? Readonly<Record<string, never>> : N;
type Delivery = FlowDocuments['delivery'];
type Arrival = FlowDocuments['arrival'];
type Production = FlowDocuments['production'];

/**
 * 算进来源指纹的内容怎么从业务内容里取：每种来源一层层的改名表（names）和往下的层（nested）。层的位置只在这里写
 * （tests/finance-source-contract.test.ts 按它找归类表的每一层）。现在财务口径的名字和业务一样；业务改了栏目名
 * （含 lines 这种外层栏目），归类表、改名表、往下的层的键跟着改（不改编译不过），值（财务口径的名字）不动，库里的指纹就不变。
 */
export const fingerprintRules = {
  delivery: {
    names: names.deliveryDoc,
    nested: {
      lines: { names: names.deliveryLine, nested: {} satisfies Nested<Line<'delivery'>, typeof classes.delivery.lines> },
    } satisfies Nested<Delivery, typeof classes.delivery.doc>,
  },
  arrival: {
    names: names.arrivalDoc,
    nested: {
      lines: {
        names: names.arrivalLine,
        nested: {
          item: { names: names.arrivalItem, nested: {} satisfies Nested<Line<'arrival'>['item'], typeof classes.arrival.item> },
        } satisfies Nested<Line<'arrival'>, typeof classes.arrival.lines>,
      },
    } satisfies Nested<Arrival, typeof classes.arrival.doc>,
  },
  production: {
    names: names.productionDoc,
    nested: {
      materials: { names: names.material, nested: {} satisfies Nested<Production['materials'][number], typeof classes.production.materials> },
    } satisfies Nested<Production, typeof classes.production.doc>,
  },
  stock: { names: names.stock, nested: {} satisfies Nested<FinanceSource<'stock'>, typeof classes.stock.doc> },
} satisfies Record<FinanceSourceKind, FingerprintLayer>;

/**
 * 按一层改名表取内容：只留表里的栏目（没有的、undefined 的不留），换成财务口径的名字，往下一层的照样取；
 * 键按名字排好（单据整份重写时键的先后会变，内容一样指纹就该一样）。
 */
export function fingerprintOf(layer: FingerprintLayer, content: unknown): unknown {
  if (!isRecord(content)) return content;
  const out: [string, unknown][] = [];
  for (const [key, name] of Object.entries(layer.names)) {
    const value = content[key],
      inner = layer.nested?.[key];
    if (value === undefined) continue;
    out.push([name, !inner ? value : Array.isArray(value) ? value.map((v: unknown) => fingerprintOf(inner, v)) : fingerprintOf(inner, value)]);
  }
  return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * 算进来源指纹的内容：业务的完整内容（单据不带种类，盘点流水是拼出来的那几项）里归“算”的栏目，按财务口径的名字取。
 * 窗口（server/flow/finance-facts/sources.ts 的 read）交给财务，财务按它算 sha256（server/finance/source-fingerprint.ts）。
 */
export const financeFingerprint = (kind: FinanceSourceKind, content: unknown) => fingerprintOf(fingerprintRules[kind], content);
