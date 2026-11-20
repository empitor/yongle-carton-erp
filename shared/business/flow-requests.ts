import { z } from 'zod';
import { dateSchema, previewDigestSchema, today } from '../core/index.js';
import { arrivalTimeSchema } from './arrival.js';
import { flowKinds, noteText, operatorText } from './physical-flow.js';
import { productionCompletionSchema } from './production-completion.js';
import { purchaseReturnSchema } from './purchase-return.js';

/*
 * 单据流转接口的查询参数和正文（接口表 flow-api.ts）：服务端 server/flow 按这里的规则校验，接口表照它们的输入（z.input）写类型。
 * 单据内容的录入规则在 physical-flow.ts，更正在 flow-correction.ts，登记完工在 production-completion.ts，登记到货在 order-batch.ts，
 * 采购退货在 purchase-return.ts。
 */

/** 地址上给的是文字，页面传进来的是数字 */
const recordId = z.coerce.number<number | string>().int().positive();
/** 取消、撤销的原因最多多少字 */
export const UNDO_REASON_MAX_LENGTH = 1000;
/** 到货、送货页“最近”默认往回看几天、最多能看几天 */
export const RECENT_DAYS = 90;
const MAX_RECENT_DAYS = 3650;

/**
 * 单据列表（GET /flow）：哪种单据；status=draft 只读还没核对的（安排送货时扣掉已排的数量用）；
 * 带不带已归档的由服务端按权限判断（includeArchivedFor），archived=1 只列已归档的。status、archived 不认识的取值当没给。
 */
export const flowListQuerySchema = z.object({
  kind: z.enum(flowKinds).optional(),
  status: z.literal('draft').optional().catch(undefined),
  archived: z.enum(['1', 'all']).optional().catch(undefined),
});

/** 成品库存的批次（GET /flow/stock-batches/:id）：depleted=all 连已发完的批次全列，不给只列最近的；别的取值当没给 */
export const stockBatchesQuerySchema = z.object({ depleted: z.literal('all').optional().catch(undefined) });

/** 到货记录（GET /flow/arrival-records）：地址上只收到货日期和采购单，别的查询条件（供应商、记录编号）只给服务端内部和助手用 */
export const arrivalRecordsQuerySchema = z.object({ date: dateSchema.optional(), purchaseId: recordId.optional() });

/**
 * 仓库台账（GET /flow/daily）：哪种、哪天（默认今天）；day 按天看，all 读全部，recent 是还要处理的加最近 days 天的。
 * doc：点开一张到货单、送货单的详情，只读这一张（已归档的也读，列表照旧不带已归档的），日期和范围不看。
 */
export const dailyQuerySchema = z
  .strictObject({
    kind: z.enum(['arrival', 'delivery', 'task']),
    date: dateSchema.default(today),
    scope: z.enum(['day', 'all', 'recent']).default('day'),
    days: z.coerce.number<number | string>().int().min(1).max(MAX_RECENT_DAYS).default(RECENT_DAYS),
    doc: recordId.optional(),
  })
  .refine((q) => !q.doc || q.kind !== 'task', { message: '只有到货单、送货单能按单据读台账记录。', path: ['doc'] });

/** 一张到货单下的退货记录（GET /flow/returns）：不给到货单就列最近的全部 */
export const returnsQuerySchema = z.object({ arrivalId: recordId.optional() });
/** 撤销一次采购退货：打开时的版本、撤销原因（和退货原因同一条规则） */
export const returnReversalSchema = z.strictObject({
  version: z.number().int().positive(),
  reason: purchaseReturnSchema.shape.reason,
});

/**
 * 对外的单据保存（POST /flow/:kind、PUT /flow/:id）：正文里除了单据内容还带防重复的请求号（必填：不带就拒，重发同一个号只办一次），
 * 修改时带打开那会儿的版本（服务端只比对是不是同一个，新建没有）。
 */
export const flowSaveRequestSchema = z.object({ requestId: z.uuid(), version: z.unknown().optional() });
/** 服务端保存（FlowService.save）读的同两项：服务器内部直接保存的（数据管理、助手、改订单连带、登记到货、登记完工）在外层请求的防重复里面，可以不带请求号 */
export const flowSaveMetaSchema = flowSaveRequestSchema.partial({ requestId: true });

/**
 * 已生效单据的说明编辑（POST /flow/:id/info）：只传要改的那几项（空字符串是清空）；expectedVersion 是打开时的版本。
 * 每一项的校验和单据保存同一份（physical-flow.ts）。
 */
export const documentInfoSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  notes: noteText.optional(),
  actualTime: arrivalTimeSchema,
  address: noteText.optional(),
  contact: noteText.optional(),
  phone: noteText.optional(),
  operator: operatorText.optional(),
});

/** 确认送达（POST /flow/:id/delivered）：打开时的版本、送达日期（不给是今天，界面预填今天让人确认或改） */
export const flowDeliveredSchema = z.strictObject({ version: z.number().int().positive(), date: dateSchema.optional() });

/** 按核对内容确认（POST /flow/:id/confirm）：预览摘要、请求号（防重复）、确认看过了；送货单可给实际出库日（补录用，不能晚于今天，默认今天） */
export const flowConfirmSchema = z.strictObject({
  previewDigest: previewDigestSchema,
  requestId: z.uuid(),
  acknowledged: z.literal(true),
  shipDate: dateSchema.optional(),
});

/** 单据的取消（还没核对的作废）和撤销（已核对的撤回）：各一个地址 POST /flow/:id/<动作> */
export const flowUndoActions = ['cancel', 'reverse'] as const;
/** 取消、撤销的输入：核对时的版本号、原因、确认看过了 */
export const flowUndoSchema = z.strictObject({
  version: z.number().int(),
  reason: z.string().trim().min(1).max(UNDO_REASON_MAX_LENGTH),
  acknowledged: z.literal(true),
});

/** 按核验结果登记完工（POST /flow/production-completion/execute）：核验时的输入、核验拿到的预览摘要 */
export const completionExecuteSchema = z.strictObject({ input: productionCompletionSchema, previewDigest: previewDigestSchema });
