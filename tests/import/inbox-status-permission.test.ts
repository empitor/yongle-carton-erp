// 收件箱改处理状态（POST /api/inbox/:id/status，server/inbox/router.ts）：先查权限再校验正文。
// 只读账号发格式不对的正文，回的是没权限（403），不是正文格式错（400）；有权限的账号发格式不对的正文才是 400。内存库、虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Store } from '../../server/core/index.js';
import { startHttp } from '../support/http-fixture.js';

const password = 'Fictional-viewer-123';

test('只读账号改收件状态、正文格式不对：回没权限；管理员同样的正文回格式错', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  try {
    await h.enterSuperMode();
    assert.equal((await h.send('/auth/users', { name: '虚构只读', password, level: 'viewer' }, h.cookie)).status, 201);
    const created = await h.send('/inbox', { text: '虚构收件' }, h.cookie);
    assert.equal(created.status, 201);
    const { id } = z.object({ id: z.number() }).parse(await created.json());
    const viewer = await h.login('虚构只读', password);
    const bad = { status: '不认识的状态' };
    const denied = await h.send('/inbox/' + id + '/status', bad, viewer);
    assert.equal(denied.status, 403);
    assert.equal((await h.send('/inbox/' + id + '/status', bad, h.cookie)).status, 400);
  } finally {
    await h.close();
    store.close();
  }
});
