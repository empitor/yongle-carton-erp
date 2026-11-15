// 正式导入（order_import.execute）：助手不直接导入，先按最新识别结果生成导入预览、出确认卡片，
// 卡片上列出实际会建什么（客户和每个产品写明用已有档案还是新建，新建的下面列出相近的已有档案；数量、单价、交期、税、合计）。
// 用哪个档案、哪些相近都照导入方案给的列，这里不自己判断。
// 人点确认后逐份导入：每份导入前按当时的数据重新生成预览，和卡片上那一份核对——内容（客户、产品、明细、合计）必须一样，
// 用已有档案的必须还是那一个；卡片上写“新建”的，只有同一张卡片里前面几份刚建出来的才可以改用（五份同一个新客户，只建一次）。
// 对不上（识别结果、档案之后被改了）就拒绝，要重新出卡片。
import { createHash } from 'node:crypto';
import { AppError, failureMessage, requirePermission } from '../core/index.js';
import { FINISHED_UNIT, linePriceExact, plainPrice } from '../../shared/core/index.js';
import { prepare } from './order-import-prepare.js';
import { attach } from './order-import-intake.js';
import type { ImportPreview, OrderImportState, Task, WorkflowContext } from './order-import-state.js';

type Plan = ImportPreview['plan'];
/** 导入方案里一个客户或一行产品用哪个档案；新建的带相近的已有档案（similar） */
type Ref = Plan['customer'] | Plan['products'][number];
/** 卡片存下来、确认时用来核对的：这份文件导进去的内容摘要，客户和每个产品用哪个已有档案（null 是新建） */
export type ImportCardItem = {
  taskId: string;
  workspaceId: string;
  fileName: string;
  content: string;
  customerId: number | null;
  productIds: (number | null)[];
  /** 要新建、但已有同名产品的行：卡片上列出来了，确认即表示“是另一个产品” */
  sameNameLines: string[];
};
type Line = { label: string; value: string };
/** 预览通过、可以导入的一份 */
type Ready = { task: Task; preview: ImportPreview };

