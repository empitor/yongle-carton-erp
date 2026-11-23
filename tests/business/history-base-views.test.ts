// 库存品、采购单的审计改记采购库存的基本视图（不带已安排、可用、到货记录、到货金额）以后，修改历史显示的变化和原来一样：
// 旧审计（完整视图）对新审计（基本视图）、旧对旧、新对新，列出来的几行都相同，不多出、不少掉这几项。纯数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyView } from '../../shared/business/index.js';

const at = '2026-10-01T00:00:00.000Z';
/** 库存品的基本视图（采购库存现在记进审计的样子） */
const stockBase = (notes: string, version: number) => ({
  specification: '',
  length: 1200,
  width: 800,
  height: null,
  dimensionUnit: 'mm',
  material: 'K=K',
  flute: 'BC',
  notes,
  id: 7,
  name: '虚构纸板',
  kind: 'raw',
  unit: '张',
  productId: null,
  version,
  createdAt: at,
  updatedAt: at,
  quantity: '30',
  balanceUnits: 30000,
  onOrderUnits: 1000,
  onOrder: '1',
  archived: false,
});
/** 以前记进审计的完整视图：多了已安排、可用 */
const stockFull = (notes: string, version: number) => ({ ...stockBase(notes, version), reservedUnits: 5000, reserved: '5', availableUnits: 25000 });

const line = (receivedUnits: number) => ({
  name: '虚构纸板',
  unit: '张',
  specification: '',
  length: 1200,
  width: 800,
  height: null,
  dimensionUnit: 'mm',
  material: 'K=K',
  flute: 'BC',
  notes: '',
  unitPrice: '2.0000',
  priceBasis: 'quantity',
  id: 11,
  stockItemId: 7,
  customerOrderId: null,
  quantity: '10',
  receivedQuantity: String(receivedUnits / 1000),
  remainingQuantity: String(10 - receivedUnits / 1000),
  remainingUnits: 10000 - receivedUnits,
  arrivalStatus: receivedUnits ? '部分到货' : '未到货',
  quantityUnits: 10000,
  receivedUnits,
  customerOrderNumber: '',
  amount: '20.00',
});
/** 采购单的基本视图 */
const purchaseBase = (notes: string, version: number) => ({
  id: 3,
  number: 'CG-20261001-0003',
  supplierId: 2,
  supplierName: '虚构纸业',
  customerOrderId: null,
  orderDate: '2026-10-01',
  expectedDate: null,
  baseStatus: '已订货',
  notes,
  version,
  createdAt: at,
  updatedAt: at,
  businessStatus: '已订货',
  arrivalProgress: '部分到货',
  arrivalSummary: { progress: '部分到货', completedLines: 0, totalLines: 1 },
  status: '部分到货',
  customerOrderNumber: '',
  orderIds: [],
  customerOrders: [],
  totalAmount: '20.00',
  archived: false,
  lines: [line(4000)],
});
/** 以前记进审计的完整视图：每行和整张多了到货金额，多了到货记录 */
const purchaseFull = (notes: string, version: number) => {
  const base = purchaseBase(notes, version);
  return {
    ...base,
    lines: base.lines.map((l) => ({ ...l, receivedAmount: '8.00' })),
    receivedAmount: '8.00',
    receipts: [{ id: 'flow-5', flowId: 5, number: 'DH-20261005-00005', effective: true, items: [], correctionLines: [], amount: '8.00' }],
  };
};

const shown = (module: string, action: string, before: unknown, after: unknown) =>
  historyView({ module, action, detail: { before, after }, recordId: 7 });

test('库存品的修改历史：旧审计（带已安排、可用）对新审计，列出来的和新对新一样，不多出这几项', () => {
  const expected = shown('stock_items', 'update', stockBase('旧备注', 1), stockBase('新备注', 2));
  assert.ok(expected.items.length > 0, '改了备注要列出来');
  assert.deepEqual(shown('stock_items', 'update', stockFull('旧备注', 1), stockBase('新备注', 2)), expected);
  assert.deepEqual(shown('stock_items', 'update', stockFull('旧备注', 1), stockFull('新备注', 2)), expected);
  assert.deepEqual(shown('stock_items', 'create', null, stockFull('新备注', 1)), shown('stock_items', 'create', null, stockBase('新备注', 1)));
});

test('采购单的修改历史：旧审计（带到货记录、到货金额）对新审计，列出来的和新对新一样，不多出这几项', () => {
  const expected = shown('purchases', 'update', purchaseBase('旧备注', 1), purchaseBase('新备注', 2));
  assert.ok(expected.items.length > 0, '改了备注要列出来');
  assert.deepEqual(shown('purchases', 'update', purchaseFull('旧备注', 1), purchaseBase('新备注', 2)), expected);
  assert.deepEqual(shown('purchases', 'update', purchaseFull('旧备注', 1), purchaseFull('新备注', 2)), expected);
  assert.deepEqual(shown('purchases', 'create', null, purchaseFull('新备注', 1)), shown('purchases', 'create', null, purchaseBase('新备注', 1)));
});
