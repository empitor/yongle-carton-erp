// 按新账期重算到期日（src/finance/parties/parties-api.ts）：预览以后往来或账期被别人改了，服务端按摘要拒绝（409，类别 preview-changed）。
// 窗口不能卡在旧摘要上一直被拒：要读回最新的预览交给窗口，再告诉人核对后重新确认；别的拒绝照服务端原话报、不重读。
// 不开浏览器：fetch 换成替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDueRecalculation, recalcChangedMessage } from '../../src/finance/parties/parties-api.js';
import { json, signedIn, stubBrowser } from '../support/browser-fixture.js';

const latest = {
  rows: [{ id: 3, before: '2026-02-01', dueDate: '2026-03-25', version: 2, balance: 10000 }],
  installments: [],
  terms: { kind: 'customer', party_id: '7' },
  digest: 'new-digest',
};
const body = { kind: 'receivable' as const, partyId: '7', digest: 'old-digest', reason: '账期改成月结' };

test('重算到期日：预览以后数据变了被拒时，换成最新的预览并提示重新确认', async () => {
  const browser = stubBrowser((url, init) => {
    if (url === '/api/auth/state') return signedIn();
    if (init?.method === 'POST')
      return json(409, { message: '预览以后数据已变化，请重新预览。', code: 'preview-changed' });
    return json(200, latest);
  });
  const reloaded: unknown[] = [];
  try {
    await assert.rejects(
      applyDueRecalculation(body, (next) => reloaded.push(next)),
      { message: recalcChangedMessage },
    );
    assert.deepEqual(reloaded, [latest]);
    assert.deepEqual(
      browser.calls.filter((c) => c.url !== '/api/auth/state').map((c) => [c.init?.method ?? 'GET', c.url]),
      [
        ['POST', '/api/finance/due-recalculation'],
        ['GET', '/api/finance/due-recalculation?kind=receivable&partyId=7'],
      ],
    );
  } finally {
    browser.restore();
  }
});

test('重算到期日：别的拒绝照服务端的原话报，不重读预览', async () => {
  const browser = stubBrowser((url) =>
    url === '/api/auth/state' ? signedIn() : json(400, { message: '该往来单位尚未设账期。' }),
  );
  const reloaded: unknown[] = [];
  try {
    await assert.rejects(
      applyDueRecalculation(body, (next) => reloaded.push(next)),
      { message: '该往来单位尚未设账期。' },
    );
    assert.deepEqual(reloaded, []);
    assert.equal(browser.calls.filter((c) => c.url !== '/api/auth/state').length, 1);
  } finally {
    browser.restore();
  }
});
