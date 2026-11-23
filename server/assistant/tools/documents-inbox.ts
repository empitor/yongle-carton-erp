// 助手工具：唛头参考、收件箱、单据模板和单据预览、导出进度和最近的导出（documents.export 的执行在 chat/workflow-cards.ts 和 workflow-direct.ts）。
import { MarkService } from '../../sales/index.js';
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { canEnterSuperMode } from '../../core/index.js';
import { BusinessDocuments, listExports } from '../../documents/index.js';
import { DocumentTemplateSettings } from '../../documents/index.js';
import { InboxService } from '../../inbox/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { paging, uuid, positive, requireActor, type ToolContext } from './context.js';
import { planTool, readTool, toolSpec } from './define.js';
import { rehearse } from '../../core/index.js';
import { dateSchema, quantityText } from '../../../shared/core/index.js';
import { documentExportSchema, documentKinds } from '../../../shared/documents/index.js';
import { inboxChannels, inboxStatuses } from '../../../shared/import/index.js';
import { MAX_SCHEDULE_ENTRIES } from '../../../shared/business/index.js';
import { INBOX_TEXT_CHARS } from '../chat/workflow-args.js';

const exportsSchema = z.strictObject({ ...paging });
/** 收件箱列表：一次默认几条、最多几条（文字只给前 INBOX_TEXT_CHARS 个字，和卡片上一样） */
const INBOX_LIST_DEFAULT = 20;
const INBOX_LIST_MAX = 50;
const inboxListSchema = z.strictObject({
  id: positive.optional(),
  status: z.enum(inboxStatuses).optional(),
  channel: z.enum(inboxChannels).optional(),
  q: z.string().max(INBOX_TEXT_CHARS).optional(),
  limit: z.number().int().min(1).max(INBOX_LIST_MAX).optional(),
});
const inboxStatusSchema = z.strictObject({
  id: positive,
  status: z.enum(inboxStatuses),
  expectedVersion: positive,
});
/** 方案里存的参数（确认后执行时按同一份结构再取） */
const inboxStatusArgs = z.strictObject({ id: positive, input: inboxStatusSchema.omit({ id: true }) });

export const documentInboxTools = [
  readTool({ name: 'marks.list', description: '查产品下挂的参考唛头。', schema: z.strictObject({ productId: positive }) }, (ctx, v, who) => {
    requireActor(who);
    return new MarkService(ctx.store).list(v.productId);
  }),
  readTool(
    {
      name: 'inbox.list',
      description:
        '查收件箱里外来的消息和文件（手动添加的，或企业微信、飞书、钉钉机器人收来的）。列表里文字只给前 200 字；传 id 读那一条的完整文字、发件人、文件名和状态（不含文件内容）。',
      schema: inboxListSchema,
    },
    listInbox,
  ),
  planTool(
    {
      name: 'inbox.set_status',
      risk: 'review',
      description: '把收件标为已处理、已忽略或恢复待处理，不建业务单据。expectedVersion 用 inbox.list 读到的 version。',
      schema: inboxStatusSchema,
    },
    {
      build: buildInboxStatus,
      commit: (ctx, plan, actor) => {
        const { id, input } = inboxStatusArgs.parse(plan.args);
        return new InboxService(ctx.store).setStatus(id, input, actor);
      },
    },
  ),
  readTool(
    {
      name: 'documents.templates',
      description:
        '查单据模板：要知道采购订货单、送货单默认用哪个模板时用。返回模板 id、版本和格式；documents.export 的 templateId 从这里取。',
      schema: z.strictObject({}),
    },
    (ctx, _v, who) => {
      requireActor(who);
      return new DocumentTemplateSettings(ctx.store).get();
    },
  ),
  readTool(
    {
      name: 'documents.preview',
      description:
        '看单据内容：要看采购订货单、送货单这类文件上写的是什么（按模板排好的完整内容）时用，kind 和 id 是采购单或送货单的；查到货进度用 order_batch.get。不改任何状态。',
      schema: z.strictObject({ kind: z.enum(documentKinds), id: positive, templateId: documentExportSchema.shape.templateId }),
    },
    (ctx, v, who) => {
      requireActor(who);
      return new BusinessDocuments(ctx.store).form(v.kind, v.id, v.templateId).form;
    },
  ),
  readTool(
    {
      name: 'documents.status',
      description:
        '查一次导出的文件交付到哪一步、采购单订没订上（按 exportId）。ready 只是生成了，completed 才算交付，交付前不能说已订货。fileExpired=true（或下载返回 410）时用新 requestId 重新 documents.export；message 说订货单已作废时照原话告诉用户。',
      schema: z.strictObject({ exportId: uuid }),
    },
    (ctx, v, who) => new BusinessDocuments(ctx.store).status(v.exportId, requireActor(who)),
  ),
  toolSpec({
    name: 'documents.export',
    risk: 'workflow',
    description:
      '导出订货单、送货单文件，先查最新 version。采购传 markOrdered=true，交付后就标为已订货，不要另外改采购单状态；送货单传 markShipped=true，交付后出库扣库存。同一供应商几张采购单合一份：先 order_batch.draft，再传 purchases，schedule 的 row 用 draft 行号，日期只写用户说的。重试沿用原 requestId。',
    // 助手合并导出时到货安排按行号写（order_batch.draft 里的 row），服务端换成行键
    schema: z
      .strictObject({
        ...documentExportSchema.shape,
        schedule: z
          .array(z.strictObject({ row: positive, quantity: quantityText, dueDate: dateSchema.nullable() }))
          .max(MAX_SCHEDULE_ENTRIES)
          .optional(),
      })
      .refine((v) => !v.markOrdered || v.kind === 'purchase', '只有采购订货单可以标记已订货')
      .refine((v) => !v.markShipped || v.kind === 'delivery', '只有送货单可以导出出库'),
  }),
  readTool(
    {
      name: 'exports.list',
      description: '查最近的单据导出：哪张单、格式、文件名、交付到哪一步、文件过期没有；没交付完的看 jobs.status。',
      schema: exportsSchema,
    },
    listRecentExports,
  ),
];

