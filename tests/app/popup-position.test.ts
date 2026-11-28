// 浮在顶层的弹出列表怎么摆（src/ui/popup-position.ts）：“更多”菜单和可搜索下拉共用一套。
// 列表放进浏览器顶层、按触发它的元素在屏幕上的位置摆，不再被表格、窗口正文、详情面板截掉；这里测往哪边开、给多高、摆在哪。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { popupSide, popupSpot } from '../../src/ui/popup-position.js';

const screen = { top: 0, left: 0, right: 1280, bottom: 900 };
const field = (top: number, left = 100, width = 300) => ({ top, bottom: top + 32, left, right: left + width });

test('下面放得下就往下开，能给的高度是上下两边大的那个（扣掉 4px 间距和 8px 边距）', () => {
  assert.deepEqual(popupSide(field(200), 260, screen), { up: false, room: 900 - 232 - 12 });
});

test('下面放不下、上面更宽敞就往上开；上面也更窄就还是往下，限高后在列表里滚', () => {
  assert.deepEqual(popupSide(field(700), 260, screen), { up: true, room: 700 - 12 });
  // 只有一行的明细表也不再看表格：按整个屏幕算，下面放得下就往下整块显示
  assert.equal(popupSide(field(480), 260, screen).up, false);
  assert.deepEqual(popupSide(field(100), 800, screen), { up: false, room: 900 - 132 - 12 });
});

test('手机弹出键盘后只看还能看见的那段（visualViewport）：下面被键盘占了就往上开', () => {
  const visible = { top: 0, left: 0, right: 390, bottom: 420 };
  assert.equal(popupSide(field(330, 16, 358), 260, visible).up, true);
});

test('左对齐摆在输入框下面；伸出屏幕右边时往回收，不出界', () => {
  assert.deepEqual(popupSpot(field(200), { width: 280, height: 260 }, screen, false, 'start'), { left: 100, top: 236 });
  assert.deepEqual(popupSpot(field(200, 1100, 150), { width: 280, height: 260 }, screen, false, 'start'), { left: 1280 - 280 - 8, top: 236 });
  // 往上开：底边贴着输入框上沿留 4px
  assert.deepEqual(popupSpot(field(700), { width: 280, height: 260 }, screen, true, 'start'), { left: 100, top: 700 - 4 - 260 });
});

test('“更多”菜单照旧右对齐按钮；伸出屏幕左边时改成从按钮左边起；上下都不出界', () => {
  const button = { top: 140, bottom: 172, left: 1210, right: 1250 };
  assert.deepEqual(popupSpot(button, { width: 160, height: 241 }, screen, false, 'end'), { left: 1090, top: 176 });
  const leftEdge = { top: 140, bottom: 172, left: 20, right: 60 };
  assert.deepEqual(popupSpot(leftEdge, { width: 160, height: 241 }, screen, false, 'end'), { left: 20, top: 176 });
  assert.deepEqual(popupSpot({ top: 880, bottom: 900, left: 20, right: 60 }, { width: 160, height: 241 }, screen, false, 'end').top, 900 - 241 - 8);
});
