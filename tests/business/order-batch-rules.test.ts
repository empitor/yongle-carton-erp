// 订货单的规则（shared/business/operations/order-batch.ts，纯函数）：采购明细带上采购单信息、同种纸板合行、到货安排、按采购单先后分到货、今天要到。
// 订货单的服务（建批次、改安排、换供应商、删采购单）在 order-batch.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  allocateReceipt,
  batchRowKey,
  batchRows,
  dueSegments,
  purchaseLinesOf,
  type BatchSourceLine,
} from '../../shared/business/index.js';
import { scheduleView } from '../../shared/business/operations/order-batch.js';

/** 合并依据（JSON 文字）拆回各段：名称、规格、尺寸、材质、楞型、单位、计价方式、单价 */
const keyParts = (key: string) => z.array(z.string()).parse(JSON.parse(key));

const line = (over: Partial<BatchSourceLine>): BatchSourceLine => ({
  purchaseId: 1,
  purchaseNumber: 'CG-1',
  purchaseOrderDate: '2026-11-01',
  id: 1,
  name: '虚构纸板A',
  length: 1000,
  width: 800,
  dimensionUnit: 'mm',
  material: 'K=A',
  flute: 'B',
  unit: '张',
  priceBasis: 'quantity',
  unitPrice: '1.2',
  quantityUnits: 1000_000,
  receivedUnits: 0,
  ...over,
});

test('采购明细带上采购单信息（purchaseLinesOf）：单号、下单日期跟着明细走，数量换成数字，明细原有的字段不丢', () => {
  const purchases = [
    { id: 7, number: 'CG-虚构-7', orderDate: '2026-11-01', lines: [{ id: 1, name: '虚构纸板', unit: '张', quantityUnits: '5000', receivedUnits: 0 }] },
    { id: 8, number: 'CG-虚构-8', orderDate: '2026-11-02', lines: [] },
    {
      id: 9,
      number: 'CG-虚构-9',
      orderDate: '2026-11-03',
      lines: [
        { id: 2, name: '虚构纸板', unit: '张', quantityUnits: 1000, receivedUnits: '250', notes: '虚构备注' },
        { id: 3, name: '虚构隔板', unit: '张', quantityUnits: null, receivedUnits: undefined },
      ],
    },
  ];
  const lines = purchaseLinesOf(purchases);
  assert.deepEqual(
    lines.map((l) => [l.id, l.purchaseId, l.purchaseNumber, l.purchaseOrderDate, l.quantityUnits, l.receivedUnits]),
    [
      [1, 7, 'CG-虚构-7', '2026-11-01', 5000, 0],
      [2, 9, 'CG-虚构-9', '2026-11-03', 1000, 250],
      [3, 9, 'CG-虚构-9', '2026-11-03', 0, Number.NaN],
    ],
  );
  assert.equal(lines[1].notes, '虚构备注');
  assert.deepEqual(purchaseLinesOf([]), []);
});

