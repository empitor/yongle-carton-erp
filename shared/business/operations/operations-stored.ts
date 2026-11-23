import { z } from 'zod';
import { stockItemSchema } from './operations.js';
import { scheduleEntrySchema, type ScheduleEntry } from './order-batch.js';

/*
 * 采购库存存进库的几列 JSON 内容（服务端 server/operations 写之前、读出来都按这里核对）：库存品的 document、
 * 订货单到货安排的每一段、库存流水修订记录的前后内容。单据导出存订货单的到货安排（shared/documents/export-record.ts）也按这里。
 */

/**
 * 库存品存进 document 列的内容：规格说明、长宽高、尺寸单位、材质、楞型、备注（名称、种类、单位、关联的产品存在列里）。
 * 字段照录入规则（stockItemSchema），多出的键算对不上。
 */
export const stockDocumentSchema = z
  .strictObject(stockItemSchema.shape)
  .omit({ name: true, kind: true, unit: true, productId: true });

/** 订货单到货安排的一段（order_batches.schedule 的一项）：合并行的依据、数量（千分整数）、截止日期（可空） */
export const storedScheduleEntrySchema = z.strictObject({
  rowKey: z.string(),
  quantityUnits: z.number().int().nonnegative(),
  dueDate: scheduleEntrySchema.shape.dueDate,
}) satisfies z.ZodType<ScheduleEntry>;

/** 流水修订记录里改写前、改写后的内容（before_document、after_document）：stock_movements 那一行的列和值，列名是库里的 */
export const movementColumnsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
