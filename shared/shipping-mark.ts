import { z } from 'zod';

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
