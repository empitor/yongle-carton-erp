// 删会话（manager.removeThread）：清掉这个会话的消息、附件、没执行的卡片和运行记录，审计留着；只能删自己的。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { count as countRows } from '../server/core/index.js';
import { assistantFixture } from './assistant-fixture.js';
import { actor } from './actor-fixture.js';

const count = (f: ReturnType<typeof assistantFixture>, sql: string, ...params: SQLInputValue[]) =>
  countRows(f.store.db, sql, ...params);

test('删除会话会清理消息、附件、未执行方案和运行记录，并保留审计', () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      messageId = randomUUID(),
      attachmentId = randomUUID(),
      now = new Date().toISOString();
    f.store.db
      .prepare('INSERT INTO assistant_messages(id,thread_id,role,text,document,created_at) VALUES(?,?,?,?,?,?)')
      .run(messageId, t.id, 'user', '测试消息', '{}', now);
    f.store.db
      .prepare(
        'INSERT INTO assistant_attachments(id,thread_id,user_id,upload_id,name,size,mime,kind,sha256,metadata,bytes,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        attachmentId,
        t.id,
        actor.id,
        randomUUID(),
        '测试.txt',
        4,
        'text/plain',
        'text',
        // 虚构的摘要：库里要求是 64 位十六进制
        'f'.repeat(64),
        '{}',
        null,
        now,
        null,
      );
    f.store.db
      .prepare('INSERT INTO assistant_message_attachments(message_id,attachment_id) VALUES(?,?)')
      .run(messageId, attachmentId);
    f.store.db
      .prepare('INSERT INTO assistant_previews(id,thread_id,user_id,session_binding,expires_at,digest,document,result) VALUES(?,?,?,?,?,?,?,NULL)')
      .run(randomUUID(), t.id, actor.id, 'binding', Date.now() + 60000, 'digest', '{}');
    f.store.db
      .prepare('INSERT INTO assistant_runs(id,thread_id,user_id,state,document,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), t.id, actor.id, 'completed', '{}', now);

    f.manager.removeThread(t.id, actor);

    assert.throws(() => f.manager.view(t.id, actor), /不存在|不属于/);
    assert.equal(
      count(f, 'SELECT COUNT(*) n FROM assistant_threads WHERE id=?', t.id),
      0,
    );
    for (const table of ['assistant_messages', 'assistant_attachments', 'assistant_previews', 'assistant_runs'])
      assert.equal(count(f, 'SELECT COUNT(*) n FROM ' + table + ' WHERE thread_id=?', t.id), 0, table);
    assert.equal(
      count(
        f,
        "SELECT COUNT(*) n FROM assistant_audit WHERE thread_id=? AND tool='conversation.delete'",
        t.id,
      ),
      1,
    );
    assert.equal(
      f.manager.state(actor).threads.some((row) => row.id === t.id),
      false,
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('其他账号不能删除他人会话，重复删除返回不存在', () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor);
    assert.throws(
      () => f.manager.removeThread(t.id, { ...actor, id: 'other-user' }),
      /不存在|不属于/,
    );
    f.manager.removeThread(t.id, actor);
    assert.throws(() => f.manager.removeThread(t.id, actor), /不存在|不属于/);
  } finally {
    f.close();
  }
});

