import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { readTheme, resolveTheme, THEME_STORAGE_KEY } from '../src/theme.js';

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
  const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  for (const saved of ['dark', 'light', 'system', 'unknown', null]) {
    for (const systemDark of [true, false]) {
      const root = { dataset: {} as Record<string, string>, style: { colorScheme: '' } };
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
      assert.equal(meta.content, root.dataset.theme === 'dark' ? '#141c24' : '#f3f6f7');
    }
  }
});

test('浏览器禁止存储时首屏仍能显示，主题脚本不要求放宽CSP', () => {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: '' } };
  runInNewContext(readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8'), {
    localStorage: {
      getItem: () => {
        throw new Error('storage disabled');
      },
    },
    matchMedia: () => ({ matches: true }),
    document: { documentElement: root, querySelector: () => null },
  });
  assert.equal(root.dataset.theme, 'dark');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/theme-init\.js"><\/script>/);
  assert.ok(html.indexOf('/theme-init.js') < html.indexOf('/src/main.tsx'));
});
