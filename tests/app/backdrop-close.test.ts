// 公共弹窗件点背后暗处：手机样式下按下、抬起都在暗处才关，正在提交不关；电脑上不关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBackdropClose } from '../../src/ui/backdrop-close.js';

type Handlers = ReturnType<typeof useBackdropClose>;

/** 渲染一次拿到暗层的两个处理函数，返回它们和关窗次数 */
function backdrop(busy = false) {
  const state: { closed: number; handlers?: Handlers } = { closed: 0 };
  function Probe() {
    state.handlers = useBackdropClose(() => state.closed++, busy);
    return null;
  }
  renderToStaticMarkup(h(Probe));
  assert.ok(state.handlers);
  return { state, on: state.handlers };
}

const layer = new EventTarget(),
  dialog = new EventTarget();
/** 按下落在 down 上、抬起后点击落在 up 上（点击的落点是两者共同的祖先，暗层上的处理函数收到的 currentTarget 都是暗层） */
function press(on: Handlers, down: EventTarget, up: EventTarget) {
  on.onPointerDown({ target: down, currentTarget: layer });
  on.onClick({ target: up, currentTarget: layer });
}

/** 让 isPhoneNow 认为现在是不是手机样式，跑完还原 */
function asScreen(phone: boolean, run: () => void) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: phone }) },
  });
  try {
    run();
  } finally {
    if (had) Object.defineProperty(globalThis, 'window', had);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('手机样式下按下、抬起都在暗处时关窗', () => {
  asScreen(true, () => {
    const { state, on } = backdrop();
    press(on, layer, layer);
    assert.equal(state.closed, 1);
  });
});

test('手机样式下在窗口里按下、拖到暗处松手不关窗', () => {
  asScreen(true, () => {
    const { state, on } = backdrop();
    press(on, dialog, layer);
    press(on, layer, dialog);
    assert.equal(state.closed, 0);
  });
});

test('手机样式下正在提交时点暗处不关窗', () => {
  asScreen(true, () => {
    const { state, on } = backdrop(true);
    press(on, layer, layer);
    assert.equal(state.closed, 0);
  });
});

test('电脑上点暗处不关窗', () => {
  asScreen(false, () => {
    const { state, on } = backdrop();
    press(on, layer, layer);
    assert.equal(state.closed, 0);
  });
});
