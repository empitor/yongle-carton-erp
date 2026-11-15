// 助手的订单导入工作流：call() 分派（工具定义在 tools/order-import.ts）；实现在 order-import-*.ts。
// 正式导入不走 call()：出确认卡片、确认后执行，在 order-import-card.ts。
import { z } from 'zod';
import { requirePermission } from '../core/index.js';
import { attach, fromInbox, list, start } from './order-import-intake.js';
import { onTask } from './order-import-edits.js';
import { OrderImportState, type WorkflowContext } from './order-import-state.js';

/** 入口工具：不需要先有当前任务。 */
const intake = new Map<string, (wf: OrderImportState, args: Record<string, unknown>, ctx: WorkflowContext) => Promise<unknown>>([
  ['order_import.list', list],
  ['order_import.from_inbox', fromInbox],
  ['order_import.attach', attach],
  ['order_import.start', start],
]);

/** 持久任务只引用原工作区，不另建订单、库存或识别引擎。 */
export class AssistantOrderWorkflow extends OrderImportState {
  async call(name: string, raw: unknown, ctx: WorkflowContext): Promise<unknown> {
    requirePermission(ctx.check(), 'business:edit');
    const args = z.record(z.string(), z.unknown()).parse(raw);
    const handler = intake.get(name);
    if (handler) return handler(this, args, ctx);
    return onTask(this, name, args, ctx);
  }
}
