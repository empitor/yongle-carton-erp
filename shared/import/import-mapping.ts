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
  products: z.record(z.uuid(), choiceSchema),
  roundingPolicy: z.enum(['exact-cents', 'half-up-cent']),
});
export type ImportMapping = z.infer<typeof mappingSchema>;
/** 识别结果改了以后，哪些已选的客户、产品对应失效了（原因写给人看） */
export type MappingInvalidations = { customer?: string; products: Record<string, string> };
