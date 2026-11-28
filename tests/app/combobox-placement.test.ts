// 可搜索下拉往上开还是往下开（src/ui/combobox-placement.ts）：窗口里靠下的下拉不能被正文滚动区截掉、被底栏盖住。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMBOBOX_LIST_MAX, opensUpward } from '../../src/ui/combobox-placement.js';

const area = { top: 94, bottom: 819 };

test('下面放得下列表就往下开', () => {
  assert.equal(opensUpward({ top: 200, bottom: 232 }, area), false);
  assert.equal(opensUpward({ top: 400, bottom: 400 + 32 }, area, COMBOBOX_LIST_MAX), false);
});

test('靠近正文底边、下面放不下而上面更宽敞时往上开（数据管理编辑窗最下面那格）', () => {
  // 截图里量到的：输入框 698-730，正文滚动区到 819，往下只剩 89px，列表要 260px
  assert.equal(opensUpward({ top: 698, bottom: 730 }, area), true);
});

test('上下都放不下、上面更窄时往下开', () => {
  assert.equal(opensUpward({ top: 150, bottom: 182 }, { top: 94, bottom: 400 }), false);
});

test('上面也放不下整张列表时往下开：往下被截掉的还能在滚动区里滚到，往上被截掉的滚不到（只有一两行的明细表）', () => {
  // 横向能滚动的明细表也会截掉列表；表格只有一行时，输入框上下都只剩十几像素，上面稍宽也不能往上开
  assert.equal(opensUpward({ top: 510, bottom: 542 }, { top: 480, bottom: 560 }), false);
  // 上面放得下整张列表才往上开
  assert.equal(opensUpward({ top: 400, bottom: 432 }, { top: 94, bottom: 500 }), true);
  assert.equal(opensUpward({ top: 300, bottom: 332 }, { top: 94, bottom: 500 }), false);
});
