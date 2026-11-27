import { z } from 'zod';
import { fieldLabel, fieldTitle } from '../core/index.js';
import { optionalDocumentFields } from './document-fields.js';
/** 单据抬头里的我方公司名（模板没填公司名时也印它）。 */
export const factoryName = '宁波甬勒包装制品有限公司';
/** 模板的单据种类：采购订货单、送货单。 */
export const documentKinds = ['purchase', 'delivery'] as const;
export type DocumentKind = (typeof documentKinds)[number];
/** sRGB 转线性亮度的常数（WCAG 相对亮度公式）。 */
const srgb = { channelMax: 255, linearBelow: 0.04045, linearScale: 12.92, offset: 0.055, gamma: 2.4 } as const;
const luminanceWeights = { red: 0.2126, green: 0.7152, blue: 0.0722 } as const;
/** 表头底色亮度超过它就用深色字，否则用白字。 */
const DARK_TEXT_ABOVE_LUMINANCE = 0.179;
const HEX_RADIX = 16;
export function templateHeaderText(color: string) {
  const [red, green, blue] = [0, 1, 2]
    .map((i) => parseInt(color.slice(2 * i, 2 * i + 2), HEX_RADIX) / srgb.channelMax)
    .map((v) =>
      v <= srgb.linearBelow ? v / srgb.linearScale : ((v + srgb.offset) / (1 + srgb.offset)) ** srgb.gamma,
    );
  const luminance =
    red * luminanceWeights.red + green * luminanceWeights.green + blue * luminanceWeights.blue;
  return luminance > DARK_TEXT_ABOVE_LUMINANCE ? '111111' : 'FFFFFF';
}
const documentColumnKeys = [
  'index',
  'name',
  'specification',
  'unit',
  'quantity',
  'unitPrice',
  'amount',
  'notes',
  'productCode',
  'orderNumber',
  'customerOrderNumber',
  'dimensions',
  'material',
  'flute',
] as const;
export type DocumentColumn = (typeof documentColumnKeys)[number];
/**
 * 明细列的列名：和业务同一栏目的用栏目登记表的叫法（shared/core/field-names.ts），只有导出单据才有的列写在这里。
 * “规格及尺寸”印的是规格和尺寸拼在一起（server/documents/forms.ts 的 joinSpecification），保留这个名字。
 */
export const documentColumns = {
  index: '序号',
  name: fieldLabel('productName'),
  specification: '规格及尺寸',
  unit: fieldLabel('unit'),
  quantity: fieldLabel('quantity'),
  // 单价后面已经带着“元/m²”“元/张”，列名只写“单价”
  unitPrice: fieldLabel('unitPrice'),
  amount: fieldTitle('amount') ?? fieldLabel('amount'),
  notes: '明细备注',
  productCode: fieldLabel('customerProductCode'),
  orderNumber: '我方销售订单号',
  customerOrderNumber: fieldLabel('externalPurchaseOrder'),
  dimensions: '尺寸及单位',
  material: fieldLabel('material'),
  flute: fieldLabel('flute'),
} as const satisfies Record<DocumentColumn, string>;
/** 自定义明细列时必须保留的列。 */
export const requiredColumns: readonly DocumentColumn[] = ['name', 'quantity', 'unit'];
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
const documentPaperKeys = ['a4', 'continuous-241x140', 'continuous-241x93', 'a5'] as const;
export type DocumentPaper = (typeof documentPaperKeys)[number];
/** 纸张：A4 走激光/喷墨；241 宽的是针式打印联单（二等分、三等分）。单位 mm。 */
export const documentPapers = {
  a4: { label: 'A4（210×297 mm）', width: 210, height: 297 },
  'continuous-241x140': { label: '针式二等分（241×140 mm）', width: 241, height: 139.7 },
  'continuous-241x93': { label: '针式三等分（241×93 mm）', width: 241, height: 93.1 },
  a5: { label: 'A5 横向（210×148 mm）', width: 210, height: 148 },
} as const satisfies Record<DocumentPaper, { label: string; width: number; height: number }>;
export const defaultCopyLabels = '第一联 存根　第二联 客户　第三联 回单';
/** 没选过纸张的模板按这类单据的默认纸张：采购单 A4，送货单针式三等分。 */
export const templatePaper = (t: { kind: DocumentKind; paper?: DocumentPaper }) =>
  t.paper ?? (t.kind === 'delivery' ? 'continuous-241x93' : 'a4');
/** 没填过联次说明的送货单用默认三联文字；清空后就不印。 */
export const templateCopyLabels = (t: { kind: DocumentKind; copyLabels?: string }) =>
  t.copyLabels ?? (t.kind === 'delivery' ? defaultCopyLabels : '');
/** 这类单据默认的明细列和顺序。 */
export const defaultTemplateColumns = (kind: DocumentKind): DocumentColumn[] =>
  kind === 'purchase' ? purchaseColumns : deliveryColumns;
