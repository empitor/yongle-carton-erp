import { z } from 'zod';
import { dateSchema } from './domain.js';
import { positiveQuantity, quantityText } from './operations.js';
const id = z.number().int().positive();
export const productionCompletionSchema = z
  .strictObject({
    requestId: z.string().uuid().optional(),
    taskIds: z.array(id).min(1).optional(),
    allActive: z.boolean().optional(),
    date: dateSchema.optional(),
    goodRatePct: z.number().positive().max(100).optional(),
    quantities: z
      .array(
        z.strictObject({ taskId: id, goodQuantity: quantityText, scrapQuantity: quantityText }),
      )
      .optional(),
    materials: z
      .array(
        z.strictObject({
          stockId: id.optional(),
          unit: z.literal('张'),
          issued: positiveQuantity,
          returned: quantityText.default('0'),
        }),
      )
      .min(1),
    allocation: z.enum(['shared-proportional', 'explicit']),
    distribution: z
      .array(
        z.strictObject({
          taskId: id,
          materials: z
            .array(
              z.strictObject({
                stockId: id,
                issued: positiveQuantity,
                returned: quantityText.default('0'),
              }),
            )
            .min(1),
        }),
      )
      .optional(),
    finishedStocks: z.array(z.strictObject({ taskId: id, stockId: id })).optional(),
    createMissingFinished: z.boolean().default(true),
    operator: z.string().trim().min(1).max(100).optional(),
    previewOnly: z.boolean().optional(),
  })
  .refine((v) => !!v.taskIds?.length !== !!v.allActive, '必须指定任务范围或全部待完工任务');