const refId = (ref: Ref) => (ref.mode === 'existing' ? ref.id : null);
/** 卡片上怎么写这个客户或产品用哪个档案 */
const archive = (ref: Ref) => (ref.mode === 'new' ? '新建' : '用已有档案：' + ref.name);
/** 新建的下面一行：相近的已有档案（导入方案给的，带名称和资料），人一眼看出是不是建重了；没有相近的不列。listed：下面另有一行已经列过的 */
function similar(label: string, ref: Ref, listed: readonly string[] = []): Line[] {
  const rest = ref.mode === 'new' ? ref.similar.filter((s) => !listed.includes(s)) : [];
  return rest.length ? [{ label, value: rest.join('；') }] : [];
}
/** 一份导入方案里和“用哪个档案编号”无关的全部内容：客户名、产品名、订单各字段和明细、合计 */
function contentDigest(plan: Plan) {
  const { customerId: _c, lines, ...order } = plan.order;
  const content = {
    customer: plan.customer.name,
    products: plan.products.map((p) => p.name),
    order: { ...order, lines: lines.map(({ productId: _p, ...line }) => line) },
    total: plan.total,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** 第几行明细写成一句：品名规格、数量、单价、交期、用哪个档案 */
function lineText(plan: Plan, i: number) {
  const l = plan.order.lines[i];
  return (
    (l.productName || plan.products[i].name) +
    (l.specification ? ' ' + l.specification : '') +
    '，' + l.quantity + ' ' + FINISHED_UNIT +
    '，单价 ' + plainPrice(linePriceExact(l)) +
    (l.deliveryDate ? '，交期 ' + l.deliveryDate : '') +
    '（' + archive(plan.products[i]) + '）'
  );
}
function summary({ task, preview }: Ready, many: boolean): Line[] {
  const plan = preview.plan,
    order = plan.order,
    head = many ? task.fileName + ' · ' : '';
  const line = (label: string, value: unknown) =>
    value == null || value === '' ? [] : [{ label: head + label, value: String(value) }];
  return [
    ...(many ? [] : line('文件', task.fileName)),
    ...line('客户', plan.customer.name + '（' + archive(plan.customer) + '）'),
    ...similar(head + '相近的已有客户', plan.customer),
    ...line('客户订单号', order.externalPurchaseOrder),
    ...line('订单日期', order.orderDate),
    ...line('交货日期', order.deliveryDate),
    ...line('税率', order.taxRate),
    ...line('含税情况', order.taxMode),
    ...order.lines.flatMap((_l, i) => {
      const confirmations = plan.confirmations.filter((c) => c.line === i + 1);
      return [
        ...line('第 ' + (i + 1) + ' 行', lineText(plan, i)),
        // 已有同名产品的那一行：紧跟在这一行下面写明，确认即表示是另一个产品；别的相近档案另列一行
        ...confirmations.flatMap((c) => line('第 ' + c.line + ' 行已有同名的产品', c.existing.join('；') + '。确认即表示这是另一个产品。')),
        ...similar(
          head + '第 ' + (i + 1) + ' 行相近的已有产品',
          plan.products[i],
          confirmations.flatMap((c) => c.existing),
        ),
      ];
    }),
    ...line('合计', plan.total),
  ];
}

/** 要导的几份：workspaceIds 给了就先各自关联到这个会话（和 order_import.attach 一样先核对权限），没给就是当前（或指定的）任务 */
async function pickTasks(wf: OrderImportState, ctx: WorkflowContext, ids: string[], taskId?: string) {
  if (!ids.length) return [wf.selected(ctx, taskId).task];
  const tasks: Task[] = [];
  for (const workspaceId of ids) {
    requirePermission(ctx.check(), 'business:edit');
    tasks.push((await attach(wf, { workspaceId }, ctx)).task);
  }
  return tasks;
}
/** 每份按最新识别结果出预览：过不了的、已经导入过的分开记下 */
async function previewTasks(wf: OrderImportState, ctx: WorkflowContext, tasks: Task[]) {
  const ready: Ready[] = [],
    blocked: string[] = [],
    imported: string[] = [];
  for (const picked of tasks) {
    const w = wf.imports.get(picked.workspaceId);
    if (w.mode && w.mode !== 'order') throw new AppError(picked.fileName + ' 是到货单，不能当客户订单导入。', 409);
    // 已经导入过的不重复导入：一批里的跳过它，卡片上写明
    if (w.imported && !w.imported.historical) {
      imported.push(picked.fileName + '（订单 ' + w.imported.orderNumber + '）');
      continue;
    }
    const { state, task } = wf.selected(ctx, picked.id);
    await prepare(wf, ctx, state, task);
    if (!task.preview || task.error) blocked.push(task.fileName + '：' + (task.error || '导入预览没有通过'));
    else ready.push({ task, preview: task.preview });
  }
  return { ready, blocked, imported };
}

/** 出卡片：taskId 省略是当前识别任务；workspaceIds 是一次导入几份（先各自关联到这个会话）。 */
export async function importCard(
  wf: OrderImportState,
  ctx: WorkflowContext,
  args: { taskId?: string; workspaceIds?: string[] },
): Promise<{ label: string; summary: Line[]; warnings: string[]; args: { imports: ImportCardItem[] } }> {
  requirePermission(ctx.check(), 'import:execute');
  const ids = [...new Set(args.workspaceIds ?? [])];
  if (ids.length) ctx = { ...ctx, batchWorkspaceIds: ids };
  const { ready, blocked, imported } = await previewTasks(wf, ctx, await pickTasks(wf, ctx, ids, args.taskId));
  // 有一份过不了就不出卡片：把每份的原因交给模型，由它说明、先改好，或者只导能导的那几份
  if (blocked.length) throw new AppError(blocked.join('；'), 409);
  if (!ready.length) throw new AppError('已经导入过，不会重复导入：' + imported.join('、'), 409);
  const many = ready.length > 1;
  return {
    label: many ? '正式导入 ' + ready.length + ' 份订单' : '正式导入订单：' + ready[0].task.fileName + '（' + ready[0].preview.plan.customer.name + '）',
    summary: [
      ...ready.flatMap((r) => summary(r, many)),
      ...(imported.length ? [{ label: '已经导入过，这次跳过', value: imported.join('、') }] : []),
    ],
    warnings: [...new Set(ready.flatMap((r) => r.preview.plan.warnings))],
    args: {
      imports: ready.map(({ task, preview }) => ({
        taskId: task.id,
        workspaceId: task.workspaceId,
        fileName: task.fileName,
        content: contentDigest(preview.plan),
        customerId: refId(preview.plan.customer),
        productIds: preview.plan.products.map(refId),
        sameNameLines: preview.plan.confirmations.map((c) => c.lineId),
      })),
    },
  };
}

const CHANGED = '和确认卡片上的不一样了（识别结果或档案在出卡片之后变过），没有导入；请重新出卡片核对。';

/** 一份导入的结果：成了带上订单和链接，没成的写原因 */
type ImportResult =
  | { workspaceId: string; fileName: string; success: true; order: { id: number; number: string; customerName: string }; url: string; message: string }
  | { workspaceId: string; fileName: string; success: false; message: string };
/** 这张卡片里前面几份刚建出来的客户、产品：后面几份卡片上写“新建”的可以改用它们 */
type JustMade = { customers: Set<number>; products: Set<number> };
const sameRef = (carded: number | null, ref: Ref, justMade: Set<number>) =>
  ref.mode === 'new' ? carded === null : carded === ref.id || (carded === null && justMade.has(ref.id));

/** 导一份：按当时的数据重出预览，和卡片上那一份核对，对上了才导 */
async function importOne(wf: OrderImportState, ctx: WorkflowContext, item: ImportCardItem, made: JustMade): Promise<ImportResult> {
  const { state, task } = wf.selected(ctx, item.taskId);
  await prepare(wf, ctx, state, task);
  if (!task.preview || task.error) throw new AppError(task.error || '导入预览没有通过', 409);
  const plan = task.preview.plan;
  if (
    contentDigest(plan) !== item.content ||
    !sameRef(item.customerId, plan.customer, made.customers) ||
    plan.products.length !== item.productIds.length ||
    plan.products.some((p, i) => !sameRef(item.productIds[i], p, made.products))
  )
    throw new AppError(item.fileName + CHANGED, 409);
  const receipt = await wf.execution.execute(
    item.workspaceId,
    {
      expectedRevision: plan.source.revision,
      previewDigest: task.preview.previewDigest,
      acknowledged: true,
      distinctProducts: item.sameNameLines,
    },
    ctx.check(),
    ctx.check,
  );
  const order = wf.store.order(receipt.orderId, true);
  if (!order) throw new AppError('导入的订单 ' + receipt.orderNumber + ' 读不到了，请到订单列表核对。', 409);
  made.customers.add(order.customerId);
  for (const line of order.lines) made.products.add(line.productId);
  task.state = 'imported';
  task.result = { orderId: order.id, orderNumber: order.number };
  task.error = undefined;
  wf.save(ctx, state);
  ctx.emit('effect', { type: 'business', url: '#orders?order=' + order.id, workspaceId: item.workspaceId });
  return {
    workspaceId: item.workspaceId,
    fileName: item.fileName,
    success: true,
    order: { id: order.id, number: order.number, customerName: order.customerName },
    url: '#orders?order=' + order.id,
    message: '已导入，订单 ' + order.number + '，客户 ' + order.customerName + '，' + order.lines.length + ' 行。',
  };
}

/** 人点了确认：逐份导入。一份的直接抛错；几份的各记各的结果，成功的不回滚。 */
export async function executeImports(wf: OrderImportState, ctx: WorkflowContext, imports: ImportCardItem[]) {
  requirePermission(ctx.check(), 'import:execute');
  ctx = { ...ctx, batchWorkspaceIds: imports.map((i) => i.workspaceId) };
  const made: JustMade = { customers: new Set<number>(), products: new Set<number>() };
  const results: ImportResult[] = [];
  for (const item of imports) {
    try {
      results.push(await importOne(wf, ctx, item, made));
    } catch (e) {
      if (imports.length === 1) throw e;
      results.push({
        workspaceId: item.workspaceId,
        fileName: item.fileName,
        success: false,
        message: failureMessage(e, '助手导入订单 ' + item.workspaceId, '导入失败'),
      });
    }
  }
  // 只导一份的失败已经抛出去了：只有一条结果时就是导成了的那一份
  const only = results.length === 1 ? results[0] : undefined;
  return {
    results,
    ...(only?.success ? { order: only.order, url: only.url } : {}),
    message: results.map((r) => r.fileName + '：' + r.message).join('；'),
  };
}
