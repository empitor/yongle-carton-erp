// 删除窗按查到的清单删除被拒时怎么接着办（src/recordkit/deletion-retry.ts，删除窗 DatabaseDeleteDialog.tsx 用它）：
// 服务端说“预览以后数据已变化”（类别 preview-changed）就按最新的重新查一遍、给一句提示，不让人对着旧清单一直点；别的拒绝照原话报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteOrRepreview, deletionChangedMessage } from '../src/recordkit/deletion-retry.js';

/** 照 src/ui/http.ts 请求被拒时抛的样子：带状态码、可能带类别的 Error */
const refused = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, code });

test('删除被拒、类别是“预览以后数据已变化”时：按最新的重新查一次清单，返回提示', async () => {
  let repreviewed = 0;
  const outcome = await deleteOrRepreview(
    () => Promise.reject(refused('预览以后数据已变化，请重新预览。', 409, 'preview-changed')),
    async () => {
      repreviewed++;
    },
  );
  assert.deepEqual(outcome, { notice: deletionChangedMessage });
  assert.equal(repreviewed, 1);
});

test('删除被拒的是别的原因（版本冲突）：照原话报出，不重新查清单', async () => {
  let repreviewed = 0;
  await assert.rejects(
    deleteOrRepreview(
      () => Promise.reject(refused('记录已被修改，请刷新后重试。', 409)),
      async () => {
        repreviewed++;
      },
    ),
    /记录已被修改，请刷新后重试。/,
  );
  assert.equal(repreviewed, 0);
});

test('删除办成：交回结果，不重新查清单', async () => {
  let repreviewed = 0;
  const outcome = await deleteOrRepreview(
    () => Promise.resolve({ count: 1 }),
    async () => {
      repreviewed++;
    },
  );
  assert.deepEqual(outcome, { done: { count: 1 } });
  assert.equal(repreviewed, 0);
});

test('删除被拒、按最新的重新查清单也没查成：不说“已换成最新的清单”，照查清单的出错报', async () => {
  await assert.rejects(
    deleteOrRepreview(
      () => Promise.reject(refused('预览以后数据已变化，请重新预览。', 409, 'preview-changed')),
      () => Promise.reject(new Error('虚构：会一起处理的记录读不出来')),
    ),
    /会一起处理的记录读不出来/,
  );
});
