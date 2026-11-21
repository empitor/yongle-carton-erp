// 财务来源指纹用的几张虚构单据（送货、到货、完工、盘点流水，每种一张只有必填项、一张把说明和不算的栏目都填上），
// 内容是业务交给库里的单据内容（不带种类）。指纹底数（source-fingerprint-pinned）、约定（finance-source-contract）、
// 改名不影响指纹（finance-fingerprint-rename）几条测试共用，都先走正式的读法（storedContent：按库里的单据结构解析，
// 会补默认值，和窗口 sources.read 同一个结构）再算。全部虚构。
import { financeSourceSchemas, flowDocumentSchema } from '../shared/business/index.js';

const lifecycle = {
  confirmedBy: '虚构确认人',
  confirmedAt: '2026-03-05T08:00:00.000Z',
  movements: ['虚构流水-1', '虚构流水-2'],
  cancellation: { reason: '虚构取消原因', by: '虚构取消人', at: '2026-03-06T08:00:00.000Z' },
  reversal: { reason: '虚构撤销原因', by: '虚构撤销人', at: '2026-03-07T08:00:00.000Z', requestId: '虚构请求号', movements: ['虚构冲回流水'] },
  correctionOf: 11,
  correctionReason: '虚构更正原因',
  correctedAt: '2026-03-08T08:00:00.000Z',
  replacedBy: 12,
};

export const deliveryMinimal = {
  date: '2026-03-05',
  plannedDate: '2026-03-04',
  customerId: 3,
  lines: [{ orderId: 4, orderLineId: 5, stockId: 6, quantity: '120' }],
};
export const deliveryFull = {
  ...deliveryMinimal,
  notes: '虚构单据备注',
  plannedTime: '09:00',
  actualTime: '10:30',
  address: '虚构收货地址',
  contact: '虚构联系人',
  phone: '000-0000',
  allowOverdelivery: true,
  overdeliveryReason: '虚构超送原因',
  lines: [
    {
      orderId: 4,
      orderLineId: 5,
      stockId: 6,
      quantity: '120',
      notes: '虚构明细备注',
      productName: '虚构纸箱',
      specification: '虚构规格',
      unit: '只',
      orderNumber: 'XS-虚构-1',
      externalPurchaseOrder: 'PO-虚构-1',
      customerProductCode: 'KH-虚构-1',
      unitPriceExact: '1.2500',
      amountExact: '150.0000000',
      taxRate: '13',
      taxMode: '含税',
      productId: 7,
      length: 300,
      width: 200,
      height: 150,
      dimensionUnit: 'mm',
      material: 'K=A',
      flute: 'BC',
    },
    { orderId: 4, orderLineId: 8, stockId: 6, quantity: '0.5', notes: '', productName: '虚构纸箱乙', unit: '只', unitPriceExact: '2' },
  ],
  ...lifecycle,
  customerName: '虚构客户',
  shippedAt: '2026-03-05T09:00:00.000Z',
  shippedBy: '虚构出库人',
  deliveredAt: '2026-03-06',
  deliveredBy: '虚构送达人',
};

const board = { name: '虚构纸板', unit: '张', length: 1200, width: 800, dimensionUnit: 'mm' };
export const arrivalMinimal = {
  date: '2026-03-02',
  supplierId: 9,
  reference: 'SH-虚构-1',
  lines: [{ item: { name: '虚构纸板' }, quantity: '500' }],
};
export const arrivalFull = {
  ...arrivalMinimal,
  notes: '虚构到货备注',
  actualTime: '14:00',
  sourceId: '00000000-0000-4000-8000-000000000001',
  orderBatchId: 10,
  lines: [
    {
      stockId: 13,
      purchaseLineId: 14,
      item: { ...board, specification: '虚构纸板规格', height: null, material: '虚构材质', flute: 'B', notes: '虚构纸板备注' },
      quantity: '500',
      acceptedQuantity: '498',
      rejectedQuantity: '2',
      stockedQuantity: '498',
      statedQuantity: '500',
      unitPrice: '2.3500',
      priceBasis: 'area',
      statedArea: '480',
      differenceReason: '虚构差异原因',
      area: '478.08',
      amount: '1123.4880',
      purchaseId: 15,
      purchaseNumber: 'CG-虚构-1',
      supplierName: '虚构供应商',
    },
    { stockId: null, purchaseLineId: null, item: { name: '虚构纸板乙', unit: '张' }, quantity: '0', unitPrice: null, priceBasis: null },
  ],
  ...lifecycle,
  supplierName: '虚构供应商',
  correctionOfReceiptId: 'flow-11',
};

export const productionMinimal = {
  date: '2026-03-03',
  productId: 16,
  goodQuantity: '1000',
  operator: '虚构机长',
  materials: [{ stockId: 13, issued: '200' }],
};
export const productionFull = {
  ...productionMinimal,
  notes: '虚构批次备注',
  taskId: 17,
  finishedStockId: 18,
  scrapQuantity: '12',
  materials: [
    { stockId: 13, issued: '200', returned: '3' },
    { stockId: 19, issued: '50', returned: '0' },
  ],
  ...lifecycle,
  productName: '虚构纸箱',
};

export const stockMinimal = { stockId: 20, deltaUnits: -2000, reason: null, createdAt: '2026-03-09T08:00:00.000Z' };
export const stockFull = { ...stockMinimal, deltaUnits: 1500, reason: '虚构盘点备注' };

/**
 * 正式的读法：按库里的单据结构解析（窗口 server/flow/finance-facts/sources.ts 的 read 用的同一个结构，会补默认值），
 * 单据去掉种类，盘点流水按拼出来的那几项读。算指纹的测试都先过这一步，样张写得不全时也和正式取法一样。
 */
export function storedContent(kind: 'delivery' | 'arrival' | 'production' | 'stock', doc: unknown): Record<string, unknown> {
  if (kind === 'stock') return financeSourceSchemas.stock.parse(doc);
  const { kind: _kind, ...content } = flowDocumentSchema(kind).parse(doc);
  return content;
}
