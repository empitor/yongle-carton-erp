// 助手输入框的回车：什么按键算发送（src/assistant/composer-keys.ts）。纯函数，不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendsOnEnter, type PressedKey } from '../../src/assistant/composer-keys.js';

const plainEnter: PressedKey = {
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
};

test('电脑上单按回车发送', () => {
  assert.equal(sendsOnEnter(plainEnter, false), true);
});

test('Shift+回车是换行，不发送', () => {
  assert.equal(sendsOnEnter({ ...plainEnter, shiftKey: true }, false), false);
});

test('输入法正在选字时按回车是上屏，不发送', () => {
  assert.equal(sendsOnEnter({ ...plainEnter, isComposing: true }, false), false);
});

test('手机上回车是换行，不发送', () => {
  assert.equal(sendsOnEnter(plainEnter, true), false);
});

test('Ctrl、Cmd、Alt 加回车交给浏览器，不发送', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
    assert.equal(sendsOnEnter({ ...plainEnter, [modifier]: true }, false), false, modifier);
  }
});

test('不是回车的键不发送', () => {
  for (const key of ['a', ' ', 'Tab', 'Escape']) {
    assert.equal(sendsOnEnter({ ...plainEnter, key }, false), false, key);
  }
});
