import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFloatingPosition,
  defaultFloatingAnchor,
  fitFloatingAnchor,
  floatingPosition,
  isFloatingDrag,
  mascotSize,
  readFloatingAnchor,
  saveFloatingAnchor,
  snapFloatingPosition,
  floatingPositionKey,
} from '../src/floating-assistant.js';
const desktop = { left: 0, top: 0, width: 1440, height: 950 },
  phone = { left: 0, top: 0, width: 390, height: 844 };
test('极小可视区域的锚点也限制在边界内', () => {
  const v = { left: 0, top: 0, width: 50, height: 60 },
    p = fitFloatingAnchor({ x: 1000, y: 1000 }, v);
  assert.equal(p.x, 42);
  assert.equal(p.y, 52);
});
test('悬浮图标与大小窗口始终限制在屏内，键盘缩小的可视区域包含偏移', () => {
  for (const view of [desktop, phone, { left: 30, top: 80, width: 320, height: 260 }])
    for (const size of [
      mascotSize,
      { width: Math.min(440, view.width - 16), height: Math.min(690, view.height - 16) },
    ])
      for (const p of [
        { x: -900, y: -500 },
        { x: 9999, y: 8888 },
        { x: 150, y: 200 },
      ]) {
        const c = clampFloatingPosition(p, size, view);
        assert(c.x >= view.left + 8);
        assert(c.y >= view.top + 8);
        assert(c.x + size.width <= view.left + view.width - 8);
        assert(c.y + size.height <= view.top + view.height - 8);
      }
});
test('只有靠近边缘才吸附，中间位置保持自由放置', () => {
  assert.deepEqual(snapFloatingPosition({ x: 11, y: 10 }, mascotSize, desktop), { x: 8, y: 8 });
  assert.deepEqual(snapFloatingPosition({ x: 1332, y: 839 }, mascotSize, desktop), {
    x: 1344,
    y: 844,
  });
  assert.deepEqual(snapFloatingPosition({ x: 410, y: 312 }, mascotSize, desktop), {
    x: 410,
    y: 312,
  });
});
test('点击抖动不算拖动，6像素后才进入拖动', () => {
  assert.equal(isFloatingDrag({ x: 20, y: 30 }, { x: 23, y: 33 }), false);
  assert.equal(isFloatingDrag({ x: 20, y: 30 }, { x: 26, y: 30 }), true);
  assert.equal(isFloatingDrag({ x: 20, y: 30 }, { x: 19, y: 100 }), true);
});
test('位置仅存UI坐标，刷新恢复；存储禁止/损坏不影响默认位置', () => {
  const map = new Map<string, string>(),
    storage = {
      getItem: (k: string) => map.get(k) || null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
  const anchor = { x: 650, y: 710 };
  saveFloatingAnchor(storage, anchor);
  assert.deepEqual(readFloatingAnchor(storage, desktop), anchor);
  assert.deepEqual(Object.keys(JSON.parse(map.get(floatingPositionKey)!)).sort(), [
    'version',
    'x',
    'y',
  ]);
  for (const raw of [
    'oops',
    '{"version":1,"x":"2","y":3}',
    '{"version":8,"x":2,"y":3}',
    '{"version":1,"x":1e999,"y":3}',
  ]) {
    map.set(floatingPositionKey, raw);
    assert.deepEqual(readFloatingAnchor(storage, desktop), defaultFloatingAnchor(desktop));
  }
  assert.deepEqual(
    readFloatingAnchor(
      {
        getItem: () => {
          throw Error('disabled');
        },
      },
      phone,
    ),
    defaultFloatingAnchor(phone),
  );
  assert.doesNotThrow(() =>
    saveFloatingAnchor(
      {
        setItem: () => {
          throw Error('disabled');
        },
      },
      anchor,
    ),
  );
});
test('窗口缩小恢复位置在可见范围；开合以同一右下锚点计算，不强制吸边', () => {
  const anchor = fitFloatingAnchor({ x: 1390, y: 910 }, phone),
    sprite = floatingPosition(anchor, mascotSize, phone),
    panel = floatingPosition(anchor, { width: 374, height: 690 }, phone);
  assert(sprite.x + mascotSize.width <= 382);
  assert(sprite.y + mascotSize.height <= 836);
  assert(panel.x >= 8 && panel.y >= 8);
  assert.deepEqual(floatingPosition({ x: 730, y: 800 }, { width: 440, height: 690 }, desktop), {
    x: 290,
    y: 110,
  });
});
