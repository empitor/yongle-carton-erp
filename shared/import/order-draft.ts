import { z } from 'zod';
import type { ImportMapping, MappingInvalidations } from './import-mapping.js';
import type { PromptPresetUsage } from '../ai/index.js';

/** 原件的格式（按扩展名和文件头认出来的）；本机不解析文件内容 */
export type ParsedFile = {
  format: 'xls' | 'xlsx' | 'docx' | 'doc' | 'pdf' | 'png' | 'jpg';
};
export const headerFields = [
  'buyerName',
  'supplierName',
  'purchaseOrderNumber',
  'orderDate',
  'deliveryDate',
  'currency',
  'taxRate',
  'taxMode',
  'notes',
  'terms',
  'statedTotalQuantity',
  'statedTotalAmount',
] as const;
export const lineFields = [
  'productName',
  'productCode',
  'specification',
  'length',
  'width',
  'height',
  'dimensionUnit',
  'material',
  'flute',
  'requirements',
  'quantity',
  'unit',
  'unitPrice',
  'statedAmount',
  'taxRate',
  'taxMode',
  'deliveryDate',
  'notes',
] as const;
export type HeaderField = (typeof headerFields)[number];
export type LineField = (typeof lineFields)[number];
export const fieldLabels: Record<HeaderField | LineField, string> = {
  buyerName: '采购方／客户',
  supplierName: '供应方',
  purchaseOrderNumber: '客户采购订单号',
  orderDate: '订单日期',
  deliveryDate: '交货日期',
  currency: '币种',
  taxRate: '税率（%）',
  taxMode: '含税／未税',
  notes: '备注',
  terms: '合同条件',
  statedTotalQuantity: '原文数量合计',
  statedTotalAmount: '原文金额合计',
  productName: '产品名称',
  productCode: '客户物料编码',
  specification: '规格型号',
  length: '长',
  width: '宽',
  height: '高',
  dimensionUnit: '尺寸单位',
  material: '材质／配纸',
  flute: '楞型',
  requirements: '加工要求',
  quantity: '数量',
  unit: '数量单位',
  unitPrice: '单价（原币）',
  statedAmount: '原文行金额',
};
/** 识别结果一格最多多少字（识别表交回、改格子都按它截或拦） */
export const DRAFT_VALUE_MAX = 2000;
/** 一格的说明（拿不准的原因、改的理由）最多多少字 */
export const DRAFT_NOTE_MAX = 600;
const fieldSchema = z.strictObject({
  value: z.string().max(DRAFT_VALUE_MAX).nullable(),
  certainty: z.enum(['recognized', 'needs-review', 'user-modified']),
  note: z.preprocess((v) => (v === null || v === undefined ? '' : v), z.string().max(DRAFT_NOTE_MAX)),
  /** 人改了数量或单价、改之前原文金额和数量×单价对得上：正式金额按新值重算，原文金额只留着对照（后端写，不给模型） */
  recalculated: z.literal(true).optional(),
  /** 这一格是助手改的（人在识别结果页上再改就去掉），之后打开的人看得出哪些格子助手动过 */
  editedBy: z.literal('assistant').optional(),
});
const missingField = () => ({
  value: null,
  certainty: 'needs-review' as const,
  note: '原件未提供或尚未识别',
});
export type DraftField = z.infer<typeof fieldSchema>;
/** 整单、一行明细的全部栏目（每栏都要有） */
export const draftHeaderSchema = z.record(z.enum(headerFields), fieldSchema);
export const draftLineFieldsSchema = z.record(z.enum(lineFields), fieldSchema);
/** 一份识别结果：整单、明细（每行有编号）、提醒。工作区库里存的、页面和助手看到的都是它 */
export const orderDraftSchema = z.object({
  header: draftHeaderSchema,
  lines: z.array(z.object({ id: z.string(), fields: draftLineFieldsSchema })),
  warnings: z.array(z.string()),
});
export type OrderDraft = z.infer<typeof orderDraftSchema>;
/** 识别任务的状态 */
export const importTaskStates = ['uploaded', 'queued', 'backoff', 'running', 'ready', 'failed', 'cancelled'] as const;
/** 识别任务还没结束：排队、限流后等着重试、识别中（程序关掉时这几种算中断） */
export const runningTaskStates = ['queued', 'backoff', 'running'] as const;
export const taskStillRunning = (state: string | undefined): state is (typeof runningTaskStates)[number] =>
  runningTaskStates.some((s) => s === state);
export const patchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set-header'),
    field: z.enum(headerFields),
    value: z.string().max(DRAFT_VALUE_MAX).nullable(),
    reason: z.string().max(DRAFT_NOTE_MAX),
  }),
  z.strictObject({
    op: z.literal('set-line'),
    lineId: z.uuid(),
    field: z.enum(lineFields),
    value: z.string().max(DRAFT_VALUE_MAX).nullable(),
    reason: z.string().max(DRAFT_NOTE_MAX),
  }),
]);
export type DraftOperation = z.infer<typeof patchOperationSchema>;
export type DraftIssue = { path: string; message: string; severity: 'error' | 'review' };
export type DraftEvaluation = {
  issues: DraftIssue[];
  lineAmounts: Record<string, string | null>;
  totalQuantity: string | null;
  totalAmount: string | null;
};
export type DraftChange = {
  path: string;
  label: string;
  before: string | null;
  after: string | null;
  reason: string;
  /** 谁改的：助手，还是人在识别结果页上改的 */
  by: 'assistant' | 'person';
};
export type ImportedOrderRef = {
  orderId: number;
  orderNumber: string;
  executionId: string;
  archived: boolean;
  permanentlyDeleted?: boolean;
  historical?: boolean;
  sourceId?: string;
};
export type ImportWorkspaceView = {
  id: string;
  revision: number;
  fileName: string;
  fileHash: string;
  size: number;
  createdAt: string;
  parsed: ParsedFile;
  draft: OrderDraft | null;
  /** 已归档（在“历史与归档”里，能恢复；不能导入） */
  archived?: boolean;
  /** 每个导入文件独立的识别模式；默认订单识别。 */
  mode: 'order' | 'arrival';
  /** 已关联的供应商到货单（正式入库仍走 FlowService）。 */
  arrivalDocId?: number | null;
  arrivalSourceId?: string | null;
  evaluation: DraftEvaluation | null;
  changes: DraftChange[];
  canUndo: boolean;
  mapping?: ImportMapping;
  mappingInvalidated?: MappingInvalidations;
  task?: {
    state: (typeof importTaskStates)[number];
    /** 开始排队的时间 */
    startedAt?: string;
    error?: string;
    failureId?: string;
    diagnosticStorageError?: string;
    progress?: import('../ai/index.js').AiProgress;
    position?: number;
    limit?: number;
    /** 排队时第几次尝试（AI 排队给的） */
    attempt?: number;
  };
  promptVersion?: string;
  promptPreset?: PromptPresetUsage;
  imported?: ImportedOrderRef;
  historyImport?: ImportedOrderRef;
};
export const blankField = (): DraftField => missingField();

/** AI 导入里这份文件还要不要人处理。订单导入了、到货入库了，就算办完。 */
export function importStillOpen(w: {
  imported?: unknown;
  mode?: string;
  arrivalStatus?: string;
}) {
  if (w.imported) return false;
  if (w.mode === 'arrival') return w.arrivalStatus !== 'confirmed';
  return true;
}
