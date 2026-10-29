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
