import { z } from 'zod';
export const developmentResetSchema = z.strictObject({
  scope: z.enum(['business', 'ai-imports', 'all']).default('all'),
  reason: z.string().trim().min(1).max(200).optional(),
});
