// 接住的出错里给人看的那句话（shared/core 的 errorMessage）：抛出来的是什么都能拿到一句文字，不是 undefined。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../../shared/core/index.js';

test('错误对象和它的子类取 message', () => {
  assert.equal(errorMessage(new Error('库存不够')), '库存不够');
  assert.equal(errorMessage(new TypeError('不是数字')), '不是数字');
});

test('抛出来的是字符串时原样给出', () => {
  assert.equal(errorMessage('网络断了'), '网络断了');
});

test('带 message 文字的普通对象取它；别的值转成文字', () => {
  assert.equal(errorMessage({ message: '服务端拒绝', code: 409 }), '服务端拒绝');
  assert.equal(errorMessage({ message: 42 }), '[object Object]');
  assert.equal(errorMessage(undefined), 'undefined');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(404), '404');
});
