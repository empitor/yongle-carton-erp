// 完工单的领料、退料数量写得不对（shared/business/physical-flow.ts 的 productionSchema）：是“输入不对”的校验错误
// （服务端回 400，和别的校验一样），不是比较退料和领料时抛出的普通错误（那样服务端回 500）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { flowInput } from '../shared/business/index.js';

const production = (material: Record<string, unknown>) => ({
  date: '2026-10-27',
  productId: 1,
  goodQuantity: '10',
  operator: '虚构员工',
  materials: [{ stockId: 1, ...material }],
});

test('领料或退料数量写法不对：报数量的校验错误，不抛普通错误', () => {
  for (const material of [{ issued: '一百', returned: '0' }, { issued: '10', returned: '1.2345' }, { issued: '-1' }]) {
    assert.throws(
      () => flowInput('production', production(material)),
      (e: unknown) => e instanceof ZodError && e.issues.some((i) => /数量/.test(i.message)),
      JSON.stringify(material),
    );
  }
});

test('写法对的数量照常比：退料多于领料报“退料数量不能超过领料数量”', () => {
  assert.throws(
    () => flowInput('production', production({ issued: '2', returned: '3' })),
    (e: unknown) => e instanceof ZodError && e.issues.some((i) => i.message === '退料数量不能超过领料数量'),
  );
  assert.equal(flowInput('production', production({ issued: '3', returned: '2' })).materials[0].returned, '2');
});
