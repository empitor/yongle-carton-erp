import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { receiptEvents } from '../server/operations/fulfillment.js';
import { FlowService } from '../server/flow/service.js';
import { actor } from './assistant-fixture.js';

function fixture(lineQuantities: string[], movements: number[], known?: string) {
  const store = new Store(':memory:'), ops = new OperationsService(store);
  const supplier = ops.saveSupplier({ name: '虚构旧供应商' }, actor);
  const item = ops.saveItem({ name: '虚构旧物料', kind: 'raw', unit: '张' }, actor);
  const purchase = ops.savePurchase({ supplierId: supplier.id, status: '已订货', orderDate: '2026-11-01',
    lines: [{ stockItemId: item.id, name: item.name, unit: '张', quantity: '100' }],
  }, actor);
  const receiptId = randomUUID(), lineId = purchase.lines[0].id;
  const items = lineQuantities.map((quantity, index) => ({ stockId: item.id, lineId, quantity,
    item: { name: item.name, unit: '张' }, ...(index === 0 && known ? { stockedQuantity: known } : {}),
  }));
  store.db.prepare('INSERT INTO purchase_receipts VALUES(?,?,?,?,?,?,?,?)').run(
    receiptId, purchase.id, '虚构旧单', '2026-11-07', JSON.stringify({ items }), actor.id, actor.name, '2026-11-07T00:00:00Z',
  );
  let balance = 0;
  for (const units of movements) {
    store.db.prepare('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      randomUUID(), item.id, 'purchase', units, balance, balance + units, 'purchase_receipt', receiptId,
      lineId, null, '2026-11-07', '虚构旧到货', actor.id, actor.name, '2026-11-07T00:00:00Z',
    );
    balance += units;
  }
  return { store, quantities: () => receiptEvents(store).find((e) => e.id === receiptId)!.lines.map((l) => l.stockedQuantity) };
}

test('旧到货单一行一条流水，按实际流水读入库量，不猜申报量', () => {
  const f = fixture(['9'], [3000]);
  try { assert.deepEqual(f.quantities(), ['3']); } finally { f.store.close(); }
});

test('旧到货单同物料同采购行多条流水，按存入顺序一一分配，不重复总量', () => {
  const f = fixture(['3', '7'], [3000, 7000]);
  try {
    assert.deepEqual(f.quantities(), ['3', '7']);
    assert.equal(f.quantities().reduce((n, q) => n + Number(q), 0), 10);
  } finally { f.store.close(); }
});

test('旧到货流水和行数不一致时保持未知；已有明确入库量不被覆盖', () => {
  for (const [lines, moves, expected] of [
    [['3', '7'], [10000], [null, null]],
    [['10'], [3000, 7000], [null]],
    [['3', '7'], [], [null, null]],
  ] as [string[], number[], (string | null)[]][]) {
    const f = fixture(lines, moves);
    try { assert.deepEqual(f.quantities(), expected); } finally { f.store.close(); }
  }
  const known = fixture(['3', '7'], [3000, 7000], '3');
  try { assert.deepEqual(known.quantities(), ['3', '7']); } finally { known.store.close(); }
});

test('到货列表沿用每行唯一流水的数量，不把底层分配结果再合成总数', () => {
  for (const [lines, moves, expected] of [
    [['3'], [3000], ['3']],
    [['3', '7'], [3000, 7000], ['3', '7']],
  ] as [string[], number[], string[]][]) {
    const f = fixture(lines, moves);
    try {
      const record = new FlowService(f.store).arrivalRecords({ includeInactive: true })[0];
      assert.deepEqual(record.lines.map((l: any) => l.stockedQuantity), expected);
      assert.equal(record.lines.some((l: any) => l.inventoryMismatch), false);
      assert.equal(record.inventoryStatus, '已入库');
    } finally { f.store.close(); }
  }
});

test('同物料一行记明入库 0、另一行有流水：两行都对得上，不误判待核对', () => {
  const f = fixture(['3', '7'], [7000], '0');
  try {
    assert.deepEqual(f.quantities(), ['0', '7']);
    const record = new FlowService(f.store).arrivalRecords({ includeInactive: true })[0];
    assert.deepEqual(record.lines.map((l: any) => l.stockedQuantity), ['0', '7']);
    assert.equal(record.lines.some((l: any) => l.inventoryMismatch), false);
    assert.notEqual(record.inventoryStatus, '入库待核对');
  } finally { f.store.close(); }
});

test('到货列表无法逐行分配的历史流水保留 null，显示入库待核对', () => {
  for (const [lines, moves] of [
    [['3', '7'], [10000]], [['10'], [3000, 7000]], [['3', '7'], []],
  ] as [string[], number[]][]) {
    const f = fixture(lines, moves);
    try {
      const record = new FlowService(f.store).arrivalRecords({ includeInactive: true })[0];
      assert.deepEqual(record.lines.map((l: any) => l.stockedQuantity), lines.map(() => null));
      assert.equal(record.inventoryStatus, '入库待核对');
    } finally { f.store.close(); }
  }
});
