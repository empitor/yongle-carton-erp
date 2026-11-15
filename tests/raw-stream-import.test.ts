// 识别走流式：等模型时不动工作区，完整结束后才校验、一次保存；中途出错不存半份；本机推送只转发进度和结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docxFixture, xlsxFixture } from './import-fixtures.js';
import { createApp } from '../server/app.js';
import { listen } from './http-fixture.js';
import { Store } from '../server/core/db.js';
import { fakeKey, replyCutOff, replyNative } from './fake-deepseek.js';
import { filledForm, importWorkspace } from './order-import-fixture.js';
import type { AiProgress } from '../shared/ai/index.js';

test('等模型时不写识别结果，完整结束后才校验并一次保存，进度只报字数', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const f = importWorkspace(async () => {
    entered();
    await gate;
    return filledForm();
  });
  try {
    let w = await f.upload(xlsxFixture(), '订单.xlsx');
    const progress: AiProgress[] = [];
    const pending = f.manager.analyze(w.id, { expectedRevision: w.revision }, (p) => progress.push(p));
    await started;
    assert.equal(f.manager.get(w.id).draft, null);
    assert.equal(f.manager.get(w.id).revision, w.revision);
    release();
    w = await pending;
    assert.ok(w.evaluation);
    assert.equal(w.evaluation.totalAmount, '2850.00');
    assert.ok(progress.some((p) => p.receivedChars > 0));
    assert.ok(!JSON.stringify(progress).includes('header'));
    assert.ok(w.draft);
    assert.equal(w.draft.header.buyerName.certainty, 'recognized');
    assert.equal(w.revision, 1, '识别只存一次');
  } finally {
    f.close();
  }
});

test('流提前断开、模型拒答都不保存半份结果，工作区修订号不变', async () => {
  const replies = [replyCutOff(JSON.stringify(filledForm())), replyNative({ content: JSON.stringify(filledForm()), finish: 'stop', refusal: '图片未通过审核' })];
  const f = importWorkspace(() => replies.shift());
  try {
    const w = await f.upload(docxFixture(), '订单.docx');
    for (let i = 0; i < 2; i++) {
      await assert.rejects(f.manager.analyze(w.id, { expectedRevision: w.revision }));
      assert.equal(f.manager.get(w.id).draft, null);
    }
    assert.equal(f.manager.get(w.id).revision, w.revision);
    assert.equal(f.fake.chatCalls().length, 2, '两种失败各一次，没有自动重发');
  } finally {
    f.close();
  }
});

test('本机识别地址推送进度和最终结果；出错推 error、不带密钥，也不存半份', async () => {
  let fail = false;
  const f = importWorkspace(() => (fail ? { potential_secret: fakeKey } : filledForm())),
    store = new Store(':memory:'),
    server = await listen(createApp(store, { aiSettings: f.settings, imports: f.manager }));
  try {
    const url = server.origin + '/api/ai/imports';
    for (const [index, bytes] of [docxFixture(), xlsxFixture()].entries()) {
      const w = await f.upload(bytes, index ? 'bad.xlsx' : 'ok.docx');
      fail = index === 1;
      const res = await fetch(url + '/' + w.id + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': f.settings.csrfToken },
        body: JSON.stringify({ expectedRevision: w.revision, stream: true }),
      });
      const contentType = res.headers.get('content-type');
      assert.ok(contentType);
      assert.match(contentType, /event-stream/);
      const text = await res.text();
      assert.ok(text.includes('event: progress'));
      assert.ok(!text.includes(fakeKey));
      assert.equal(text.includes('event: result'), !fail);
      assert.equal(text.includes('event: error'), fail);
      assert.equal(!!f.manager.get(w.id).draft, !fail);
    }
    assert.equal(store.orders().length, 0);
  } finally {
    // 关服务前断开保活连接，免得关不掉
    server.server.closeAllConnections();
    await server.close();
    store.close();
    f.close();
  }
});
