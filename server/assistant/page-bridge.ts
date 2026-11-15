// 看用户眼前的页面（page.observe）：服务器经聊天的事件流发一条“看一眼”的命令，浏览器把页面快照交回来。
// 只看不动：打开页面用 ui.open，改数据用业务工具。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import { AppError } from '../core/index.js';
import { pageObserveSchema, pageResultBody, type pageResultSchema } from '../../shared/assistant/index.js';

export type PageBridgeContext = {
  actor: Actor;
  binding: string;
  clientId?: string;
  threadId: string;
  requestId: string;
  check: () => Actor;
  signal: AbortSignal;
  emit: (event: string, data: unknown) => void;
};
/** 页面交回的整份反馈最多多少字 */
const PAGE_REPLY_CHARS = 160000;
type PageResult = z.infer<typeof pageResultSchema>;
/** 等浏览器交回快照最多等多久 */
const PAGE_REPLY_MS = 15000;

export class AssistantPageBridge {
  private pending = new Map<
    string,
    {
      actorId: string;
      binding: string;
      clientId: string;
      threadId: string;
      requestId: string;
      finish: (result: PageResult) => void;
    }
  >();
  async observe(raw: unknown, ctx: PageBridgeContext) {
    ctx.check();
    if (ctx.signal.aborted) throw new AppError('页面请求已停止。', 409);
    const clientId = ctx.clientId;
    if (!clientId || !ctx.binding) throw new AppError('这一轮没有连着 ERP 页面，看不到页面。', 409);
    const observe = pageObserveSchema.parse(raw);
    const commandId = randomUUID();
    return new Promise<PageResult & { commandId: string }>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.pending.delete(commandId);
        ctx.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        clean();
        reject(new AppError('页面请求已停止。', 409));
      };
      const timer = setTimeout(() => {
        clean();
        reject(new AppError('没有收到页面的反馈，这次没看到页面；要数据请直接查记录。', 409, 'page-timeout'));
      }, PAGE_REPLY_MS);
      ctx.signal.addEventListener('abort', abort, { once: true });
      this.pending.set(commandId, {
        actorId: ctx.actor.id,
        binding: ctx.binding,
        clientId,
        threadId: ctx.threadId,
        requestId: ctx.requestId,
        finish: (result) => {
          clean();
          try {
            ctx.check();
            if (!result.ok) throw new AppError(result.message, 409);
            resolve({ ...result, commandId });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      });
      ctx.emit('page_command', {
        commandId,
        clientId,
        threadId: ctx.threadId,
        requestId: ctx.requestId,
        observe,
      });
    });
  }
  complete(raw: unknown, actor: Actor, binding: string) {
    const v = pageResultBody.parse(raw);
    if (JSON.stringify(v).length > PAGE_REPLY_CHARS) throw new AppError('页面反馈过大。', 413);
    const p = this.pending.get(v.commandId);
    if (
      !p ||
      p.actorId !== actor.id ||
      p.binding !== binding ||
      p.clientId !== v.clientId ||
      p.threadId !== v.threadId ||
      p.requestId !== v.requestId
    )
      throw new AppError('页面命令已失效或不属于当前真实登录会话。', 403);
    p.finish(v.result);
    return { accepted: true };
  }
}
