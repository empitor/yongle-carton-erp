// AI 设置接口填写不合格时的说法：和全站一样按界面叫法说哪一栏不对，不露英文字段名。假 DeepSeek，内存库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/core/db.js';
import { listen, testProblems } from './http-fixture.js';
import { fakeDeepSeek, testProtector } from './fake-deepseek.js';

test('AI 设置提交不合格：回 400，按设置页的叫法说哪一栏不对，不带英文字段名', async () => {
  const m = new AiSettingsManager({ transport: fakeDeepSeek().transport, protector: testProtector }),
    store = new Store(':memory:'),
    server = await listen(createApp(store, { aiSettings: m, problems: testProblems() }));
  const post = async (path: string, body: unknown) => {
    const res = await fetch(server.origin + '/api/ai/settings' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': m.csrfToken },
      body: JSON.stringify(body),
    });
    const reply: unknown = await res.json();
    return { status: res.status, message: z.object({ message: z.string() }).parse(reply).message };
  };
  try {
    const unconfirmed = await post('/key/delete', { expectedRevision: 0 });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.message, /删除确认/);
    const tooMany = await post('/preferences', { recognitionConcurrency: 9, expectedRevision: 0 });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.message, /^同时识别文件数：/);
    assert.doesNotMatch(unconfirmed.message, /[A-Za-z]{4,}/);
  } finally {
    await server.close();
    m.close();
    store.close();
  }
});
