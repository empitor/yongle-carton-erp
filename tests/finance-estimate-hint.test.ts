// 财务概览“记账口径”顶上的估算提示：只写有数的那几项，为 0 的不写（纯函数，虚构数据）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateHint } from '../src/finance/overview/estimate-hint.js';

test('只有没算进理论金额的单据时不写“0 张单据待补税率”，只写缺价格或数量的', () => {
  assert.equal(
    estimateHint({ missingTax: 0, missingPrice: 2 }),
    '本月有 2 张单据缺价格或数量、没算进理论金额，下面的数字是估算。',
  );
});

test('只缺税率时只写待补税率的', () => {
  assert.equal(estimateHint({ missingTax: 3, missingPrice: 0 }), '本月有 3 张单据待补税率，下面的数字是估算。');
});

test('两样都有时两样都写', () => {
  assert.equal(
    estimateHint({ missingTax: 1, missingPrice: 4 }),
    '本月有 1 张单据待补税率，4 张单据缺价格或数量、没算进理论金额，下面的数字是估算。',
  );
});

test('都没有时不提示', () => {
  assert.equal(estimateHint({ missingTax: 0, missingPrice: 0 }), null);
});
