// 财务来源指纹的底数不许变：库里每条财务事件都存着当时算的指纹（fin_events.source_hash），指纹的算法、算进去的栏目、
// 栏目的顺序变了，已有的事件就会全部被当成“来源改过”。这里用几张固定的虚构单据（送货、到货、完工、盘点流水，
// 每种一张只有必填项、一张把说明和不算的栏目都填上）算指纹，和写死的 sha256 比。纯函数、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceHash } from '../server/finance/source-fingerprint.js';

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

const deliveryMinimal = {
  date: '2026-03-05',
  plannedDate: '2026-03-04',
  customerId: 3,
  lines: [{ orderId: 4, orderLineId: 5, stockId: 6, quantity: '120' }],
};
const deliveryFull = {
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
const arrivalMinimal = {
  date: '2026-03-02',
  supplierId: 9,
  reference: 'SH-虚构-1',
  lines: [{ item: { name: '虚构纸板' }, quantity: '500' }],
};
const arrivalFull = {
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

const productionMinimal = {
  date: '2026-03-03',
  productId: 16,
  goodQuantity: '1000',
  operator: '虚构机长',
  materials: [{ stockId: 13, issued: '200' }],
};
const productionFull = {
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

const stockMinimal = { stockId: 20, deltaUnits: -2000, reason: null, createdAt: '2026-03-09T08:00:00.000Z' };
const stockFull = { ...stockMinimal, deltaUnits: 1500, reason: '虚构盘点备注' };

/** 每张虚构单据：种类、状态、单据日期、内容，和搬家前用当时的代码算出的指纹 */
const pinned = [
  ['送货·只有必填项', 'delivery', 'confirmed', '2026-03-05', deliveryMinimal, '7f7ff6ecd5e1e8bd2fae6aef265cb35ef5602896fd9fdf1f2d77f59e6eb4c885'],
  ['送货·全填', 'delivery', 'reversed', '2026-03-05', deliveryFull, '048c9c2012152b4c2b991db6b25103ac470a56ec2212ef0e43ab45395e42c9fd'],
  ['到货·只有必填项', 'arrival', 'confirmed', '2026-03-02', arrivalMinimal, '785682f41301f3be328ff6dd490730b928b94954d437c1b764253ae58f2d2ab5'],
  ['到货·全填', 'arrival', 'confirmed', '2026-03-02', arrivalFull, 'fae2b7c4ec16736c0246157b82696f28c46df7b76c47b20747aa4f7f9f2755b2'],
  ['完工·只有必填项', 'production', 'confirmed', '2026-03-03', productionMinimal, '4d26580a9e85bfcdcf5e288cc40812aeccd89abb2ba0f3034593b1b1dd0c8def'],
  ['完工·全填', 'production', 'reversed', '2026-03-03', productionFull, 'f4bc55cdc68feab963827ee6d8559b05a171a10dfe63c117beb85bb3b4c41d46'],
  ['盘点流水·只有必填项', 'stock', 'confirmed', '2026-03-09', stockMinimal, 'e07a641a1c7392d2dfc96a72ec55b251f66164d6127c7d2f8bd4d6aab3412c34'],
  ['盘点流水·全填', 'stock', 'confirmed', '2026-03-09', stockFull, '388b6926748048365faf07a29aa0f869051b5e2ff21e1528a0fc2fcd89e8cdd2'],
] as const;

test('固定的虚构单据算出的财务来源指纹和写死的一样（库里已有的指纹不变）', () => {
  const hashes = (pick: (row: (typeof pinned)[number]) => string) => Object.fromEntries(pinned.map((row) => [row[0], pick(row)]));
  assert.deepEqual(
    hashes(([, kind, status, date, doc]) => sourceHash({ kind, status, date }, doc)),
    hashes((row) => row[5]),
  );
});
