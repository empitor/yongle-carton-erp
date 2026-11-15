// DeepSeek 回答里可有可无的字段：缺了照样认，不当成格式不对。假传输函数，不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDeepSeek, fakeKey } from './fake-deepseek.js';
import { jsonResponse } from './fake-deepseek-wire.js';
import { providerTokenUsage } from '../server/ai/usage.js';
import { getBalance } from '../server/ai/balance.js';

test('usage 只带进、出、总数时照样认出来，缺的缓存和思考项不报', () => {
  assert.deepEqual(providerTokenUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

test('usage 的缓存命中数从明细里取，明细不是对象当作没有', () => {
  assert.deepEqual(
    providerTokenUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: 'x' }),
    { inputTokens: 10, outputTokens: undefined, totalTokens: undefined, cachedInputTokens: 4 },
  );
});

test('没有 usage 或三个数都不是非负整数时不报用量', () => {
  assert.equal(providerTokenUsage(undefined), undefined);
  assert.equal(providerTokenUsage({ prompt_tokens: -1, completion_tokens: 1.5, total_tokens: '3' }), undefined);
});

test('余额回答没写 is_available 时按可用算，余额照样列出', async () => {
  const fake = fakeDeepSeek();
  fake.next('/user/balance', jsonResponse({ balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] }));
  const balance = await getBalance(fake.transport, fakeKey);
  assert.equal(balance.available, true);
  assert.deepEqual(balance.balances, [{ currency: 'CNY', total: '5.00', granted: '0.00', toppedUp: '0.00' }]);
});
