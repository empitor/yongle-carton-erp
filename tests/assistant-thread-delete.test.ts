import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, actor } from './assistant-fixture.js';

const count = (f: ReturnType<typeof assistantFixture>, sql: string, ...params: any[]) =>
  Number(f.store.db.prepare(sql).get(...params)!.n);

test('删除会话会清理消息、附件、未执行方案和运行记录，并保留审计', () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      messageId = randomUUID(),
      attachmentId = randomUUID(),
      now = new Date().toISOString();
    f.store.db
      .prepare('INSERT INTO assistant_messages VALUES(?,?,?,?,?,?)')
      .run(messageId, t.id, 'user', '测试消息', '{}', now);
    f.store.db
      .prepare(
        'INSERT INTO assistant_attachments(id,thread_id,user_id,upload_id,name,size,mime,kind,sha256,metadata,bytes,extracted_text,image_pages,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
        'fictional-hash',
        '{}',
        null,
        null,
        null,
        now,
        null,
      );
    f.store.db
      .prepare('INSERT INTO assistant_message_attachments VALUES(?,?)')
      .run(messageId, attachmentId);
    f.store.db
      .prepare('INSERT INTO assistant_previews VALUES(?,?,?,?,?,?,?,NULL)')
      .run(randomUUID(), t.id, actor.id, 'binding', Date.now() + 60000, 'digest', '{}');
    f.store.db
      .prepare('INSERT INTO assistant_runs VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), t.id, actor.id, 'completed', '{}', now);

    f.manager.removeThread(t.id, actor);

    assert.throws(() => f.manager.view(t.id, actor), /不存在|不属于/);
    assert.equal(
      count(f, 'SELECT COUNT(*) n FROM assistant_threads WHERE id=?', t.id),
      0,
    );
    assert.equal(
      count(f, 'SELECT COUNT(*) n FROM assistant_messages WHERE thread_id=?', t.id),
      0,
    );
    assert.equal(
      count(f, 'SELECT COUNT(*) n FROM assistant_attachments WHERE thread_id=?', t.id),
      0,
    );
    assert.equal(
      count(f, 'SELECT COUNT(*) n FROM assistant_previews WHERE thread_id=?', t.id),
      0,
    );
    assert.equal(
      count(f, 'SELECT COUNT(*) n FROM assistant_runs WHERE thread_id=?', t.id),
      0,
    );
    assert.equal(
      count(
        f,
        "SELECT COUNT(*) n FROM assistant_audit WHERE thread_id=? AND tool='conversation.delete'",
        t.id,
      ),
      1,
    );
    assert.equal(
      f.manager.state(actor).threads.some((row: any) => row.id === t.id),
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
