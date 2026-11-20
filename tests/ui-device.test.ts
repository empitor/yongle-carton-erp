// 设备上的系统设置（src/ui/phone.ts）：要不要减少动态效果（小甬小勒的小剧场、App 里滑到头的回弹都按它）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefersReducedMotion } from '../src/ui/phone.js';

/** 换掉 window（undefined 是不在浏览器里），跑完 run 还原 */
function withWindow<T>(value: unknown, run: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  if (value === undefined) Reflect.deleteProperty(globalThis, 'window');
  else Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}
/** 浏览器替身：系统设置里只有 matching 这一条查询成立 */
const browser = (matching: string | null) => ({ matchMedia: (query: string) => ({ matches: query === matching }) });

test('系统开了“减少动态效果”时为真，没开时为假', () => {
  assert.equal(withWindow(browser('(prefers-reduced-motion: reduce)'), prefersReducedMotion), true);
  assert.equal(withWindow(browser(null), prefersReducedMotion), false);
});

test('不在浏览器里（服务端渲染、测试）或浏览器没有 matchMedia 时按没开处理', () => {
  assert.equal(withWindow(undefined, prefersReducedMotion), false);
  assert.equal(withWindow({}, prefersReducedMotion), false);
});
