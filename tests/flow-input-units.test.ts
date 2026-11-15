// 单据输入的单位和数量入口（server/flow/validate.ts 的 documentInput，纯校验、不读库）：
// 到货只收“张”、生产任务只收“只”，到货行的 0 只在更正留下的情况下收，且不能整张都是 0、0 的行要有库存品。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentInput } from '../server/flow/validate.js';

type Line = { stockId: number | null; quantity: string; unit?: string };
const arrival = (lines: Line[]) => ({
  date: '2026-10-27',
  supplierId: 1,
  reference: '虚构送货单 XN-01',
  lines: lines.map(({ stockId, quantity, unit = '' }) => ({
    stockId,
    quantity,
    item: { name: '虚构纸板', unit },
    differenceReason: '虚构无采购单',
  })),
});
const task = (unit?: string, plannedDate?: string) => ({
  date: '2026-10-27',
  productId: 1,
  quantity: '100',
  ...(unit === undefined ? {} : { unit }),
  ...(plannedDate ? { plannedDate } : {}),
});

test('新登记的到货单（不带更正留下的 0 行）每一行数量都要大于 0', () => {
  assert.throws(() => documentInput('arrival', arrival([{ stockId: 1, quantity: '10' }, { stockId: 2, quantity: '0' }])), /数量必须大于零/);
  assert.equal(documentInput('arrival', arrival([{ stockId: 1, quantity: '10' }])).lines[0].item.unit, '张');
});

test('更正留下的 0 行：有库存品的照收，整张都是 0 拒收，0 行没有库存品的报出是第几行', () => {
  const kept = documentInput('arrival', arrival([{ stockId: 1, quantity: '10' }, { stockId: 2, quantity: '0' }]), true);
  assert.deepEqual(kept.lines.map((l) => l.quantity), ['10', '0']);
  assert.throws(
    () => documentInput('arrival', arrival([{ stockId: 1, quantity: '0' }, { stockId: 2, quantity: '0' }]), true),
    /^Error: 到货单不能每一行都是 0。/,
  );
  assert.throws(
    () => documentInput('arrival', arrival([{ stockId: null, quantity: '0' }, { stockId: 2, quantity: '5' }]), true),
    /^Error: 第 1 行的数量是 0，又没有选库存品。/,
  );
  assert.throws(
    () => documentInput('arrival', arrival([{ stockId: 1, quantity: '5' }, { stockId: null, quantity: '0' }]), true),
    /^Error: 第 2 行的数量是 0，又没有选库存品。/,
  );
});

test('到货单只要有一行不是“张”就整张拒收，不换算', () => {
  assert.throws(
    () => documentInput('arrival', arrival([{ stockId: 1, quantity: '10', unit: '张' }, { stockId: 2, quantity: '3', unit: '公斤' }])),
    /原材料的数量单位只有“张”/,
  );
});

test('生产任务：“个”和没写都归成“只”，别的单位拒收；没写计划日按单据日期', () => {
  assert.equal(documentInput('task', task('个')).unit, '只');
  assert.equal(documentInput('task', task()).unit, '只');
  assert.throws(() => documentInput('task', task('箱')), /产品和成品的数量单位只有“只”/);
  assert.equal(documentInput('task', task()).plannedDate, '2026-10-27');
  assert.equal(documentInput('task', task('只', '2026-10-30')).plannedDate, '2026-10-30');
});