/** 明细列是否就是默认（没自定义过，或者和默认列、顺序完全一样）。 */
export const templateColumnsAreDefault = (t: { kind: DocumentKind; columns?: DocumentColumn[] }) => {
  const d = defaultTemplateColumns(t.kind);
  return !t.columns || (t.columns.length === d.length && t.columns.every((c, i) => c === d[i]));
};
/**
 * 明细列恢复默认：去掉自定义列，回到这类单据的默认列和顺序。只动明细列，其他设置原样保留。
 * 去掉而不是复制一份默认数组，保存后和从没改过的模板一样，以后默认列调整也会跟着走。
 */
export const resetTemplateColumns = <T extends { columns?: DocumentColumn[] }>(
  t: T,
): Omit<T, 'columns'> => {
  const { columns: _removed, ...rest } = t;
  return rest;
};
export const templateIdSchema = z.string().regex(/^(purchase|delivery)-[a-z0-9-]{1,60}$/);
/** 模板各文字项的长度上限（字）和几项的个数上下限。 */
const templateLimits = {
  nameChars: 60,
  titleChars: 30,
  phoneChars: 50,
  textChars: 300,
  termChars: 500,
  copyLabelChars: 80,
  signatureChars: 30,
  fontSizeMin: 9,
  fontSizeMax: 12,
  columnsMin: 3,
  signaturesMax: 3,
  templatesMax: 12,
} as const;
const text = (max: number) => z.string().trim().max(max);
export const templateSchema = z
  .strictObject({
    id: templateIdSchema,
    kind: z.enum(documentKinds),
    name: text(templateLimits.nameChars).min(1).default('标准模板'),
    companyName: text(100).min(1),
    title: text(templateLimits.titleChars).min(1),
    footerNotes: text(1000),
    headerText: text(templateLimits.textChars).default(''),
    footerText: text(templateLimits.textChars).default(''),
    companyContact: text(100).default(''),
    companyPhone: text(templateLimits.phoneChars).default(''),
    companyAddress: text(templateLimits.textChars).default(''),
    deliveryTerms: text(templateLimits.termChars).default(''),
    acceptanceTerms: text(templateLimits.termChars).default(''),
    paymentTerms: text(templateLimits.termChars).default(''),
    color: z.string().regex(/^[0-9A-Fa-f]{6}$/),
    fontSize: z.number().int().min(templateLimits.fontSizeMin).max(templateLimits.fontSizeMax),
    fontFamily: z.enum(['宋体', '微软雅黑', '等线']).default('宋体'),
    orientation: z.enum(['portrait', 'landscape']).default('landscape'),
    paper: z.enum(documentPaperKeys).optional(),
    copyLabels: text(templateLimits.copyLabelChars).optional(),
    showLogo: z.boolean().default(true),
    density: z.enum(['compact', 'normal']).default('normal'),
    columns: z
      .array(z.enum(documentColumnKeys))
      .min(templateLimits.columnsMin)
      .max(documentColumnKeys.length)
      .optional(),
    hiddenFields: z
      .array(z.enum(optionalDocumentFields))
      .max(optionalDocumentFields.length)
      .default([]),
    defaultFormat: z.enum(['docx', 'xlsx']),
    signatures: z
      .array(text(templateLimits.signatureChars).min(1))
      .min(1)
      .max(templateLimits.signaturesMax),
  })
  .superRefine((v, ctx) => {
    if (!v.id.startsWith(v.kind + '-'))
      ctx.addIssue({ code: 'custom', message: '模板与单据类型不一致' });
    const columns = v.columns;
    if (
      columns &&
      (new Set(columns).size !== columns.length ||
        !requiredColumns.every((c) => columns.includes(c)))
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
    templates: z.array(templateSchema).min(2).max(templateLimits.templatesMax),
    defaults: z.strictObject({ purchase: templateIdSchema, delivery: templateIdSchema }).optional(),
  })
  .superRefine((v, ctx) => {
    if (
      new Set(v.templates.map((t) => t.id)).size !== v.templates.length ||
      !documentKinds.every((k) => v.templates.some((t) => t.kind === k))
    )
      ctx.addIssue({ code: 'custom', message: '模板编号不能重复，每种单据必须至少保留一套模板' });
    const defaults = v.defaults;
    if (
      defaults &&
      !documentKinds.every((k) => v.templates.some((t) => t.kind === k && t.id === defaults[k]))
    )
      ctx.addIssue({ code: 'custom', message: '默认模板必须属于对应单据类型' });
  });
export type DocumentTemplateState = {
  revision: number;
  templates: DocumentTemplate[];
  defaults: { purchase: string; delivery: string };
};
/** 出厂默认：两类单据各一套标准模板，没填的项按模板结构的默认值补上。 */
const factoryTemplates: z.input<typeof templateSchema>[] = [
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
    name: '标准送货单',
    companyName: factoryName,
    title: '送货单',
    footerNotes: '',
    color: 'E8EEF0',
    fontSize: 10,
    defaultFormat: 'docx',
    signatures: ['送货人签字', '收货人签字'],
  },
];
export const defaultDocumentTemplates = (): DocumentTemplateState => ({
  revision: 0,
  templates: factoryTemplates.map((t) => templateSchema.parse(t)),
  defaults: { purchase: 'purchase-default', delivery: 'delivery-default' },
});
