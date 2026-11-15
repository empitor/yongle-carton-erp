// 只管：AI 导入（order_import.*）的工具定义。执行在 order-workflow.ts 和 order-import-*.ts。
import { DRAFT_NOTE_MAX, DRAFT_VALUE_MAX, headerFields, lineFields, patchOperationSchema, recognitionModes } from '../../../shared/import/index.js';
import { positive, uuid } from './context.js';
import { z } from 'zod';
/** 表头、明细的字段合在一起（重复的只留一个，先后照旧），给 z.enum 用 */
const [firstField, ...otherFields] = [...new Set([...headerFields, ...lineFields])];
/** 一次识别最多几份订单文件 */
export const MAX_ORDER_ATTACHMENTS = 6;
/**
 * 给模型看的修改写法：改表头、改明细合成一个对象（set-line 才带 lineId，field 按 op 用表头或明细的字段），
 * 省掉两份重复结构；每条再按 patchOperationSchema 校验，接受的写法和原来一样。
 */
const editOperation = z
  .strictObject({
    op: z.enum(['set-header', 'set-line']),
    lineId: uuid.optional(),
    field: z.enum([firstField, ...otherFields]),
    value: z.string().max(DRAFT_VALUE_MAX).nullable(),
    reason: z.string().max(DRAFT_NOTE_MAX),
  })
  .refine((v) => patchOperationSchema.safeParse(v).success, '改表头不带 lineId、field 用表头字段；改明细要带 lineId、field 用明细字段');
const task = { taskId: uuid.optional() };
/** 识别成哪一类：客户订单或供应商到货单，省略是客户订单 */
const recognitionType = z.enum(recognitionModes).default('order');
/** order_import.from_inbox 的参数；执行时（order-import-intake.ts 的 fromInbox）按同一份结构取值 */
export const fromInboxArgs = z.strictObject({ inboxId: positive, expectedVersion: positive, recognitionType });
/** 一张导入卡片最多几份订单 */
const MAX_IMPORTS_PER_CARD = 6;
export const orderImportTools = [
  {
    name: 'order_import.list',
    description:
      '列出订单导入页里能看到的工作区（含手工上传的），不识别。',
    arguments: {},
    risk: 'workflow',
    schema: z.strictObject({}),
  },
  {
    name: 'order_import.from_inbox',
    description:
      '把收件箱的文件转进 AI 导入（不识别、不收费）。订单关联到当前任务，要识别接着用 order_import.start；到货单返回 workspaceId，接着用 arrival.recognize；唛头不转，用 marks.add 挂到产品。',
    arguments: { inboxId: 1, expectedVersion: 1, recognitionType: [...recognitionModes] },
    risk: 'workflow',
    schema: fromInboxArgs,
  },
  {
    name: 'order_import.attach',
    description:
      '把已有的销售订单工作区关联到当前任务（不复制、不识别、不收费），返回最新识别结果和匹配候选。',
    arguments: { workspaceId: 'list返回的工作区UUID' },
    risk: 'workflow',
    schema: z.strictObject({ workspaceId: uuid }),
  },
  {
    name: 'order_import.start',
    description:
      '识别订单文件：识别会话附件或已在本会话的文件任务（识别要花模型费用）。附件传 attachmentIds，已在本会话的文件任务传 taskIds，都不传时先用当前消息的附件、没有就用当前任务；多份一次传全，不要逐份调；相同文件复用原任务，不重复收费。',
    arguments: {
      attachmentIds: [
        '当前会话附件UUID，可省略；有多份订单时一次传入全部ID',
      ],
      taskIds: [
        '本会话文件任务UUID，可省略；attachmentIds 与 taskIds 都不传时先用当前消息的附件、没有就用当前任务',
      ],
    },
    risk: 'workflow',
    schema: z.strictObject({
      attachmentIds: z.array(uuid).max(MAX_ORDER_ATTACHMENTS).optional(),
      taskIds: z.array(uuid).max(MAX_ORDER_ATTACHMENTS).optional(),
      recognitionType,
    }),
  },
  {
    name: 'order_import.get',
    description:
      '读关联工作区的最新识别结果、金额、匹配候选、预览和错误。',
    arguments: { taskId: '任务UUID，可省略；默认当前任务' },
    risk: 'workflow',
    schema: z.strictObject(task),
  },
  {
    name: 'order_import.select',
    description: '切换文件任务：要在本会话已有的文件任务之间换一份时用，不重新识别；有多个时先问用户是哪份。',
    arguments: { taskId: '本会话任务UUID' },
    risk: 'workflow',
    schema: z.strictObject({ taskId: uuid }),
  },
  {
    name: 'order_import.edit',
    description:
      '改识别结果：operations 写 set-header 或 set-line，lineId 来自 order_import.get；不知道的不猜。',
    arguments: {
      expectedRevision: 'get返回的整数修订',
      operations: [
        {
          op: 'set-line',
          lineId: 'UUID',
          field: 'quantity等识别结果字段',
          value: '用户明确的新值或null',
          reason: '修改原因',
        },
      ],
    },
    risk: 'workflow',
    schema: z.strictObject({
      ...task,
      expectedRevision: z.number().int(),
      operations: z.array(editOperation).min(1).max(100),
    }),
  },
  {
    name: 'order_import.match',
    description:
      '给识别结果匹配客户和产品。不传参数按名称和历史订单自动匹配，模糊的返回差异让人核对；也可指定 customerId，或 line（从 1 起）配 productId/productCode。不凭相似型号猜。',
    arguments: {
      customerId: '客户ID可省略',
      line: '产品行号',
      productId: '产品ID或省略',
      productCode: '用户指定的型号/物料编码，可省略',
      createNew: '这个客户、这一行产品确实要新建档案时传true；有同名或相近档案时先列候选问用户用哪个',
    },
    risk: 'workflow',
    schema: z.strictObject({
      ...task,
      customerId: positive.optional(),
      line: positive.optional(),
      productId: positive.optional(),
      productCode: z.string().min(1).max(100).optional(),
      createNew: z.boolean().optional(),
    }),
  },
  {
    name: 'order_import.preview',
    description: '生成正式导入的完整预览（匹配、新档案、数量金额、税费），不写业务表。',
    arguments: {},
    risk: 'workflow',
    schema: z.strictObject(task),
  },
  {
    name: 'order_import.execute',
    description:
      '正式导入已识别的订单：出确认卡片，卡片上列出客户和每个产品是新建还是用已有的、数量、单价、交期、合计，人确认后才建订单。不传参数是当前这份；一次导入几份传 workspaceIds（来自 order_import.list），一张卡片列全。',
    arguments: { taskId: '可省略，默认当前任务', workspaceIds: ['一次导入几份时传工作区UUID'] },
    risk: 'workflow',
    schema: z.strictObject({ ...task, workspaceIds: z.array(uuid).min(1).max(MAX_IMPORTS_PER_CARD).optional() }),
  },
  {
    name: 'order_import.retry',
    description:
      '重新识别失败的任务（要花模型费用），保留附件和旧结果。',
    arguments: {},
    risk: 'workflow',
    schema: z.strictObject(task),
  },
  {
    name: 'order_import.undo',
    description: '撤回最近一次识别结果修改，不撤销已导入的订单。',
    arguments: {},
    risk: 'workflow',
    schema: z.strictObject(task),
  },
] as const;
