import { z } from 'zod';
export const documentExportSchema = z
  .strictObject({
    kind: z.enum(['purchase', 'delivery']),
    id: z.number().int().positive(),
    format: z.enum(['docx', 'xlsx']),
    templateId: z
      .string()
      .regex(/^(purchase|delivery)-[a-z0-9-]{1,60}$/)
      .optional(),
    markOrdered: z.boolean().default(false),
    expectedVersion: z.number().int().positive(),
    requestId: z.string().uuid(),
  })
  .refine((v) => !v.markOrdered || v.kind === 'purchase', '只有采购订货单可以标记已订货');
export const factoryName = '宁波甬勒包装制品有限公司';
