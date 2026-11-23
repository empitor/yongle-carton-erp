import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { listen } from '../../src/ui/events.js';
import { followSystemTheme, readTheme, resolveTheme, saveTheme, THEME_STORAGE_KEY } from '../../src/ui/theme.js';

/** 换掉 window、document：系统深浅由 setDark 切换（会发 change），跨标签页存储由 setStorage 触发，页面的主题记在 root 上。用完调 restore() 还原 */
function stubThemePage() {
  const saved = ['window', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const media = new EventTarget();
  const win = new EventTarget();
  let dark = false;
  let stored: string | null = null;
  const dataset: Record<string, string> = {};
  const meta: Record<string, string> = {};
  const root = { dataset, style: { colorScheme: '' } };
  const stub = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  stub(
    'window',
    Object.assign(win, {
      // 样式里的页面底色：跟着页面当前的深浅
      getComputedStyle: () => ({
        getPropertyValue: (name: string) => (name === '--page-bg' ? (dataset.theme === 'dark' ? ' #111113' : ' #eee7d6') : ''),
      }),
      matchMedia: () => Object.assign(media, { get matches() { return dark; } }),
      localStorage: {
        getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null),
        setItem: (key: string, value: string) => {
          if (key === THEME_STORAGE_KEY) stored = value;
        },
      },
    }),
  );
  stub('document', {
    documentElement: root,
    querySelector: () => ({
      setAttribute: (key: string, value: string) => {
        meta[key] = value;
      },
    }),
  });
  return {
    root,
    meta,
    setDark(value: boolean) {
      dark = value;
      media.dispatchEvent(new Event('change'));
    },
    setStorage(value: string | null, key: string | null = THEME_STORAGE_KEY) {
      if (key === THEME_STORAGE_KEY || key === null) stored = value;
      win.dispatchEvent(Object.assign(new Event('storage'), { key }));
    },
    restore() {
      for (const [name, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    },
  };
}

test('跟随系统时系统换了深浅，页面马上跟着换；选了固定的深浅就不跟', () => {
  const page = stubThemePage();
  const stop = followSystemTheme();
  try {
    saveTheme('system');
    assert.equal(page.root.dataset.theme, 'light');
    page.setDark(true);
    assert.equal(page.root.dataset.theme, 'dark');
    saveTheme('light');
    page.setDark(false);
    page.setDark(true);
    assert.equal(page.root.dataset.theme, 'light');
  } finally {
    stop();
    page.restore();
  }
});

test('别的标签页改了主题偏好（不打开本页菜单），页面马上同步深浅与配色属性', () => {
  const page = stubThemePage();
  const stop = followSystemTheme();
  try {
    saveTheme('light');
    assert.equal(page.root.dataset.theme, 'light');
    page.setStorage('dark');
    assert.equal(page.root.dataset.theme, 'dark');
    assert.equal(page.root.dataset.themePreference, 'dark');
    assert.equal(page.root.style.colorScheme, 'dark');
    assert.equal(page.meta.content, '#111113', '地址栏颜色取样式里深色的页面底色');
    page.setStorage('light', 'unrelated-key');
    assert.equal(page.root.dataset.theme, 'dark');
    page.setStorage(null, null);
    assert.equal(page.root.dataset.theme, 'light');
    assert.equal(page.root.dataset.themePreference, 'system');
  } finally {
    stop();
    page.restore();
  }
});

test('本页切换和别的标签页改了外观，都会发出外观变了的事件，显示外观的地方据此重读', () => {
  const page = stubThemePage();
  const stop = followSystemTheme();
  let changed = 0;
  const stopListening = listen('erp-theme-changed', () => changed++);
  try {
    saveTheme('dark');
    assert.equal(changed, 1);
    page.setStorage('light');
    assert.equal(changed, 2);
  } finally {
    stopListening();
    stop();
    page.restore();
  }
});

test('外观偏好优先于系统，未知或不可读偏好安全跟随系统', () => {
  assert.equal(
    readTheme({ getItem: (key) => (key === THEME_STORAGE_KEY ? 'dark' : null) }),
    'dark',
  );
  assert.equal(readTheme({ getItem: () => 'invalid' }), 'system');
  assert.equal(
    readTheme({
      getItem: () => {
        throw new Error('storage disabled');
      },
    }),
    'system',
  );
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('首屏脚本在React加载前恢复偏好，与React主题解析保持一致', () => {
  const script = readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8');
  for (const saved of ['dark', 'light', 'system', 'unknown', null]) {
    for (const systemDark of [true, false]) {
      const dataset: Record<string, string> = {};
      const root = { dataset, style: { colorScheme: '' } };
      const meta: Record<string, string> = {};
      runInNewContext(script, {
        localStorage: { getItem: () => saved },
        matchMedia: () => ({ matches: systemDark }),
        document: {
          documentElement: root,
          querySelector: () => ({
            setAttribute: (key: string, value: string) => {
              meta[key] = value;
            },
          }),
        },
      });
      const preference = readTheme({ getItem: () => saved });
      assert.equal(root.dataset.themePreference, preference);
      assert.equal(root.dataset.theme, resolveTheme(preference, systemDark));
      assert.equal(root.style.colorScheme, root.dataset.theme);
      assert.equal(meta.content, undefined, '地址栏颜色要读样式，等样式加载后由 theme.ts 设');
    }
  }
});

test('浏览器禁止存储时首屏仍能显示，主题脚本不要求放宽CSP', () => {
  const dataset: Record<string, string> = {};
  const root = { dataset, style: { colorScheme: '' } };
  runInNewContext(readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8'), {
    localStorage: {
      getItem: () => {
        throw new Error('storage disabled');
      },
    },
    matchMedia: () => ({ matches: true }),
    document: { documentElement: root, querySelector: () => null },
  });
  assert.equal(root.dataset.theme, 'dark');
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/theme-init\.js"><\/script>/);
  assert.ok(html.indexOf('/theme-init.js') < html.indexOf('/src/main.tsx'));
});
