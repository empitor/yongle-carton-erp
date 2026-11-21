// 启动时收尾进程中断留下的轮（server/assistant/chat/finish-run.ts 的 recoverRuns）：一个会话读不出来，只记一行日志，别的会话照常收尾。
// 内存库、虚构数据。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RESTARTED_TEXT, recoverRuns } from '../server/assistant/chat/finish-run.js';
import { assistantFixture } from './assistant-fixture.js';
import { actor } from './actor-fixture.js';

test('启动时收尾停在半路的轮：一个会话的消息读不出来，只记一行带会话编号的日志，别的会话照常收尾', () => {
  const f = assistantFixture();
  const errors = mock.method(console, 'error', () => {});
  try {
    const { manager, store } = f;
    const broken = manager.create(actor).id,
      fine = manager.create(actor).id;
    const now = new Date().toISOString();
    // 坏的那个会话：上一条回复的 document 不合结构（facts 不是对象）
    store.db
      .prepare('INSERT INTO assistant_messages(id,thread_id,role,created_at,text,document) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), broken, 'assistant', now, '虚构的上一条回复', JSON.stringify({ facts: '坏的' }));
    for (const id of [broken, fine]) {
      manager.conversations.message(id, 'user', '虚构的问题');
      store.db
        .prepare('INSERT INTO assistant_runs(id,thread_id,user_id,state,document,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), id, actor.id, 'running', '{}', now);
    }
    recoverRuns(store, manager.conversations, manager.previews);
    const state = (id: string) => store.db.prepare('SELECT state FROM assistant_runs WHERE thread_id=?').get(id)?.state;
    assert.equal(state(fine), 'failed', '好的会话照常收尾');
    assert.equal(manager.view(fine, actor).messages.at(-1)?.text, RESTARTED_TEXT);
    assert.equal(state(broken), 'running', '读不出来的会话留着，不半截收尾');
    const logged = errors.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes(broken));
    assert.equal(logged.length, 1, '日志里写明是哪个会话');
  } finally {
    errors.mock.restore();
    f.close();
  }
});
