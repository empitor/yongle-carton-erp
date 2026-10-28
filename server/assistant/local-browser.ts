import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Dialog,
} from 'playwright-core';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Actor } from '../auth.js';
import { ImportError } from '../import/errors.js';
import { requirePermission } from '../business/management.js';
import { browserActionSchema } from '../../shared/assistant-browser.js';
import { isErpNavigation } from '../../shared/assistant-navigation.js';
const privateSelector =
  '.global-assistant,.oi-account,.auth-form,.ai-secret-input,[data-agent-private],input[type=password],input[autocomplete*=password],input[name*=secret i],input[name*=token i],input[name*=key i]';
const digest = (v: Buffer) => createHash('sha256').update(v).digest('hex');
type Owner = {
  actor: Actor;
  binding: string;
  origin: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  dialog?: Dialog;
  frame?: { id: string; hash: string; route: string; bytes: Buffer; at: number };
};
export class AssistantLocalBrowser {
  private owner?: Owner;
  constructor(private options: { executablePath?: string; headless?: boolean } = {}) {}
  executable() {
    return [
      this.options.executablePath,
      process.env.ERP_BROWSER_EXECUTABLE,
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].find((p) => p && existsSync(p));
  }
  ready(actor?: Actor | null) {
    return (
      !!this.owner && !this.owner.page.isClosed() && (!actor || this.owner.actor.id === actor.id)
    );
  }
  status(actor: Actor, binding: string) {
    return {
      installed: !!this.executable(),
      connected:
        !!this.owner &&
        !this.owner.page.isClosed() &&
        this.owner.actor.id === actor.id &&
        this.owner.binding === binding,
      scope: '独立本机ERP浏览器；真实当前会话；只访问本实例；不控制其他浏览器或Windows',
    };
  }
  async connect(actor: Actor, binding: string, origin: string, cookie: string, route: string) {
    const base = new URL(origin);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      !binding ||
      !/^[a-f0-9]{64}$/.test(cookie) ||
      !isErpNavigation(route)
    )
      throw new ImportError('浏览器连接必须来自当前本机ERP登录会话。', 403);
    const executablePath = this.executable();
    if (!executablePath)
      throw new ImportError(
        '未找到可用Chrome/Edge，请安装浏览器或配置ERP_BROWSER_EXECUTABLE。',
        503,
      );
    if (this.owner && !this.owner.page.isClosed() && this.owner.actor.id !== actor.id)
      throw new ImportError('另一登录用户正在使用可控浏览器，请先由该用户断开。', 409);
    await this.close();
    const browser = await chromium.launch({
      executablePath,
      headless: this.options.headless === true,
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
    });
    try {
      await context.addCookies([
        {
          name: 'erp_session',
          value: cookie,
          url: base.origin,
          httpOnly: true,
          sameSite: 'Strict',
          secure: base.protocol === 'https:',
        },
      ]);
      await context.route('**/*', (r) => {
        try {
          return new URL(r.request().url()).origin === base.origin ? r.continue() : r.abort();
        } catch {
          return r.abort();
        }
      });
      const page = await context.newPage();
      await page.goto(base.origin + '/' + route);
      const actual = await page.evaluate(async () => {
        const r = await fetch('/api/auth/state');
        return (await r.json()).actor;
      });
      if (
        actual?.id !== actor.id ||
        actual.role !== actor.role ||
        JSON.stringify(actual.permissions) !== JSON.stringify(actor.permissions) ||
        !!actual.localAdministrator !== !!actor.localAdministrator
      )
        throw new ImportError('浏览器中的真实登录身份或权限不一致。', 403);
      const owner: Owner = { actor, binding, origin: base.origin, browser, context, page };
      page.on('dialog', (dialog) => {
        owner.dialog = dialog;
      });
      context.on('page', (other) => {
        if (other !== page) void other.close();
      });
      this.owner = owner;
      return this.status(actor, binding);
    } catch (e) {
      await browser.close();
      throw e;
    }
  }
  private async checked(actor: Actor, binding: string, check: () => Actor) {
    const o = this.owner;
    if (
      !o ||
      o.page.isClosed() ||
      o.actor.id !== actor.id ||
      o.binding !== binding ||
      check().id !== actor.id
    )
      throw new ImportError('本地ERP浏览器未连接当前真实会话。', 409);
    if (new URL(o.page.url()).origin !== o.origin)
      throw new ImportError('浏览器已离开当前ERP实例。', 403);
    const actual = o.dialog
      ? actor.id
      : await o.page.evaluate(async () => {
          const r = await fetch('/api/auth/state');
          return (await r.json()).actor?.id;
        });
    if (actual !== actor.id) {
      await this.close();
      throw new ImportError('本地浏览器登录已失效。', 403);
    }
    return o;
  }
  private screenshot(o: Owner) {
    return o.page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      mask: [o.page.locator(privateSelector)],
      maskColor: '#202b35',
    });
  }
  async capture(actor: Actor, binding: string, check: () => Actor) {
    const o = await this.checked(actor, binding, check);
    if (o.dialog)
      return {
        frameId: o.frame?.id,
        dialog: { type: o.dialog.type(), message: o.dialog.message() },
        message: '浏览器正在显示真实确认框；先处理确认框。',
      };
    const bytes = await this.screenshot(o),
      id = randomUUID();
    o.frame = { id, hash: digest(bytes), route: o.page.url(), bytes, at: Date.now() };
    return {
      frameId: id,
      route: new URL(o.page.url()).hash,
      width: 1280,
      height: 900,
      imageAvailable: true,
      message: '真实ERP视区截图；敏感区域已遮盖。',
    };
  }
  image(frameId: string, actor: Actor, binding: string) {
    const o = this.owner;
    if (!o || o.actor.id !== actor.id || o.binding !== binding || o.frame?.id !== frameId)
      throw new ImportError('截图不属于当前会话。', 403);
    return 'data:image/png;base64,' + o.frame.bytes.toString('base64');
  }
  async act(
    raw: unknown,
    actor: Actor,
    binding: string,
    check: () => Actor,
    file?: (id: string) => { bytes: Buffer; name: string; mime: string },
  ) {
    const a = browserActionSchema.parse(raw),
      o = await this.checked(actor, binding, check);
    if (a.action !== 'scroll') requirePermission(check(), 'business:edit');
    if (!o.frame || o.frame.id !== a.frameId || Date.now() - o.frame.at > 120000)
      throw new ImportError('截图引用已失效，请重新截图。', 409);
    if (a.action === 'dialog') {
      if (!o.dialog || o.dialog.type() === 'prompt')
        throw new ImportError('没有可处理的普通确认框，不能自动填写凭据。', 409);
      const dialog = o.dialog;
      o.dialog = undefined;
      if (a.accept) await dialog.accept();
      else await dialog.dismiss();
      return this.capture(actor, binding, check);
    }
    if (o.dialog)
      return {
        frameId: o.frame.id,
        dialog: { type: o.dialog.type(), message: o.dialog.message() },
        message: '请先处理浏览器确认框。',
      };
    if (o.frame.route !== o.page.url() || o.frame.hash !== digest(await this.screenshot(o)))
      throw new ImportError('页面图像已变化，请重新截图定位。', 409);
    const x = a.x,
      y = a.y;
    if (x !== undefined && y !== undefined) {
      if (x >= 1280 || y >= 900) throw new ImportError('坐标不在当前ERP视区。');
      const secret = await o.page.evaluate(
        ({ x, y, selector }) => !!document.elementFromPoint(x, y)?.closest(selector),
        { x, y, selector: privateSelector },
      );
      if (secret) throw new ImportError('不能操作密码、密钥或认证区域。', 403);
    }
    const focusedPrivate = await o.page.evaluate(
      (selector) => !!document.activeElement?.closest(selector),
      privateSelector,
    );
    if (['type', 'key'].includes(a.action) && focusedPrivate)
      throw new ImportError('不能向敏感区域输入。', 403);
    if (a.action === 'click') {
      if (x === undefined || y === undefined) throw new ImportError('需要截图中的实际坐标。');
      // 原生确认框会暂停事件，保留真实dialog供下一步处理，不视为成功提交。
      await Promise.race([o.page.mouse.click(x, y), new Promise((r) => setTimeout(r, 300))]);
    } else if (a.action === 'type') {
      if (a.text === undefined) throw new ImportError('缺少普通输入内容。');
      await o.page.keyboard.insertText(a.text);
    } else if (a.action === 'key') {
      if (!a.key) throw new ImportError('缺少受支持的按键。');
      await o.page.keyboard.press(a.key);
    } else if (a.action === 'scroll') await o.page.mouse.wheel(0, a.deltaY || 0);
    else if (a.action === 'upload') {
      if (!file || !a.attachmentId || x === undefined || y === undefined)
        throw new ImportError('请选择当前聊天附件及真实上传控件。');
      const original = file(a.attachmentId);
      const handle = await o.page.evaluateHandle(
        ({ x, y }) => {
          const e = document.elementFromPoint(x, y);
          return e instanceof HTMLInputElement && e.type === 'file'
            ? e
            : e?.closest('label')?.control instanceof HTMLInputElement
              ? (e.closest('label') as HTMLLabelElement).control
              : null;
        },
        { x, y },
      );
      const direct = handle.asElement();
      if (direct) {
        await direct.setInputFiles({
          name: original.name,
          mimeType: original.mime,
          buffer: original.bytes,
        });
        await handle.dispose();
        return this.capture(actor, binding, check);
      }
      await handle.dispose();
      const pending = o.page.waitForEvent('filechooser', { timeout: 5000 });
      await o.page.mouse.click(x, y);
      await (
        await pending
      ).setFiles({ name: original.name, mimeType: original.mime, buffer: original.bytes });
    }
    check();
    await o.page.waitForTimeout(120);
    return this.capture(actor, binding, check);
  }
  async close() {
    const o = this.owner;
    this.owner = undefined;
    if (o) await o.browser.close();
  }
}
