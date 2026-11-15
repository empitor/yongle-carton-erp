/**
 * 正式导入记录（import_executions.document）里存的 JSON：导入回执连同当时的导入计划；
 * 订单被永久删除时还会记上是哪次删除（deletion.ts）。写入在 import-execution.ts、deletion.ts，
 * 读的地方按要用的几项从这份结构里挑（pick），用 parseStoredJson 读。
 */
import { z } from 'zod';

export const storedReceipt = z.object({
  executionId: z.string(),
  orderId: z.number(),
  orderNumber: z.string(),
  sourceId: z.string(),
  fileHash: z.string(),
  fileName: z.string(),
  sourcePath: z.string(),
  at: z.string(),
  actor: z.object({ id: z.string(), name: z.string() }),
  digest: z.string(),
  created: z.array(z.object({ entity: z.string(), id: z.number() })),
  orderVersion: z.number(),
  /** 导入时的计划（给审计和追溯看，读回来不再用，原样保留） */
  plan: z.unknown().optional(),
  /** 订单被永久删除：谁、什么时候、哪次删除（删除引擎给的标记，原样保留） */
  permanentDeletion: z.record(z.string(), z.unknown()).optional(),
});
export type StoredReceipt = z.infer<typeof storedReceipt>;
/** 删除时只给记录打标记：其余各项不认、原样写回 */
export const receiptForMarking = z.record(z.string(), z.unknown());
