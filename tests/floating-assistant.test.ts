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
  floatingLauncherModeKey,
  assistantPageLabel,
  assistantPanelModeKey,
  readAssistantPanelMode,
  readFloatingLauncher,
  clampMascotDragPosition,
  fitFloatingMascot,
  floatingMascotPosition,
  readFloatingMascot,
  saveFloatingMascot,
  settleFloatingMascot,
  floatingMascotKey,
  moveFloatingMascot,
} from '../src/floating-assistant.js';
const desktop = { left: 0, top: 0, width: 1440, height: 950 },
  phone = { left: 0, top: 0, width: 390, height: 844 };
test('默认及旧版无偏好显示精灵，尊重显式顶栏选择；损坏或禁用存储不隐藏入口', () => {
  for (const value of [null, 'floating', '', 'unknown', '{broken']) {
    assert.equal(
      readFloatingLauncher({
        getItem: (key) => {
          assert.equal(key, floatingLauncherModeKey);
          return value;
        },
      }),
      true,
    );
  }
  assert.equal(readFloatingLauncher({ getItem: () => 'docked' }), false);
  assert.equal(
    readFloatingLauncher({
      getItem: () => {
        throw Error('disabled');
      },
    }),
    true,
  );
});
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
  assert.deepEqual(snapFloatingPosition({ x: 1316, y: 829 }, mascotSize, desktop), {
    x: 1328,
    y: 834,
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

test('仅左右靠边24像素内停靠一半，中间及仅靠上下边保持完整形象', () => {
  for (const view of [desktop, phone, { left: 30, top: 80, width: 320, height: 260 }]) {
    for (const [x, dock] of [
      [view.left + 24, 'dock-left'],
      [view.left + view.width - mascotSize.width - 24, 'dock-right'],
    ] as const) {
      const settled = settleFloatingMascot({ x, y: view.top + 100 }, mascotSize, view);
      assert.equal(settled.dock, dock);
      const p = floatingMascotPosition(settled, mascotSize, view);
      const visible =
        Math.min(p.x + mascotSize.width, view.left + view.width) - Math.max(p.x, view.left);
      assert.equal(visible, mascotSize.width / 2);
      assert(p.y >= view.top + 8);
      assert(p.y + mascotSize.height <= view.top + view.height - 8);
    }
    const x = view.left + (view.width - mascotSize.width) / 2;
    assert.equal(settleFloatingMascot({ x, y: -100 }, mascotSize, view).dock, 'free');
    assert.equal(settleFloatingMascot({ x, y: 99999 }, mascotSize, view).dock, 'free');
  }
  assert.equal(settleFloatingMascot({ x: 25, y: 200 }, mascotSize, desktop).dock, 'free');
  assert.equal(settleFloatingMascot({ x: 1311, y: 200 }, mascotSize, desktop).dock, 'free');
});

test('半隐藏拖回中间不会因全组件边界限制而跳变，始终至少一半可见', () => {
  const half = mascotSize.width / 2;
  const left = { x: -half, y: 300 };
  for (const dx of [1, 4, 7, 20, 80, 300]) {
    const p = clampMascotDragPosition({ x: left.x + dx, y: left.y }, mascotSize, desktop);
    assert.equal(p.x, left.x + dx);
  }
  for (const x of [-99999, 99999]) {
    const p = clampMascotDragPosition({ x, y: 99999 }, mascotSize, desktop);
    assert(p.x >= -half && p.x <= desktop.width - half);
    assert.equal(p.y, desktop.height - mascotSize.height - 8);
  }
  assert.equal(settleFloatingMascot({ x: 400, y: 300 }, mascotSize, desktop).dock, 'free');
});
test('键盘向内连续移动不会被再次吸回边缘，上下移动保留当前三态', () => {
  for (const dock of ['dock-left', 'dock-right'] as const) {
    let p = fitFloatingMascot({ x: 600, y: 700, dock }, desktop);
    assert.equal(moveFloatingMascot(p, mascotSize, desktop, 0, -12).dock, dock);
    const dx = dock === 'dock-left' ? 12 : -12;
    for (let i = 0; i < 10; i++) {
      const next = moveFloatingMascot(p, mascotSize, desktop, dx, 0);
      assert.equal(next.dock, 'free');
      assert(dx > 0 ? next.x > p.x : next.x < p.x);
      p = next;
    }
  }
  const p = { ...defaultFloatingAnchor(desktop), dock: 'free' as const };
  assert.equal(moveFloatingMascot(p, mascotSize, desktop, 0, 12).dock, 'free');
});

test('三态独立持久化，旧位置迁移不覆写原配置，窗口缩小保留停靠并修正纵向位置', () => {
  const map = new Map<string, string>([
    [floatingPositionKey, JSON.stringify({ version: 1, x: 600, y: 700 })],
  ]);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
  assert.deepEqual(readFloatingMascot(storage, desktop), { x: 600, y: 700, dock: 'free' });
  for (const dock of ['free', 'dock-left', 'dock-right'] as const) {
    const placed = fitFloatingMascot({ x: 600, y: 700, dock }, desktop);
    saveFloatingMascot(storage, placed);
    assert.deepEqual(readFloatingMascot(storage, desktop), placed);
    const shrunk = fitFloatingMascot(placed, phone);
    assert.equal(shrunk.dock, dock);
    const sprite = floatingMascotPosition(shrunk, mascotSize, phone);
    assert(sprite.x + mascotSize.width >= 44);
    assert(sprite.x <= phone.width - 44);
    const panel = floatingPosition(placed, { width: 374, height: 600 }, phone);
    assert(panel.x >= 8 && panel.x + 374 <= phone.width - 8);
    assert(panel.y >= 8 && panel.y + 600 <= phone.height - 8);
  }
  assert.equal(map.get(floatingPositionKey), JSON.stringify({ version: 1, x: 600, y: 700 }));
  for (const raw of [
    'oops',
    'null',
    '{"version":2,"x":1e999,"y":2,"dock":"dock-left"}',
    '{"version":2,"x":2,"y":3,"dock":"lost"}',
    '{"version":3,"x":2,"y":3,"dock":"free"}',
  ]) {
    map.set(floatingMascotKey, raw);
    assert.deepEqual(readFloatingMascot(storage, desktop), { x: 600, y: 700, dock: 'free' });
  }
  const disabled = {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('disabled');
    },
  };
  assert.deepEqual(readFloatingMascot(disabled, desktop), {
    ...defaultFloatingAnchor(desktop),
    dock: 'free',
  });
  assert.doesNotThrow(() => saveFloatingMascot(disabled, { x: 600, y: 700, dock: 'dock-right' }));
});

test('助手默认停靠，只有明确选过才用浮动窗口；存储损坏或禁用时仍停靠', () => {
  const stored = (value: string | null) => ({
    getItem: (key: string) => {
      assert.equal(key, assistantPanelModeKey);
      return value;
    },
  });
  for (const value of [null, '', 'docked', '{broken'])
    assert.equal(readAssistantPanelMode(stored(value)), 'docked');
  assert.equal(readAssistantPanelMode(stored('floating')), 'floating');
  assert.equal(
    readAssistantPanelMode({
      getItem: () => {
        throw new Error('storage disabled');
      },
    }),
    'docked',
  );
});

test('助手上下文提示写出当前页面和正在看的记录', () => {
  assert.equal(assistantPageLabel('#orders?order=3', 'SH-1'), '订单 · SH-1');
  assert.equal(assistantPageLabel('', null), '今日');
  assert.equal(assistantPageLabel('#purchases'), '采购');
  assert.equal(assistantPageLabel('#ai-settings', null), '');
});
