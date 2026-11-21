// 流程类卡片（workflow-cards.ts）要看的命令参数：各命令的卡片看的是哪几项、怎么取。
// 命令完整的参数结构在 tools/ 下各自的定义里（注册表先按它校验）；这里只取卡片要用的字段，交给服务的照旧是原来那一份。
import { z } from 'zod';
import { AppError } from '../../core/index.js';
import type { Actor, Store } from '../../core/index.js';
import { OrderBatchService } from '../../operations/index.js';
import { fieldLabels } from '../../../shared/import/index.js';
import type { ImportCardItem } from '../order-import-card.js';
import { field, listField } from './result-fields.js';

/** 收件箱条目的文字在卡片上、收件箱列表里最多写几个字 */
export const INBOX_TEXT_CHARS = 200;
/** 识别结果字段的中文名（按字段名查，查不到写字段名） */
export const fieldNames: Record<string, string> = fieldLabels;
/** 模型给的识别任务编号（不是文字的当没给） */
export const taskIdOf = (a: unknown) => {
  const taskId = field(a, 'taskId');
  return typeof taskId === 'string' ? taskId : undefined;
};

/** 各命令的卡片要看的那几项（命令完整的参数结构在 tools/ 下各自的定义里，交给服务的照旧是原来那一份） */
const purchaseRef = z.looseObject({ id: z.number() });
const scheduleRow = z.looseObject({ row: z.number(), quantity: z.string(), dueDate: z.string().nullable().optional() });
export const exportView = z.looseObject({
  kind: z.string(),
  id: z.number(),
  expectedVersion: z.number(),
  templateId: z.string().optional(),
  purchases: z.array(purchaseRef).optional(),
  schedule: z.array(scheduleRow).optional(),
});
export const draftEditView = z.looseObject({
  taskId: z.string().optional(),
  operations: z
    .array(z.looseObject({ op: z.string(), lineId: z.string().optional(), field: z.string(), value: z.string().nullable() }))
    .optional(),
  customerId: z.number().optional(),
  line: z.number().optional(),
  productId: z.number().optional(),
  productCode: z.string().optional(),
  createNew: z.boolean().optional(),
});
export const importRequest = z.object({ taskId: z.string().optional(), workspaceIds: z.array(z.string()).optional() });
/** 正式导入卡片存下来的那几份（order-import-card.ts 的 importCard 写） */
const importCardItem: z.ZodType<ImportCardItem, ImportCardItem> = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  fileName: z.string(),
  content: z.string(),
  customerId: z.number().nullable(),
  productIds: z.array(z.number().nullable()),
  sameNameLines: z.array(z.string()),
});
export const storedImports = z.object({ imports: z.array(importCardItem) });
export const recognizeView = z.looseObject({ workspaceId: z.string(), force: z.boolean().optional() });

/** 合在一份订货单里的几张采购单；没合就是 id 那一张 */
export const mergedIds = (a: z.infer<typeof exportView>) => (a.purchases?.length ? a.purchases.map((p) => p.id) : [a.id]);

/** 合并导出订货单时，助手的到货安排按行号写；换成订货单里的行键再交给和人工同一个导出服务。 */
export function exportArgs(store: Store, raw: unknown, actor: Actor): unknown {
  if (!listField(raw, 'schedule')?.length) return raw;
  const args = exportView.parse(raw);
  const ids = mergedIds(args);
  const rows = new OrderBatchService(store).draft(ids, actor).rows;
  return {
    ...args,
    schedule: (args.schedule ?? []).map((s) => {
      const row = rows[s.row - 1];
      if (!row) throw new AppError('订货单没有第 ' + s.row + ' 行，请先用 order_batch.draft 看合并后的行。');
      return { rowKey: row.key, quantity: s.quantity, dueDate: s.dueDate };
    }),
  };
}
