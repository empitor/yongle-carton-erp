import { RAW_UNIT } from '../../core/index.js';
import { z } from 'zod';
import { dateSchema } from '../../core/index.js';
import { positiveQuantity, quantityText } from '../../core/index.js';
import { noteText } from '../operations/operations.js';
/** 一次登记里不挂任务的完工最多几行 */
const MAX_UNTASKED_LINES = 20;
const id = z.number().int().positive();
/** 登记完工的内容。请求号必填（防重复提交）；助手出卡片时没给的由服务器补，见 assistantProductionCompletionSchema */
const completionFields = z
  .strictObject({
    requestId: z.uuid(),
    taskIds: z.array(id).min(1).optional(),
    allActive: z.boolean().optional(),
    date: dateSchema.optional(),
    goodRatePct: z.number().positive().max(100).optional(),
    quantities: z
      .array(
        z.strictObject({ taskId: id, goodQuantity: quantityText, scrapQuantity: quantityText }),
      )
      .optional(),
    /** 不挂任务的完工（打样、补做）：哪个产品、合格、废品（废品也要明确写，没有就是 0，不替人补）；和挂任务的同一批登记，领料按产量比例一起分 */
    untasked: z
      .array(z.strictObject({ productId: id, goodQuantity: quantityText, scrapQuantity: quantityText }))
      .max(MAX_UNTASKED_LINES)
      .optional(),
    materials: z
      .array(
        z.strictObject({
          stockId: id.optional(),
          unit: z.literal(RAW_UNIT),
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
    // 入哪个成品库存不用传：由任务的产品决定（一个产品只有一个，没有就新建、已归档的自动恢复）
    operator: z.string().trim().min(1).max(100).optional(),
    /** 批次备注：这次登记写的一句，记到生成的每张完工单的备注上，显示在成品库存的批次里 */
    notes: noteText.default(''),
    /**
     * 只登记、稍后核对入库：每张任务存成一张待入库的完工单，不动库存，之后逐张“核对入库”。
     * 拆分、领料分摊、批次备注和直接登记入库完全一样；不传就是直接登记并入库。
     */
    pending: z.boolean().optional(),
  });
type CompletionScope = { taskIds?: number[]; allActive?: boolean; untasked?: unknown[] };
/** 选任务的两条规则：人工和助手共用 */
const withScopeRules = <T extends z.ZodType<CompletionScope>>(schema: T) =>
  schema
    .refine((v) => !(v.taskIds?.length && v.allActive), '指定任务和全部待完工任务只能选一种')
    .refine((v) => !!v.taskIds?.length || !!v.allActive || !!v.untasked?.length, '请选生产任务，或者填不挂任务的完工');
export const productionCompletionSchema = withScopeRules(completionFields);
/**
 * 助手登记完工：实际完工日期和每个任务的实际良品、废品数量都必填，不悄悄按今天、按剩余任务量全部良品入库。
 * 用户说“今天”就传今天的日期；没说就先问用户。人工页面的批量完工仍用上面的结构。
 * 请求号模型可以不给：出卡片时服务器补一个（server/assistant/tools/flow-docs.ts），执行时按上面的结构必填。
 */
export const assistantProductionCompletionSchema = withScopeRules(
  completionFields.extend({ requestId: z.uuid().optional() }),
).superRefine((v, ctx) => {
  if (!v.date)
    ctx.addIssue({
      code: 'custom',
      path: ['date'],
      message: '实际完工日期必填：用用户说的日期（说“今天”就传今天的日期），用户没说先问，不默认今天',
    });
  // 挂任务的才要逐个任务的数量；只登记不挂任务的（untasked）每行自己带良品、废品
  if ((v.taskIds?.length || v.allActive) && !v.quantities?.length)
    ctx.addIssue({
      code: 'custom',
      path: ['quantities'],
      message: '每个任务的实际良品、废品数量必填：用户没说先问，不按剩余任务量默认全部良品',
    });
});
