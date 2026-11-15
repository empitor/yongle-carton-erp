import { z } from 'zod';
import { storedScheduleEntrySchema } from '../business/index.js';
import { documentExportSchema, type DocumentFormat } from './business-export.js';
import type { DocumentKind } from './document-templates.js';
/*
 * 一份导出记录对外的样子（导出状态接口、助手的 exports.list 和 jobs.status）。服务端 server/documents/export-records.ts
 * 从 document_exports 的一行拼出来；不按列查的内容存在 options 列，写入和读出都按 exportOptionsSchema。
 */
const exportRequest = documentExportSchema.shape;
/** 订货单里每张采购单导出时的版本（交付完成时核对） */
const exportMember = z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() });
/** document_exports.options：导出请求里交付完成还要用的几项，加上导出那一刻的单据状态；订货单还有每张采购单的版本和到货安排 */
export const exportOptionsSchema = z.strictObject({
  markOrdered: z.boolean(),
  markShipped: z.boolean(),
  expectedVersion: exportRequest.expectedVersion,
  purchases: exportRequest.purchases,
  schedule: exportRequest.schedule,
  draft: z.boolean(),
  statusBefore: z.string(),
  members: z.array(exportMember).optional(),
  /** 订货单的到货安排：交付完成建批次时存进订货批次，和 order_batches.schedule 同一种写法 */
  scheduleEntries: z.array(storedScheduleEntrySchema).optional(),
});
export type ExportOptions = z.output<typeof exportOptionsSchema>;
/** 模板快照按导出那一刻的样子原样存、原样回（模板结构以后改了，旧快照照样读得出） */
export const templateSnapshotSchema = z.json();

/** 一份导出记录（不含文件内容） */
export type DocumentExport = ExportOptions & {
  kind: DocumentKind;
  /** 采购单或送货单的编号 */
  id: number;
  format: DocumentFormat;
  /** 导出请求编号（就是导出编号） */
  requestId: string;
  actorId: string;
  filename: string;
  sha256: string;
  size: number;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  /** 纸上印的实际送货日期（待送货的送货单导出出库时才有） */
  shipDate: string | null;
  templateId: string;
  templateRevision: number;
  templateSnapshot: z.output<typeof templateSnapshotSchema>;
  /** 文件内容过了保存期已清掉：再下载回 410，要这份文件就用新的请求号重新导出 */
  fileExpired: boolean;
  /** 只有订货单有：几张合并且还没建批次时先记下的订货单号 */
  batchNumber?: string | null;
};
/** 导出状态（导出、查状态、交付完成都回它）：导出记录加上单据现在的状态和交付进度，不含账号 */
export type DocumentExportStatus = Omit<DocumentExport, 'actorId'> & {
  exportId: string;
  /** 下载文件的地址 */
  url: string;
  businessStatus: string;
  deliveryStatus: 'completed' | 'delivered' | 'ready';
  verified: true;
  message: string;
};
