// 补税率时人填的税率（单张补、批量补）和往来条款同一份认法（server/finance/parties/terms.ts 的 taxRateProblem），
// 经真接口核对两句报错照旧：超过 100% 说“税率超出范围。”，写法不对说“税率无效，请检查后重试。”。
// 往来条款那一侧的收不收见 finance-tax-terms.test.ts。全部是虚构数据，只用内存库。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../server/core/index.js';
import { newSettings } from './finance-fixture.js';
import { startHttp } from '../support/http-fixture.js';

/** 认得出的税率过了校验，才轮到找事件（这里没有 1 号事件） */
const PASSED = { code: 'validation', message: '找不到这张单据的财务记录。' };
const cases: [string, number, unknown][] = [
  ['100.5', 400, { message: '税率超出范围。' }],
  ['999%', 400, { message: '税率超出范围。' }],
  ['abc', 400, { message: '税率无效，请检查后重试。' }],
  ['1000', 400, { message: '税率无效，请检查后重试。' }],
  ['13.1234567', 400, { message: '税率无效，请检查后重试。' }],
  ['13%%', 400, { message: '税率无效，请检查后重试。' }],
  ['0.5', 404, PASSED],
  ['13.123456%', 404, PASSED],
];

test('补税率填的税率：超过 100% 报“税率超出范围。”，写法不对报“税率无效，请检查后重试。”，认得出的照常往下办；单张和批量一样', async () => {
  const s = new Store(':memory:');
  const h = await startHttp(s);
  try {
    newSettings(s);
    for (const [rate, status, body] of cases) {
      const single = await h.send(
        '/finance/events/1/resolve',
        { version: 1, requestId: 'single-' + rate, lines: [{ exact: '100', mode: '含税', rate }] },
        h.cookie,
      );
      assert.deepEqual([single.status, await single.json()], [status, body], '单张补 ' + rate);
      const batch = await h.send(
        '/finance/tax-completion/batch',
        { requestId: 'batch-' + rate, items: [{ id: 1, version: 1 }], rate, mode: '含税' },
        h.cookie,
      );
      assert.deepEqual([batch.status, await batch.json()], [status, body], '批量补 ' + rate);
    }
  } finally {
    await h.close();
    s.close();
  }
});
