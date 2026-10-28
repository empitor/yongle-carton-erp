import { z } from 'zod';
import { developerCommandSchema, developerModules } from './developer.js';
export const managementSelectionSchema = z.strictObject({
  all: z.literal(true),
  kind: z.enum(['raw', 'finished']).optional(),
  archived: z.boolean().optional(),
  q: z.string().max(200).optional(),
});
export const managementBatchSchema = z.strictObject({
  requestId: z.string().uuid(),
  reason: z.string().min(1).max(1000),
  commands: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/),
        module: z.enum(developerModules),
        action: developerCommandSchema.shape.action,
        items: z.array(z.unknown()).optional(),
        selection: managementSelectionSchema.optional(),
        patch: z.record(z.string(), z.unknown()).default({}),
        inventoryPolicy: z.enum(['preserve', 'recalculate']).optional(),
        dimensionPolicy: z.enum(['convert', 'relabel']).optional(),
      }),
    )
    .min(1),
});
export const assistantManagementSchema = z.union([
  developerCommandSchema.extend({
    selection: managementSelectionSchema.optional(),
    dimensionPolicy: z.enum(['convert', 'relabel']).optional(),
  }),
  managementBatchSchema,
]);