test('订货单上同种纸板合成一行，价格或规格不同就分开', () => {
  const rows = batchRows([
    line({ id: 1, purchaseId: 1 }),
    line({ id: 2, purchaseId: 2, purchaseNumber: 'CG-2', quantityUnits: 500_000 }),
    line({ id: 3, purchaseId: 2, purchaseNumber: 'CG-2', unitPrice: '1.3' }),
    line({ id: 4, purchaseId: 3, purchaseNumber: 'CG-3', width: 900 }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].orderedUnits, 1500_000);
  assert.deepEqual(rows[0].lines.map((l) => l.id), [1, 2]);
});

test('单价写法不同、数值相同（2.76、2.760、2.7600）是同一个价，订货单上合成一行；数值不同照样分开', () => {
  const rows = batchRows([
    line({ id: 1, purchaseId: 1, unitPrice: '2.76' }),
    line({ id: 2, purchaseId: 2, purchaseNumber: 'CG-2', unitPrice: '2.7600' }),
    line({ id: 3, purchaseId: 3, purchaseNumber: 'CG-3', unitPrice: '2.760' }),
    line({ id: 4, purchaseId: 4, purchaseNumber: 'CG-4', unitPrice: '2.7601' }),
  ]);
  assert.equal(rows.length, 2, '以前页面填的 2.76 和助手、识别存的 2.7600 分成两行，印出来一模一样');
  assert.deepEqual(rows[0].lines.map((l) => l.id), [1, 2, 3]);
  assert.equal(rows[0].orderedUnits, 3000_000);
  assert.deepEqual(rows[1].lines.map((l) => l.id), [4]);
  // 依据里记去掉末尾 0 的写法：原来就这样写的（2.5、3、0）依据不变，存着的到货安排照样对得上
  const priceOf = (unitPrice: string | null) => keyParts(batchRows([line({ unitPrice })])[0].key).at(-1);
  assert.equal(priceOf('2.7600'), '2.76');
  assert.equal(priceOf('2.5'), '2.5');
  assert.equal(priceOf('3.00'), '3');
  assert.equal(priceOf('3'), '3');
  assert.equal(priceOf('0.0000'), '0');
  assert.equal(priceOf('10.5000'), '10.5');
  assert.equal(priceOf(null), '');
  assert.equal(priceOf('待定'), '待定', '不是合法单价的照原文');
});

test('订货单合并依据不跟着显示文字变：尺寸单位没写的老批次也能对上已存的到货安排', () => {
  // 单位写空串和原来不写一样：合并依据里都记成空的那一段
  const key = keyParts(batchRowKey({ name: '虚构纸板', unit: '', specification: '', length: 100, width: 80, dimensionUnit: null }));
  assert.ok(key.includes('100 × 80（单位待确认）'), '和以前存进订货批次的依据一样');
});

test('到货安排：截止日期早的先扣已到数量，没安排的部分补一段日期未定', () => {
  const view = scheduleView(
    [
      { rowKey: 'k', quantityUnits: 500_000, dueDate: '2026-11-15' },
      { rowKey: 'k', quantityUnits: 1000_000, dueDate: '2026-11-12' },
    ],
    2000_000,
    1200_000,
    '2026-11-13',
  );
  assert.deepEqual(
    view.map((s) => [s.dueDate, s.receivedUnits, s.remainingUnits, s.state]),
    [
      ['2026-11-12', 1000_000, 0, 'done'],
      ['2026-11-15', 200_000, 300_000, 'due'],
      [null, 0, 500_000, 'undated'],
    ],
  );
  assert.equal(scheduleView([{ rowKey: 'k', quantityUnits: 100, dueDate: '2026-11-01' }], 100, 0, '2026-11-02')[0].state, 'overdue');
});

test('登记到货按采购单先后分到各条明细，不合格也按顺序分，超过还差的数就拒绝', () => {
  const rows = batchRows([
    line({ id: 1, purchaseId: 1, quantityUnits: 1000_000, receivedUnits: 400_000 }),
    line({ id: 2, purchaseId: 2, purchaseOrderDate: '2026-11-02', quantityUnits: 500_000 }),
  ]);
  assert.deepEqual(allocateReceipt(rows, [{ key: rows[0].key, quantityUnits: 800_000, rejectedUnits: 700_000 }]), [
    { lineId: 1, purchaseId: 1, quantityUnits: 600_000, rejectedUnits: 600_000, stockedUnits: 0 },
    { lineId: 2, purchaseId: 2, quantityUnits: 200_000, rejectedUnits: 100_000, stockedUnits: 100_000 },
  ]);
  assert.throws(() => allocateReceipt(rows, [{ key: rows[0].key, quantityUnits: 1200_000, rejectedUnits: 0 }]), /比还没到的/);
  // 合格了没全部入库：少入的数按同样顺序从各条的合格数里扣
  assert.deepEqual(allocateReceipt(rows, [{ key: rows[0].key, quantityUnits: 800_000, rejectedUnits: 100_000, stockedUnits: 300_000 }]), [
    { lineId: 1, purchaseId: 1, quantityUnits: 600_000, rejectedUnits: 100_000, stockedUnits: 100_000 },
    { lineId: 2, purchaseId: 2, quantityUnits: 200_000, rejectedUnits: 0, stockedUnits: 200_000 },
  ]);
  assert.throws(
    () => allocateReceipt(rows, [{ key: rows[0].key, quantityUnits: 800_000, rejectedUnits: 100_000, stockedUnits: 800_000 }]),
    /入库数量不能超过验收合格数量/,
  );
});

test('今天要到（dueSegments）：截止日是今天和已过截止日还没到齐的段，逾期的排前面；到齐的、日期待定的、以后的不列', () => {
  const seg = (dueDate: string | null, remainingUnits: number) => ({ dueDate, remainingUnits });
  const batches = [
    { id: 2, number: 'DG-乙', supplierName: '虚构乙', rows: [{ name: '纸板乙', unit: '张', schedule: [seg('2026-11-05', 100_000), seg('2026-11-20', 50_000)] }] },
    { id: 1, number: 'DG-甲', supplierName: '虚构甲', rows: [{ name: '纸板甲', unit: '张', schedule: [seg('2026-11-01', 0), seg('2026-11-03', 30_000), seg(null, 10_000)] }] },
  ];
  assert.deepEqual(
    dueSegments(batches, '2026-11-05').map((s) => [s.batchId, s.name, s.dueDate, s.remainingUnits, s.overdue]),
    [
      [1, '纸板甲', '2026-11-03', 30_000, true],
      [2, '纸板乙', '2026-11-05', 100_000, false],
    ],
  );
});

