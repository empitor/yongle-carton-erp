import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, actor } from './assistant-fixture.js';
import { pdfFixture, docxFixture, xlsxFixture } from './import-fixtures.js';
import type { AssistantAttachment } from '../shared/assistant-attachments.js';
test('DeepSeek官方不发送被忽略的input_file，PDF/Word/Excel按兼容文字发送，扫描PDF真实转图且原件保留', async () => {
  const f = assistantFixture();
  try {
    const v = f.settings.view(),
      p = v.active!;
    const n = f.settings.saveDraft({
      id: p.id,
      name: p.name,
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      apiStyle: 'responses',
      apiKey: 'sk-fictional-deepseek',
      expectedRevision: v.revision,
    });
    f.settings.activate({ id: p.id, expectedRevision: n.revision });
    const t = f.manager.create(actor),
      files: [string, Buffer][] = [
        ['订单.pdf', await pdfFixture()],
        ['扫描.pdf', await pdfFixture(true)],
        ['订单.docx', docxFixture()],
        ['订单.xlsx', xlsxFixture()],
      ],
      uploaded: AssistantAttachment[] = [];
    for (const [name, b] of files)
      uploaded.push(await f.manager.attachments.upload(t.id, b, name, randomUUID(), actor));
    assert.equal(uploaded[1].renderedPages, 1);
    assert(uploaded[0].textAvailable);
    f.replies.push(
      { message: '读取', toolCalls: [{ name: 'attachments.read', args: { question: '读附件' } }] },
      { message: '合计2850元。', toolCalls: [] },
      { message: '合计2850元。', toolCalls: [] },
    );
    const r = await f.manager.chat(
      t.id,
      {
        requestId: randomUUID(),
        text: '读附件',
        consent: true,
        profile: f.settings.view().active,
        attachmentIds: uploaded.map((a) => a.id),
      },
      actor,
      's',
      () => {},
      () => actor,
    );
    const body = JSON.stringify(
      f.requests.find((r) => JSON.stringify(r.body).includes('你是隔离的附件阅读器'))!.body,
    );
    assert(!body.includes('input_file'));
    assert(body.includes('input_image'));
    assert(body.includes('2850'));
    assert(r.messages[0].attachments.length === 4);
    assert.deepEqual(f.manager.attachments.file(uploaded[1].id, actor).bytes, files[1][1]);
    f.replies.push({
      message: '读取',
      toolCalls: [{ name: 'attachments.read', args: { question: '读附件' } }],
    });
    const failed = await f.manager.chat(
      t.id,
      {
        requestId: randomUUID(),
        text: '读附件',
        profile: f.settings.view().active,
        attachmentIds: [uploaded[0].id],
        attachmentTextMode: 'original',
      },
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.match(failed.messages.at(-1)!.text, /不支持文档/);
    assert.equal(
      f.requests.filter((r) => JSON.stringify(r.body).includes('你是隔离的附件阅读器')).length,
      1,
    );
  } finally {
    f.close();
  }
});
test('上传过程中清空/取消/退出账号，附件不会重新出现；取消后的上传凭据不能再保存', async () => {
  const f = assistantFixture();
  try {
    const t = f.manager.create(actor),
      id = randomUUID(),
      pending = f.manager.attachments.upload(t.id, docxFixture(), '测试.docx', id, actor);
    f.manager.attachments.cancelUpload(t.id, id, actor);
    await assert.rejects(() => pending, /移除/);
    assert.equal(f.manager.view(t.id, actor).pendingAttachments.length, 0);
    const second = f.manager.attachments.upload(
      t.id,
      xlsxFixture(),
      '测试.xlsx',
      randomUUID(),
      actor,
    );
    f.manager.clear(t.id, actor);
    await assert.rejects(() => second, /清空/);
    await assert.rejects(
      () =>
        f.manager.attachments.upload(
          t.id,
          Buffer.from('内容'),
          '说明.txt',
          randomUUID(),
          actor,
          () => null,
        ),
      /身份已变化/,
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assistant_attachments').get()!.n, 0);
  } finally {
    f.close();
  }
});
