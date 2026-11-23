// 前端按结构认登录状态（src/ui/auth-state.ts 的 parseAuthState）：服务端各种登录状态下 GET /api/auth/state 的真实回答都要认得，
// 认不出时页面会当成服务不可用。:memory: 账号库、虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AuthManager } from '../server/accounts/index.js';
import { Store } from '../server/core/index.js';
import { parseAuthState } from '../src/ui/auth-state.js';
import { startHttp, userList } from './http-fixture.js';

const staffPassword = 'Fictional-staff-123';
const temporaryReply = z.object({ temporaryPassword: z.string() });

/** 这次的登录状态回答前端认得出 */
async function assertAccepted(label: string, reply: Response) {
  const body: unknown = await reply.json();
  assert.ok(parseAuthState(body), label + ' 的登录状态前端认不出：' + JSON.stringify(body));
}

test('登录状态的回答前端都认得：没建账号、没登录、管理员、超级管理员模式、四种级别、临时密码', async () => {
  const store = new Store(':memory:');
  const h = await startHttp(store, { admin: false });
  try {
    await assertAccepted('还没建账号', await h.send('/auth/state'));
    await h.setup();
    await assertAccepted('没登录', await h.send('/auth/state'));
    await assertAccepted('管理员', await h.send('/auth/state', undefined, h.cookie));
    await h.enterSuperMode();
    await assertAccepted('超级管理员模式', await h.send('/auth/state', undefined, h.cookie));
    for (const level of ['staff', 'viewer', 'finance', 'cashier']) {
      const name = '虚构' + level;
      const made = await h.send('/auth/users', { name, password: staffPassword, level }, h.cookie);
      assert.ok(made.ok, level + ' 建号失败：' + made.status);
      await assertAccepted(level, await h.send('/auth/state', undefined, await h.login(name, staffPassword)));
    }
    const staff = userList(z.record(z.string(), z.unknown()).parse(await (await h.send('/auth/users', undefined, h.cookie)).json()))
      .find((u) => u.name === '虚构staff');
    assert.ok(staff, '虚构staff 应该在账号列表里');
    const reset = await h.send('/auth/users/' + staff.id + '/password', {}, h.cookie);
    const { temporaryPassword } = temporaryReply.parse(await reset.json());
    await assertAccepted('临时密码', await h.send('/auth/state', undefined, await h.login('虚构staff', temporaryPassword)));
  } finally {
    await h.close();
    store.close();
  }
});

test('本机管理员的登录状态前端认得', async () => {
  const store = new Store(':memory:');
  const h = await startHttp(store, { auth: new AuthManager(':memory:', Date.now, { localAdministration: true }) });
  try {
    await assertAccepted('本机管理员', await h.send('/auth/state', undefined, h.cookie));
  } finally {
    await h.close();
    store.close();
  }
});
