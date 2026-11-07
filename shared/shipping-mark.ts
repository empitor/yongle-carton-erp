import { z } from 'zod';
import { isPlainObject, pickKeys, scalarText, textList } from './model-output.js';

const nullableText = z.string().nullable().default(null);

export const markFieldsSchema = z.strictObject({
  itemCode: nullableText,
  productName: nullableText,
  brand: nullableText,
  quantityPerCarton: nullableText,
  netWeight: nullableText,
  grossWeight: nullableText,
  cartonNumber: nullableText,
  cartonLength: nullableText,
  cartonWidth: nullableText,
  cartonHeight: nullableText,
  printText: nullableText,
  requirements: nullableText,
  notes: nullableText,
  dimensionUnit: z.enum(['mm', 'cm']).nullable().default(null),
  dimensionBasis: z.enum(['inner', 'outer', 'unknown']).default('unknown'),
});

const markAnalysisItemSchema = markFieldsSchema.extend({
  page: z.number().int().nonnegative(),
  title: z.string().nullable(),
});

export const markAnalysisSchema = z.strictObject({
  marks: z.array(markAnalysisItemSchema).min(1).max(100),
  warnings: z.array(z.string()),
});

const markTextKeys = [
  'itemCode',
  'productName',
  'brand',
  'quantityPerCarton',
  'netWeight',
  'grossWeight',
  'cartonNumber',
  'cartonLength',
  'cartonWidth',
  'cartonHeight',
  'printText',
  'requirements',
  'notes',
  'title',
] as const;
/** 校验模型的唛头结果之前先整理：丢掉多余字段，修正类型。单位写法不认识就当未知，不猜。 */
export function tidyMarkAnalysis(raw: unknown) {
  if (!isPlainObject(raw)) return raw;
  const marks = Array.isArray(raw.marks)
    ? raw.marks.map((item, index) => {
        if (!isPlainObject(item)) return item;
        const out: Record<string, unknown> = pickKeys(item, markTextKeys);
        for (const key of markTextKeys) if (key in out) out[key] = scalarText(out[key]);
        if (!('title' in out)) out.title = null;
        const unit = String(item.dimensionUnit ?? '').trim().toLowerCase();
        out.dimensionUnit = unit === 'mm' || unit === '毫米' ? 'mm' : unit === 'cm' || unit === '厘米' ? 'cm' : null;
        out.dimensionBasis = ['inner', 'outer'].includes(String(item.dimensionBasis)) ? item.dimensionBasis : 'unknown';
        const page = Number(item.page);
        out.page = Number.isInteger(page) && page >= 0 ? page : index;
        return out;
      })
    : raw.marks;
  return { marks, warnings: textList(raw.warnings, 100, 1000) };
}

export type MarkFields = z.infer<typeof markFieldsSchema>;
export type MarkAnalysis = z.infer<typeof markAnalysisSchema>;

export const markChoiceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('pending') }),
  z.strictObject({ mode: z.literal('existing'), id: z.number().int().positive() }),
  z.strictObject({
    mode: z.literal('new'),
    name: z.string(),
    customerProductCode: z.string().nullable().optional(),
  }),
]);

export const markReviewSchema = z.strictObject({
  fileHash: z.string(),
  recognizedAt: z.string(),
  warnings: z.array(z.string()),
  items: z.array(
    z.strictObject({
      key: z.string(),
      page: z.number().int().nonnegative(),
      title: z.string().nullable(),
      fields: markFieldsSchema,
      choice: markChoiceSchema,
      skip: z.boolean(),
    }),
  ),
  committed: z
    .strictObject({
      at: z.string(),
      results: z.array(
        z.strictObject({
          key: z.string(),
          productId: z.number().int().positive(),
          markId: z.number().int().positive(),
        }),
      ),
    })
    .nullable(),
});

export type MarkChoice = z.infer<typeof markChoiceSchema>;
export type MarkReview = z.infer<typeof markReviewSchema>;
