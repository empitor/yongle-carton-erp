import assert from 'node:assert/strict';
import test from 'node:test';
import { warnBeforeLeaving } from '../../src/admin/usePromptPresets.js';

test('提示词页有没保存的修改时离开页面要先问（新老浏览器都认的写法），保存或放弃以后不再问', () => {
  const page: Pick<Window, 'onbeforeunload'> = { onbeforeunload: null };
  warnBeforeLeaving(page, true);
  const handler = page.onbeforeunload;
  assert.ok(handler, '有没保存的修改：登记了离开提示');
  // 处理函数返回不是 null 的值，浏览器才弹“离开此页？”（Chrome、Edge 118 及更早不认 preventDefault）
  assert.notEqual(Reflect.apply(handler, page, []), null);
  warnBeforeLeaving(page, false);
  assert.equal(page.onbeforeunload, null, '保存或放弃以后：取消离开提示');
});
