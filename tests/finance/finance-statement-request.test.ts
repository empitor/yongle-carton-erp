// 对账单（src/finance/parties/statement-request.ts）：日期框清空时，读对账单的请求不带空的 from、to，
// 服务端照常报“请填写明确日期”，不露出日期格式代码；没选单位时不读。不开浏览器：fetch 换成替身，看真正发出的地址。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finRead } from '../../src/finance/fin-api.js';
import { statementRequest } from '../../src/finance/parties/statement-request.js';
import { json, signedIn, stubBrowser } from '../support/browser-fixture.js';

/** 按请求读一次，交回真正发出的地址（替身服务端回空的对账单） */
async function sentUrl(filter: Parameters<typeof statementRequest>[0]) {
  const request = statementRequest(filter);
  assert.ok(request, '选了单位就要读');
  const browser = stubBrowser((url) =>
    url === '/api/auth/state' ? signedIn() : json(200, { opening: 0, closing: 0, advance: 0, items: [], state: null }),
  );
  try {
    await finRead(...request);
    return browser.calls.filter((c) => c.url !== '/api/auth/state').map((c) => c.url);
  } finally {
    browser.restore();
  }
}

test('对账单：开始日或结束日清空时，发出的请求里没有空的 from、to', async () => {
  assert.deepEqual(await sentUrl({ kind: 'receivable', partyId: '7', from: '', to: '2026-01-31' }), [
    '/api/finance/statements?kind=receivable&partyId=7&to=2026-01-31',
  ]);
  assert.deepEqual(await sentUrl({ kind: 'payable', partyId: '8', from: '2026-01-01', to: '' }), [
    '/api/finance/statements?kind=payable&partyId=8&from=2026-01-01',
  ]);
});

test('对账单：日期都填了照常带上；没选单位时不读', async () => {
  assert.deepEqual(await sentUrl({ kind: 'receivable', partyId: '7', from: '2026-01-01', to: '2026-01-31' }), [
    '/api/finance/statements?kind=receivable&partyId=7&from=2026-01-01&to=2026-01-31',
  ]);
  assert.equal(statementRequest({ kind: 'receivable', partyId: '', from: '2026-01-01', to: '2026-01-31' }), null);
});
