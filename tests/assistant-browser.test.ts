import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { AssistantLocalBrowser } from '../server/assistant/local-browser.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { assistantFixture } from './assistant-fixture.js';
import { AssistantManager } from '../server/assistant/manager.js';

test('G：真实本地浏览器截图、视觉坐标点击Canvas、键盘和附件上传；密钥遮盖、快照失效与账号隔离', async () => {
  const f = assistantFixture(),
    auth = new AuthManager(':memory:', Date.now, { localAdministration: true });
  const browser = new AssistantLocalBrowser({ headless: true });
  const manager = new AssistantManager(f.store, f.settings, f.prompts, { browser });
  // 此项验证真实浏览器传输与原业务接口，不依赖先生成正式前端bundle。
  const app = express();
  app.get('/', (_req, res) =>
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>ERP浏览器回归</title>'),
  );
  app.use(createApp(f.store, { auth, assistant: manager, aiSettings: f.settings }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port,
    base = 'http://127.0.0.1:' + port,
    oldPort = process.env.PORT;
  process.env.PORT = String(port);
  try {
    const response = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构浏览器用户', password: 'fictional-browser-only-2026' }),
    });
    assert.equal(response.status, 200);
    const who = (await response.json()).actor;
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const headers = {
      'Content-Type': 'application/json',
      'X-ERP-Auth-Token': auth.csrf,
      Cookie: cookie,
    };
    const connect = await fetch(base + '/api/assistant/browser/connect', {
      method: 'POST',
      headers,
      body: JSON.stringify({ route: '#customers' }),
    });
    assert.equal(connect.status, 200, await connect.clone().text());
    assert.equal((await connect.json()).connected, true);
    const binding = auth.sessionBinding({ headers: { cookie } } as any);
    const page = (browser as any).owner.page;
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      const root = document.createElement('section');
      root.style.cssText =
        'position:fixed;top:80px;left:250px;width:500px;height:350px;background:white;z-index:9999';
      root.innerHTML =
        '<canvas id="visual-fixture" width="180" height="100"></canvas><div class="ai-secret-input"><input id="private-fixture" value="fictional-sensitive-marker"></div><input id="typing-fixture"><input id="upload-fixture" type="file">';
      document.body.append(root);
      const c = document.querySelector<HTMLCanvasElement>('#visual-fixture')!;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'green';
      ctx.fillRect(0, 0, 180, 100);
      c.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        const state = await (await fetch('/api/auth/state')).json();
        await fetch('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': state.csrf },
          body: JSON.stringify({ name: '虚构Canvas创建客户' }),
        });
        ctx.fillStyle = 'blue';
        ctx.fillRect(0, 0, 180, 100);
      });
    });
    let shot: any = await browser.capture(who, binding, () => who);
    const url = browser.image(shot.frameId, who, binding),
      bytes = Buffer.from(url.split(',')[1], 'base64');
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    const box = await page.locator('#private-fixture').boundingBox();
    const img = await loadImage(bytes),
      canvas = createCanvas(img.width, img.height),
      ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    assert.deepEqual(
      Array.from(
        ctx.getImageData(
          Math.floor(box.x + box.width / 2),
          Math.floor(box.y + box.height / 2),
          1,
          1,
        ).data,
      ),
      [32, 43, 53, 255],
    );
    await assert.rejects(
      () =>
        browser.act(
          {
            action: 'click',
            frameId: shot.frameId,
            x: Math.floor(box.x + 5),
            y: Math.floor(box.y + 5),
          },
          who,
          binding,
          () => who,
        ),
      /敏感|密钥/,
    );
    await assert.rejects(
      () => browser.capture({ ...who, id: 'other' }, binding, () => ({ ...who, id: 'other' })),
      /会话/,
    );
    await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#visual-fixture')!;
      c.getContext('2d')!.fillStyle = 'red';
      c.getContext('2d')!.fillRect(0, 0, 180, 100);
    });
    await assert.rejects(
      () =>
        browser.act(
          { action: 'click', frameId: shot.frameId, x: 300, y: 110 },
          who,
          binding,
          () => who,
        ),
      /图像已变化/,
    );
    shot = await browser.capture(who, binding, () => who);
    shot = await browser.act(
      { action: 'click', frameId: shot.frameId, x: 300, y: 110 },
      who,
      binding,
      () => who,
    );
    assert(f.store.customers().some((c) => c.name === '虚构Canvas创建客户'));
    const input = await page.locator('#typing-fixture').boundingBox();
    shot = await browser.act(
      {
        action: 'click',
        frameId: shot.frameId,
        x: Math.floor(input.x + 10),
        y: Math.floor(input.y + 10),
      },
      who,
      binding,
      () => who,
    );
    shot = await browser.act(
      { action: 'type', frameId: shot.frameId, text: '虚构键盘输入' },
      who,
      binding,
      () => who,
    );
    assert.equal(await page.locator('#typing-fixture').inputValue(), '虚构键盘输入');
    const upload = await page.locator('#upload-fixture').boundingBox();
    const source = Buffer.from('fictional-upload-only');
    shot = await browser.act(
      {
        action: 'upload',
        frameId: shot.frameId,
        x: Math.floor(upload.x + 10),
        y: Math.floor(upload.y + 10),
        attachmentId: '00000000-0000-4000-8000-000000000001',
      },
      who,
      binding,
      () => who,
      () => ({ bytes: source, name: '虚构原件.txt', mime: 'text/plain' }),
    );
    assert.equal(
      await page.locator('#upload-fixture').evaluate((e: HTMLInputElement) => e.files![0].name),
      '虚构原件.txt',
    );
    assert(manager.registry.exposed(who).some((t) => t.name === 'browser.capture'));
    const thread = manager.create(who);
    f.replies.push(
      {
        status: 'working',
        message: '读取当前真实视区',
        toolCalls: [{ name: 'browser.capture', args: {} }],
      },
      { status: 'completed', message: '已看到实际ERP视区', toolCalls: [] },
    );
    await manager.chat(
      thread.id,
      f.input('观察当前页面', crypto.randomUUID()),
      who,
      binding,
      () => {},
      () => who,
    );
    assert(
      f.requests.some((r) => JSON.stringify(r.body).includes('data:image/png;base64,')),
      '真实PNG应发送给控制模型，而非只有文字截图标记',
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) n FROM assistant_messages WHERE document LIKE '%data:image/png;base64,%'",
        )
        .get()!.n,
      0,
      'PNG不写入聊天业务回执',
    );
    const proxied = await fetch(base + '/api/assistant/browser/connect', {
      method: 'POST',
      headers: { ...headers, 'X-Forwarded-For': '10.0.0.1' },
      body: JSON.stringify({ route: '#customers' }),
    });
    assert.equal(proxied.status, 403);

    await fetch(base + '/api/auth/logout', { method: 'POST', headers });
    await assert.rejects(() => browser.capture(who, binding, () => who), /登录已失效/);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    manager.registry.close();
    f.close();
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
  }
});
