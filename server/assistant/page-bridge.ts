import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../auth.js';
import { ImportError } from '../import/errors.js';
import { requirePermission } from '../business/management.js';
import {
  pageActionSchema,
  pageObserveSchema,
  pageSnapshotSchema,
} from '../../shared/assistant-page.js';
export type PageBridgeContext = {
  actor: Actor;
  binding: string;
  clientId?: string;
  threadId: string;
  requestId: string;
  check: () => Actor;
  signal: AbortSignal;
  onDispatched?: () => void;
  emit: (event: string, data: any) => void;
};
const resultSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string().max(1200),
  snapshot: pageSnapshotSchema.optional(),
});
export class AssistantPageBridge {
  private pending = new Map<
    string,
    {
      actorId: string;
      binding: string;
      clientId: string;
      threadId: string;
      requestId: string;
      finish: (result: z.infer<typeof resultSchema>) => void;
    }
  >();
  async call(name: string, raw: unknown, ctx: PageBridgeContext) {
    ctx.check();
    if (ctx.signal.aborted) throw new ImportError('页面请求已停止。', 409);
    if (!ctx.clientId || !ctx.binding)
      throw new ImportError('ERP页面桥接未连接，请在ERP网页中发起本轮聊天。', 409);
    const action = name === 'page.act' ? pageActionSchema.parse(raw) : undefined;
    if (action && !['navigate', 'scroll'].includes(action.action))
      requirePermission(ctx.check(), 'business:edit');
    const commandId = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.pending.delete(commandId);
        ctx.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        clean();
        reject(
          new ImportError(
            '页面操作已中断；可能已发生交互，继续前先核验，禁止盲目重放。',
            409,
            'uncertain-operation',
          ),
        );
      };
      const timer = setTimeout(() => {
        clean();
        reject(
          new ImportError(
            '未收到ERP页面反馈，不能认定业务成功；请重新观察并查询真实记录。',
            409,
            action ? 'uncertain-operation' : 'page-timeout',
          ),
        );
      }, 15000);
      ctx.signal.addEventListener('abort', abort, { once: true });
      this.pending.set(commandId, {
        actorId: ctx.actor.id,
        binding: ctx.binding,
        clientId: ctx.clientId!,
        threadId: ctx.threadId,
        requestId: ctx.requestId,
        finish: (result) => {
          clean();
          try {
            ctx.check();
            if (!result.ok) throw new ImportError(result.message, 409);
            resolve({
              ...result,
              commandId,
              status: action ? 'interaction' : 'observed',
              businessVerified: false,
              message:
                result.message +
                (action ? '。界面交互回执不代表业务提交成功，请通过records.get/原服务核验。' : ''),
            });
          } catch (e) {
            reject(e);
          }
        },
      });
      ctx.onDispatched?.();
      ctx.emit('page_command', {
        commandId,
        clientId: ctx.clientId,
        threadId: ctx.threadId,
        requestId: ctx.requestId,
        action,
        observe: action ? undefined : pageObserveSchema.parse(raw),
      });
    });
  }
  complete(raw: unknown, actor: Actor, binding: string) {
    const v = z
      .strictObject({
        commandId: z.string().uuid(),
        clientId: z.string().uuid(),
        threadId: z.string().uuid(),
        requestId: z.string().uuid(),
        result: resultSchema,
      })
      .parse(raw);
    if (JSON.stringify(v).length > 160000) throw new ImportError('页面反馈过大。', 413);
    const p = this.pending.get(v.commandId);
    if (
      !p ||
      p.actorId !== actor.id ||
      p.binding !== binding ||
      p.clientId !== v.clientId ||
      p.threadId !== v.threadId ||
      p.requestId !== v.requestId
    )
      throw new ImportError('页面命令已失效或不属于当前真实登录会话。', 403);
    p.finish(v.result);
    return { accepted: true };
  }
}
