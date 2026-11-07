import { z } from 'zod';
import { factoryName } from './business-export.js';
export function templateHeaderText(color: string) {
  const rgb = [0, 2, 4]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '111111' : 'FFFFFF';
}
export const documentColumns = {
  index: '序号',
  name: '产品名称',
  specification: '规格及尺寸',
  unit: '数量单位',
  quantity: '数量',
  unitPrice: '单价及计价单位',
  amount: '金额（元）',
  notes: '明细备注',
  productCode: '产品编码 / 客户料号',
  orderNumber: '我方销售订单号',
  customerOrderNumber: '客户采购订单号',
  dimensions: '尺寸及单位',
  material: '材质 / 配纸',
  flute: '楞型',
} as const;
export type DocumentColumn = keyof typeof documentColumns;
export const purchaseColumns: DocumentColumn[] = [
  'index',
  'name',
  'specification',
  'unit',
  'quantity',
  'unitPrice',
  'amount',
];
export const deliveryColumns: DocumentColumn[] = [
  'index',
  'name',
  'specification',
  'unit',
  'quantity',
  'productCode',
  'orderNumber',
  'notes',
];
export const optionalDocumentFields = [
  '供应商联系信息',
  '客户联系信息',
  '预计交货日期',
  '我方联系人',
  '交货地址',
  '客户采购订单号',
  '关联销售订单',
  '交货要求',
  '验收要求',
  '付款条件',
  '税费说明',
] as const;
/** 纸张：A4 走激光/喷墨；241 宽的是针式打印联单（二等分、三等分）。单位 mm。 */
export const documentPapers = {
  a4: { label: 'A4（210×297 mm）', width: 210, height: 297 },
  'continuous-241x140': { label: '针式二等分（241×140 mm）', width: 241, height: 139.7 },
  'continuous-241x93': { label: '针式三等分（241×93 mm）', width: 241, height: 93.1 },
  a5: { label: 'A5 横向（210×148 mm）', width: 210, height: 148 },
} as const;
export type DocumentPaper = keyof typeof documentPapers;
export const defaultCopyLabels = '第一联 存根　第二联 客户　第三联 回单';
/**
 * 已保存的老模板没有纸张字段：采购单按 A4，送货单按针式二等分，保持它们原来的样子。
 * 新的默认模板在 defaultDocumentTemplates 里显式写了纸张，不走这里。
 */
export const templatePaper = (t: { kind: 'purchase' | 'delivery'; paper?: DocumentPaper }) =>
  t.paper ?? (t.kind === 'delivery' ? 'continuous-241x140' : 'a4');
/** 没填过联次说明的送货单用默认三联文字；清空后就不印。 */
export const templateCopyLabels = (t: { kind: 'purchase' | 'delivery'; copyLabels?: string }) =>
  t.copyLabels ?? (t.kind === 'delivery' ? defaultCopyLabels : '');
/** 这类单据默认的明细列和顺序。 */
export const defaultTemplateColumns = (kind: 'purchase' | 'delivery'): DocumentColumn[] =>
  kind === 'purchase' ? purchaseColumns : deliveryColumns;
/** 明细列是否就是默认（没自定义过，或者和默认列、顺序完全一样）。 */
export const templateColumnsAreDefault = (t: {
  kind: 'purchase' | 'delivery';
  columns?: DocumentColumn[];
}) => {
  const d = defaultTemplateColumns(t.kind);
  return !t.columns || (t.columns.length === d.length && t.columns.every((c, i) => c === d[i]));
};
/**
 * 明细列恢复默认：去掉自定义列，回到这类单据的默认列和顺序。只动明细列，其他设置原样保留。
 * 去掉而不是复制一份默认数组，保存后和从没改过的模板一样，以后默认列调整也会跟着走。
 */
