// 手机上滚动时的顶栏收起（src/mobile/topbar-collapse.ts）和 App 里只拉伸内容区（src/mobile/content-stretch.ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followScroll, settle } from '../src/mobile/topbar-collapse.js';
import { pullsContent, stretchOf } from '../src/mobile/content-stretch.js';

const H = 52;

test('往下滚时顶栏跟手收起，收完为止', () => {
  assert.equal(followScroll(0, 20, 300, H), 20);
  assert.equal(followScroll(40, 30, 300, H), H);
});

test('往回滚时顶栏跟手露出，露完为止', () => {
  assert.equal(followScroll(H, -12, 300, H), 40);
  assert.equal(followScroll(10, -30, 300, H), 0);
});

test('离顶部不够一个顶栏高时最多收到顶部为止，回到顶部一定全露出', () => {
  assert.equal(followScroll(0, 30, 18, H), 18);
  assert.equal(followScroll(H, -300, 0, H), 0);
});

test('停在半路松手：收了一半以上就收完，否则全露出', () => {
  assert.equal(settle(30, 300, H), H);
  assert.equal(settle(20, 300, H), 0);
  assert.equal(settle(30, 40, H), 40);
});

test('内容区拉得越远伸得越多，但有上限、越拉越难拉', () => {
  assert.equal(stretchOf(0), 0);
  assert.equal(stretchOf(-10), 0);
  const near = stretchOf(200),
    far = stretchOf(400),
    farther = stretchOf(600);
  assert.ok(near > 0 && near < far && far < farther && farther < 0.08);
  assert.ok(far - near > farther - far);
});

type FakeBox = { scrollHeight: number; clientHeight: number; parentElement: FakeBox | null; overflowY: string };
const box = (parentElement: FakeBox | null, scrollHeight: number, clientHeight: number, overflowY = 'visible'): FakeBox => ({
  parentElement,
  scrollHeight,
  clientHeight,
  overflowY,
});
const page = { layerOpen: false, overflowY: (b: FakeBox) => b.overflowY };
/** 一根手指按在 target 上，算不算拉 main */
const pulls = (target: FakeBox, main: FakeBox, layerOpen = false) => pullsContent({ fingers: 1, target }, main, { ...page, layerOpen });

test('手指在内容区里自己能竖着滚的区域（文件列表、多行输入框）里时不拉伸内容区', () => {
  const main = box(null, 2000, 800),
    list = box(main, 600, 240, 'auto');
  assert.equal(pulls(box(list, 40, 40), main), false);
  assert.equal(pulls(box(main, 600, 240, 'scroll'), main), false);
});

test('内容没超出、不让滚的区域，或直接按在内容区上时照常拉伸', () => {
  const main = box(null, 2000, 800);
  assert.equal(pulls(box(box(main, 100, 240, 'auto'), 40, 40), main), true);
  assert.equal(pulls(box(main, 600, 240, 'hidden'), main), true);
  assert.equal(pulls(box(main, 40, 40), main), true);
});

test('开着弹层（“更多”菜单、筛选浮层的 DOM 也在内容区里）、按在内容区外或两根手指时不拉伸', () => {
  const main = box(null, 2000, 800),
    menuItem = box(box(main, 120, 120), 40, 40);
  assert.equal(pulls(menuItem, main, true), false);
  assert.equal(pulls(box(box(null, 900, 900), 40, 40), main), false);
  assert.equal(pullsContent({ fingers: 2, target: menuItem }, main, page), false);
});
