import { z } from 'zod';
import { isErpNavigation } from './assistant-navigation.js';
// 看页面用 page.observe：只看不动（标题、正文、表格、弹窗、提示、当前选中的记录）。
// 打开页面用 ui.open；点击、填写、滚动都没有：每件事都有直接的业务命令。

/** 页面快照和看页面命令的上限（字数、条数），页面交回的快照超了就拒收 */
const PAGE_LIMITS = {
  moduleChars: 60,
  tableIndex: 100,
  offset: 50000,
  tableRows: 32,
  routeChars: 500,
  capturedAtChars: 40,
  labelChars: 300,
  textChars: 16000,
  selected: 60,
  dialogChars: 500,
  dialogs: 12,
  cellChars: 400,
  columns: 24,
  tables: 5,
  feedbackChars: 1000,
  feedback: 12,
} as const;
const observeModes = ['summary', 'region', 'record', 'full'] as const;
const recordId = z.number().int().positive();

export const pageObserveSchema = z.strictObject({
  mode: z.enum(observeModes).default('summary'),
  region: z.enum(['main', 'dialog', 'navigation', 'form', 'table']).optional(),
  record: z
    .strictObject({ module: z.string().max(PAGE_LIMITS.moduleChars), id: recordId })
    .optional(),
  tableIndex: z.number().int().min(0).max(PAGE_LIMITS.tableIndex).default(0),
  offset: z.number().int().min(0).max(PAGE_LIMITS.offset).default(0),
  limit: z.number().int().min(1).max(PAGE_LIMITS.tableRows).optional(),
});
export type PageObserveOptions = z.input<typeof pageObserveSchema>;
export const pageSnapshotSchema = z.strictObject({
  route: z.string().max(PAGE_LIMITS.routeChars).refine(isErpNavigation),
  capturedAt: z.string().max(PAGE_LIMITS.capturedAtChars),
  title: z.string().max(PAGE_LIMITS.labelChars),
  text: z.string().max(PAGE_LIMITS.textChars),
  selected: z.array(z.string().max(PAGE_LIMITS.labelChars)).max(PAGE_LIMITS.selected),
  dialogs: z.array(z.string().max(PAGE_LIMITS.dialogChars)).max(PAGE_LIMITS.dialogs),
  tables: z
    .array(z.array(z.array(z.string().max(PAGE_LIMITS.cellChars)).max(PAGE_LIMITS.columns)).max(PAGE_LIMITS.tableRows))
    .max(PAGE_LIMITS.tables),
  feedback: z.array(z.string().max(PAGE_LIMITS.feedbackChars)).max(PAGE_LIMITS.feedback),
  record: z
    .strictObject({
      module: z.string().max(PAGE_LIMITS.moduleChars),
      id: recordId,
      label: z.string().max(PAGE_LIMITS.labelChars).optional(),
    })
    .optional(),
  truncated: z.boolean(),
  mode: z.enum(observeModes).optional(),
  tablesPage: z
    .array(
      z.strictObject({
        index: z.number().int(),
        totalRows: z.number().int(),
        offset: z.number().int(),
        limit: z.number().int(),
        hasMore: z.boolean(),
      }),
    )
    .max(PAGE_LIMITS.tables)
    .optional(),
});
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;
/** 页面交回的说明最多多少字 */
const RESULT_MESSAGE_CHARS = 1200;
/** 页面执行“看一眼”的结果 */
export const pageResultSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string().max(RESULT_MESSAGE_CHARS),
  snapshot: pageSnapshotSchema.optional(),
});
/** 页面把“看一眼”的结果交回服务器（POST /assistant/page/results 的正文） */
export const pageResultBody = z.strictObject({
  commandId: z.uuid(),
  clientId: z.uuid(),
  threadId: z.uuid(),
  requestId: z.uuid(),
  result: pageResultSchema,
});
export const pageTools = [
  {
    name: 'page.observe',
    description:
      '看眼前的页面：要知道用户眼前的 ERP 页面上的提示、弹窗和表格时用。mode 默认 summary 概要，region 看某块区域，record 看当前打开的记录，full 看完整；offset、limit 翻表格。查数据优先用查记录的命令。',
    arguments: {
      mode: 'summary/region/record/full',
      region: '指定区域',
      offset: 0,
      limit: 5,
    },
    risk: 'read',
  },
] as const;