export const resetTemplateColumns = <T extends { columns?: DocumentColumn[] }>(t: T): T => {
  const { columns: _removed, ...rest } = t;
  return rest as T;
};
export const templateIdSchema = z.string().regex(/^(purchase|delivery)-[a-z0-9-]{1,60}$/);
export const templateSchema = z
  .strictObject({
    id: templateIdSchema,
    kind: z.enum(['purchase', 'delivery']),
    name: z.string().trim().min(1).max(60).default('标准模板'),
    companyName: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(30),
    footerNotes: z.string().trim().max(1000),
    headerText: z.string().trim().max(300).default(''),
    footerText: z.string().trim().max(300).default(''),
    companyContact: z.string().trim().max(100).default(''),
    companyPhone: z.string().trim().max(50).default(''),
    companyAddress: z.string().trim().max(300).default(''),
    deliveryTerms: z.string().trim().max(500).default(''),
    acceptanceTerms: z.string().trim().max(500).default(''),
    paymentTerms: z.string().trim().max(500).default(''),
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/),
    fontSize: z.number().int().min(9).max(12),
    fontFamily: z.enum(['宋体', '微软雅黑', '等线']).default('宋体'),
    orientation: z.enum(['portrait', 'landscape']).default('landscape'),
    paper: z.enum(Object.keys(documentPapers) as [DocumentPaper, ...DocumentPaper[]]).optional(),
    copyLabels: z.string().trim().max(80).optional(),
    showLogo: z.boolean().default(true),
    density: z.enum(['compact', 'normal']).default('normal'),
    columns: z
      .array(z.enum(Object.keys(documentColumns) as [DocumentColumn, ...DocumentColumn[]]))
      .min(3)
      .max(14)
      .optional(),
    hiddenFields: z
      .array(z.enum(optionalDocumentFields))
      .max(optionalDocumentFields.length)
      .default([]),
    defaultFormat: z.enum(['docx', 'xlsx']),
    signatures: z.array(z.string().trim().min(1).max(30)).min(1).max(3),
  })
  .superRefine((v, ctx) => {
    if (!v.id.startsWith(v.kind + '-'))
      ctx.addIssue({ code: 'custom', message: '模板与单据类型不一致' });
    if (
      v.columns &&
      (new Set(v.columns).size !== v.columns.length ||
        !['name', 'quantity', 'unit'].every((c) => v.columns!.includes(c as DocumentColumn)))
    )
      ctx.addIssue({
        code: 'custom',
        message: '明细列不得重复，且必须保留产品名称、数量与数量单位',
      });
  });
export type DocumentTemplate = z.infer<typeof templateSchema>;
export const templateSettingsSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    templates: z.array(templateSchema).min(2).max(12),
    defaults: z.strictObject({ purchase: templateIdSchema, delivery: templateIdSchema }).optional(),
  })
  .superRefine((v, ctx) => {
    if (
      new Set(v.templates.map((t) => t.id)).size !== v.templates.length ||
      !['purchase', 'delivery'].every((k) => v.templates.some((t) => t.kind === k))
    )
      ctx.addIssue({ code: 'custom', message: '模板编号不能重复，每种单据必须至少保留一套模板' });
    if (
      v.defaults &&
      !(['purchase', 'delivery'] as const).every((k) =>
        v.templates.some((t) => t.kind === k && t.id === v.defaults![k]),
      )
    )
      ctx.addIssue({ code: 'custom', message: '默认模板必须属于对应单据类型' });
  });
export type DocumentTemplateState = {
  revision: number;
  templates: DocumentTemplate[];
  defaults: { purchase: string; delivery: string };
};
export function normalizeTemplateState(raw: any): DocumentTemplateState {
  const templates = raw.templates.map((t: unknown) => templateSchema.parse(t));
  return {
    revision: raw.revision,
    templates,
    defaults: raw.defaults || {
      purchase: templates.find((t: DocumentTemplate) => t.kind === 'purchase')!.id,
      delivery: templates.find((t: DocumentTemplate) => t.kind === 'delivery')!.id,
    },
  };
}
export const defaultDocumentTemplates = (): DocumentTemplateState =>
  normalizeTemplateState({
    revision: 0,
    templates: [
      {
        id: 'purchase-default',
        kind: 'purchase',
        orientation: 'portrait',
        name: '标准采购订货单',
        companyName: factoryName,
        title: '采购订货单',
        footerNotes: '',
        color: 'E8EEF0',
        fontSize: 10,
        defaultFormat: 'docx',
        signatures: ['制单人', '审核人', '供应商确认'],
      },
      {
        id: 'delivery-default',
        kind: 'delivery',
        paper: 'continuous-241x93',
        name: '标准送货单',
        companyName: factoryName,
        title: '送货单',
        footerNotes: '',
        color: 'E8EEF0',
        fontSize: 10,
        defaultFormat: 'docx',
        signatures: ['送货人签字', '收货人签字'],
      },
    ],
  });