function listInbox(ctx: ToolContext, { id, limit, ...filters }: z.output<typeof inboxListSchema>, who: Actor | null | undefined) {
  requireActor(who);
  // 传 id 读一条的全文（列表里的文字截到 200 字）
  if (id) return getInbox(ctx, id);
  const result = new InboxService(ctx.store).list(filters, {
    page: 1,
    pageSize: limit ?? INBOX_LIST_DEFAULT,
  });
  return {
    ...result,
    rows: result.rows.map((r) => ({ ...r, text: String(r.text || '').slice(0, INBOX_TEXT_CHARS) })),
  };
}

function getInbox(ctx: ToolContext, id: number) {
  return new InboxService(ctx.store).get(id);
}

/** 一条导出记录写成中文（jobs.status 也用） */
export function exportText(e: ReturnType<typeof listExports>['rows'][number]) {
  return {
    导出时间: e.createdAt,
    单据: (e.kind === 'purchase' ? '采购单 ' : '送货单 ') + e.id,
    格式: e.format === 'xlsx' ? 'Excel' : 'Word',
    文件名: e.filename,
    交付: e.completedAt ? '交付完成' : e.deliveredAt ? '已下载' : '已生成，还没下载',
    ...(e.fileExpired ? { 文件: '已过期，要用新的请求号重新导出' } : {}),
    导出编号: e.requestId,
  };
}

function listRecentExports(ctx: ToolContext, v: z.output<typeof exportsSchema>, who: Actor | null | undefined) {
  const actor = requireActor(who);
  // 和导出状态接口同一条规矩：导出属于导出它的账号；超级管理员看全部
  const page = listExports(ctx.store, { actorId: canEnterSuperMode(actor) ? undefined : actor.id }, v);
  return { 共: page.total, 列表: page.rows.map(exportText), 还有更多: v.offset + page.rows.length < page.total };
}

function buildInboxStatus(ctx: ToolContext, tool: string, { id, ...input }: z.output<typeof inboxStatusSchema>, actor: Actor): ToolPlan {
  const inbox = new InboxService(ctx.store);
  const after = rehearse(ctx.store.db, () =>
    inbox.setStatus(id, input, actor),
  );
  return { tool, args: { id, input }, label: '更新收件箱状态', highRisk: false, before: inbox.get(id), after, warnings: [] };
}
