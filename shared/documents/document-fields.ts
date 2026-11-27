import { fieldLabel } from '../core/index.js';
import type { DocumentKind } from './document-templates.js';

/** 送货单抬头的日期：出库了印送货日期，待送货的印计划送货日期（栏目登记表的叫法） */
export const deliveryDateLabels = {
  shipped: fieldLabel('date', { record: 'delivery' }),
  planned: fieldLabel('plannedDate', { record: 'delivery' }),
} as const;

type DocumentFieldZone = 'number' | 'date' | 'own' | 'info' | 'term';

type DocumentFieldEntry = {
  key: string;
  label: string;
  kinds: readonly DocumentKind[];
  zone: DocumentFieldZone;
  wide?: boolean;
  requiresCompanyAddress?: boolean;
};

type RawFieldDef = {
  key: string;
  label?: string;
  kinds: readonly DocumentKind[];
  zone: DocumentFieldZone;
  /** 模板设置里可勾选隐藏时填展示序号（1 起，保持原勾选顺序不变）；不可隐藏不填 */
  optionalOrder?: number;
  wide?: boolean;
  requiresCompanyAddress?: boolean;
};

/**
 * 采购订货单（purchase）和送货单（delivery）的全部单据字段登记表（抬头单号日期、我方资料、信息格、条款）。
 * key 是 fields 元组的键及模板 hiddenFields 的存储键；label 是纸面和设置页印出来的名字（默认同 key）。
 */
const fieldDefs = {
  purchaseNumber: { key: '采购单号', kinds: ['purchase'], zone: 'number' },
  deliveryNumber: { key: '送货单号', kinds: ['delivery'], zone: 'number' },
  // 订货单是给供应商看的，日期照旧写“下单日期”
  orderDate: { key: '下单日期', kinds: ['purchase'], zone: 'date' },
  shippedDate: { key: deliveryDateLabels.shipped, kinds: ['delivery'], zone: 'date' },
  plannedDate: { key: deliveryDateLabels.planned, kinds: ['delivery'], zone: 'date' },
  supplier: { key: '供应商', kinds: ['purchase'], zone: 'info' },
  supplierContact: { key: '供应商联系信息', kinds: ['purchase'], zone: 'info', optionalOrder: 1 },
  customer: { key: '客户', kinds: ['delivery'], zone: 'info' },
  deliveryAddress: { key: '收货地址', kinds: ['delivery'], zone: 'info', wide: true },
  customerContact: { key: '客户联系信息', kinds: ['delivery'], zone: 'info', optionalOrder: 2 },
  expectedDeliveryDate: { key: '预计交货日期', kinds: ['purchase'], zone: 'info', optionalOrder: 3 },
  companyContact: { key: '我方联系人', kinds: ['purchase', 'delivery'], zone: 'own', optionalOrder: 4 },
  companyAddress: { key: '我方地址', kinds: ['delivery'], zone: 'own' },
  purchaseDeliveryAddress: {
    key: '交货地址',
    kinds: ['purchase'],
    zone: 'info',
    optionalOrder: 5,
    wide: true,
    requiresCompanyAddress: true,
  },
  relatedOrders: { key: '关联销售订单', kinds: ['delivery'], zone: 'info', optionalOrder: 7 },
  customerOrderNumber: {
    // 信息格的键（document_template_settings 里存着，不能改），印出来换成栏目登记表的叫法“客户采购单号”
    key: '客户采购订单号',
    label: fieldLabel('externalPurchaseOrder'),
    kinds: ['delivery'],
    zone: 'info',
    optionalOrder: 6,
  },
  // 交货安排、对应采购单是合并订货单才有的，内容长短不定，放在明细后面的条款区（高度跟着内容走）
  deliverySchedule: { key: '交货安排', kinds: ['purchase'], zone: 'term' },
  relatedPurchases: { key: '对应采购单', kinds: ['purchase'], zone: 'term' },
  deliveryTerms: { key: '交货要求', kinds: ['purchase'], zone: 'term', optionalOrder: 8 },
  acceptanceTerms: { key: '验收要求', kinds: ['purchase'], zone: 'term', optionalOrder: 9 },
  paymentTerms: { key: '付款条件', kinds: ['purchase'], zone: 'term', optionalOrder: 10 },
  taxTerms: { key: '税费说明', kinds: ['purchase'], zone: 'term', optionalOrder: 11 },
} as const satisfies Record<string, RawFieldDef>;

export type DocumentFieldId = keyof typeof fieldDefs;
type RawEntry = (typeof fieldDefs)[DocumentFieldId];
type OptionalRawEntry = Extract<RawEntry, { optionalOrder: number }>;
type OptionalDocumentFieldKey = OptionalRawEntry['key'];

export const documentFields: readonly DocumentFieldEntry[] = Object.values(fieldDefs).map((f) => ({
  key: f.key,
  label: 'label' in f ? f.label : f.key,
  kinds: f.kinds,
  zone: f.zone,
  ...('wide' in f ? { wide: f.wide } : {}),
  ...('requiresCompanyAddress' in f ? { requiresCompanyAddress: f.requiresCompanyAddress } : {}),
}));

const isOptional = (f: RawEntry): f is OptionalRawEntry => 'optionalOrder' in f;
/** 模板里可勾选隐藏的单据字段（由登记表 optionalOrder 按原顺序派生）。 */
export const optionalDocumentFields: readonly OptionalDocumentFieldKey[] = Object.values(fieldDefs)
  .filter(isOptional)
  .sort((a, b) => a.optionalOrder - b.optionalOrder)
  .map((f) => f.key);

const keysOfZone = (zone: DocumentFieldZone): readonly string[] =>
  documentFields.filter((f) => f.zone === zone).map((f) => f.key);

export const numberKeys = keysOfZone('number'),
  dateKeys = keysOfZone('date'),
  ownKeys = keysOfZone('own'),
  termKeys = keysOfZone('term'),
  wideKeys: readonly string[] = documentFields.filter((f) => f.wide).map((f) => f.key);

/** 按登记表标识构造一条单据字段 [key, value]，避免各处手写裸字符串键。 */
export const docField = (id: DocumentFieldId, value: string): [string, string] => [
  fieldDefs[id].key,
  value,
];
