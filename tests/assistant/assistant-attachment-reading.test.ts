// 助手读附件：附件直接放进用户这句话，模型自己看（server/assistant/chat/model-attachments.ts）。
// 各种类型怎么交给模型：图片发原图、TXT 和 CSV 发原文、PDF、Word、表格原样上传后按文件编号引用；DeepSeek 说文件失效时从原件重传。
// 上传留多久、快到期时续、附件删掉以后怎么办在 tests/assistant-model-chat.test.ts。模型用假 DeepSeek，不发真实请求。
import { sales } from '../../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { count } from '../../server/core/index.js';
import { assistantFixture } from '../support/assistant-fixture.js';
import { contentParts, httpError } from '../support/fake-deepseek.js';
import { imageFixture, pdfFixture, docxFixture, xlsxFixture } from '../support/import-fixtures.js';
import { isChatCall } from '../support/fake-deepseek-wire.js';
import { actor } from '../support/actor-fixture.js';

test('单图/多图/PDF/Word/Excel/CSV/TXT/WebP：图片发原图、文字发原文、文档原样上传后按文件编号引用，消息关联可核对', async () => {
  const f = assistantFixture([], { chat: () => ({ message: '已按附件内容回答。', toolCalls: [] }) });
  const { fake, manager, store } = f;
  try {
    const t = manager.create(actor),
      canvas = createCanvas(20, 10),
      files: [string, Buffer][] = [
        ['单图.jpg', imageFixture(true)],
        ['多图.png', imageFixture()],
        ['文档.pdf', await pdfFixture()],
        ['订单.docx', docxFixture()],
        ['纸板.xlsx', xlsxFixture()],
        ['数据.csv', Buffer.from('名称,数量\n虚构纸箱,7')],
        ['说明.txt', Buffer.from('附件正文：虚构验收317')],
        ['图片.webp', canvas.toBuffer('image/webp')],
      ];
    for (let i = 0; i < files.length; i += 4) {
      const batch = files.slice(i, i + 4),
        uploaded = [];
      for (const [name, b] of batch) uploaded.push(await manager.attachments.upload(t.id, b, name, randomUUID(), actor));
      const before = fake.calls.length;
      const r = await manager.chat(
        t.id,
        { requestId: randomUUID(), text: '阅读本批附件。', attachmentIds: uploaded.map((a) => a.id) },
        actor,
        's',
        () => {},
        () => actor,
      );
      const sent = fake.calls.slice(before);
      const chat = sent.find(isChatCall);
      assert.ok(chat);
      // 这一轮用户这句话：最后一条带内容块的用户消息
      const said = chat.body.messages.findLast((m) => m.role === 'user' && Array.isArray(m.content));
      assert.ok(said);
      const body = JSON.stringify(said);
      const message = r.messages.findLast((m) => m.role === 'user');
      assert.ok(message);
      assert.equal(message.attachments.length, 4);
      for (const [name, b] of batch) {
        assert(body.includes(name));
        if (/\.(png|jpe?g|webp)$/i.test(name)) assert(body.includes(b.toString('base64')), '图片发原图');
        else assert(!body.includes(b.toString('base64')), '文档、文字不放 base64');
      }
      const documents = batch.filter(([name]) => /\.(pdf|docx|xlsx)$/i.test(name));
      const uploads = sent.filter((c) => c.path === '/files' && c.method === 'POST');
      assert.equal(uploads.length, documents.length, '文档各上传一次');
      for (const [name, b] of documents)
        assert.deepEqual(uploads.find((u) => u.body.file?.name === name)?.body.file?.bytes, b, '原样上传');
      assert.equal(contentParts(said).filter((p) => p.type === 'file').length, documents.length, '按文件编号引用');
      assert.equal(r.pendingAttachments.length, 0);
      assert(r.messages.at(-1)?.text.includes('已按附件内容回答'));
    }
    assert(fake.chatCalls().some((c) => JSON.stringify(c.body).includes('附件正文：虚构验收317')), '文字原文内联');
    assert(fake.calls.every((c) => c.method !== 'DELETE'), '上传的文件留着，后面几轮接着看');
    assert.equal(sales(store).orders().length, 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM stock_movements'), 0);
  } finally {
    f.close();
  }
});

test('DeepSeek 说附件文件失效：只把点名的那份从本地原件重传、换上新编号再问一次；重传后还失效就报出是哪份；本地原件没了不重传', async () => {
  const f = assistantFixture([], { chat: () => ({ message: '好的。', toolCalls: [] }) });
  const { fake, manager, store } = f;
  const say = (thread: string, text: string, attachmentIds?: string[]) => f.say(thread, text, { attachmentIds });
  const chats = () => fake.chatCalls();
  const uploads = () => fake.calls.filter((c) => c.path === '/files' && c.method === 'POST').length;
  const sent = () => {
    const chat = chats().at(-1);
    assert.ok(chat);
    return chat.body.messages.flatMap(contentParts);
  };
  const fileIds = z.array(z.string());
  const sentFiles = () => fileIds.parse(sent().filter((p) => p.type === 'file').map((p) => p.file_id));
  const invalid = (id: string) =>
    httpError(400, { error: { message: 'file_ids do not exist or are not created under your account: ' + id } }).response();
  /** 最近一次上传拿到的编号（重传的那份） */
  const latest = () => {
    const id = [...fake.files.keys()].at(-1);
    assert.ok(id);
    return id;
  };
  try {
    const thread = manager.create(actor).id;
    const a = await manager.attachments.upload(thread, await pdfFixture(), '甲.pdf', randomUUID(), actor),
      b = await manager.attachments.upload(thread, await pdfFixture(), '乙.pdf', randomUUID(), actor);
    await say(thread, '看看这两份', [a.id, b.id]);
    const [fileA, fileB] = sentFiles();
    assert.equal(uploads(), 2);

    // 甲失效：只重传甲，乙照用原来的编号，原请求再发一次就成了；后面几轮接着用新的那份
    fake.next('/chat/completions', invalid(fileA));
    const ok = await say(thread, '再看看');
    assert.equal(ok.messages.at(-1)?.text, '好的。');
    assert.equal(uploads(), 3, '只重传失效的那一份');
    const [renewed, kept] = sentFiles();
    assert.ok(renewed !== fileA && renewed === latest(), '换上了新编号');
    assert.equal(kept, fileB);
    await say(thread, '还在吗');
    assert.deepEqual(sentFiles(), [renewed, fileB], '失效的那份记下了，不再用');
    assert.equal(uploads(), 3);

    // 重传以后还是失效：不再重传，报出是哪份，不循环
    const before = chats().length;
    fake.next('/chat/completions', invalid(renewed));
    fake.next('/chat/completions', () => invalid(latest()));
    await assert.rejects(say(thread, '再来'), /附件《甲\.pdf》在 DeepSeek 那边失效了，从原件重新上传以后还是用不了/);
    assert.equal(uploads(), 4, '一次请求里同一份只重传一次');
    assert.equal(chats().length - before, 2);

    // 乙失效、本地原件也没了：不重传，换成一句话再问
    store.db.prepare('UPDATE assistant_attachments SET bytes=NULL WHERE id=?').run(b.id);
    fake.next('/chat/completions', invalid(fileB));
    const gone = await say(thread, '乙呢');
    assert.equal(gone.messages.at(-1)?.text, '好的。');
    assert.equal(uploads(), 4, '原件没了不重传');
    assert.ok(!sentFiles().includes(fileB));
    assert.match(JSON.stringify(sent()), /附件《乙\.pdf》已经删掉了，看不到了/);
  } finally {
    f.close();
  }
});
