import { z } from 'zod';
export const choiceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('pending') }),
  z.strictObject({ mode: z.literal('new') }),
  z.strictObject({
    mode: z.literal('existing'),
    id: z.number().int().positive(),
    version: z.number().int().positive(),
  }),
]);
export const mappingSchema = z.strictObject({
  customer: choiceSchema,
  products: z.record(z.string().uuid(), choiceSchema),
  roundingPolicy: z.enum(['exact-cents', 'half-up-cent']),
});
export type ImportMapping = z.infer<typeof mappingSchema>;
