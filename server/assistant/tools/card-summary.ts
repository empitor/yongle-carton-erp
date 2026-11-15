// 确认卡片上给人看的内容：服务器在出方案时写好、存进方案（plan.summary），页面原样列出，不再拿改前改后去猜。
// 每张卡片固定两样：动的是哪条（模块叫法加单号或名称，订单带客户名；标题里也带上），
// 和这一步会发生什么（修改类逐个列出变了的字段；动库存的写明每行品名数量和库存从多少变成多少；归档恢复写成一句）。
// 改后的样子、库存怎么变，都在回滚点里按确认时同一个执行函数试一遍再读出来，不另算一套。
// 动的是哪几条在 card-targets.ts，每一行怎么写在 card-lines.ts。
import type { Actor } from '../../core/index.js';
import { historyRefs } from '../../business/index.js';
import { arrivalSchema, cardChanges, cardContents, deliverySchema, productionSchema, purchaseSchema, stockItemSchema, supplierSchema, taskSchema } from '../../../shared/business/index.js';
import { customerSchema, orderSchema, productSchema } from '../../../shared/core/index.js';
import { planModule, type Obj, type ToolPlan } from '../plan-rules.js';
import { type ToolContext } from './context.js';
import { refuseAsync, rehearseChanges, type Touched } from './card-rehearsal.js';
import { correctionCardLines } from './corrections.js';
import { asTarget, readTarget, targets, type Target } from './card-targets.js';
import { batchLines, briefOf, documentLines, flowKindOf, newTitle, recordTitle, stockLines, type Line } from './card-lines.js';
import { asList, field, isRecord } from '../chat/result-fields.js';

/** 回滚点里试出来的：目标记录改后的样子、顺带动到的记录（改后）、库存净变化 */
type Tried = { after: (Obj | undefined)[]; changes: (Touched & { after: Obj | undefined })[]; moves: { item: number; delta: number }[] };
/** 顺带动到的记录，带上改前的样子（新建的没有改前，删掉的没有改后） */
type Other = Touched & { before: Obj | undefined; after: Obj | undefined };

/** 这个模块人能改的字段（卡片上一个都不能漏）：它的参数结构里的字段；明细（lines）和完工单的领料（materials）另列 */
const editableShapes: Record<string, { top: object; lines: object[] }> = {
  customers: { top: customerSchema.shape, lines: [] },
  suppliers: { top: supplierSchema.shape, lines: [] },
  products: { top: productSchema.shape, lines: [] },
  orders: { top: orderSchema.shape, lines: [orderSchema.shape.lines.element.shape] },
  purchases: { top: purchaseSchema.shape, lines: [purchaseSchema.shape.lines.element.shape] },
  stock_items: { top: stockItemSchema.shape, lines: [] },
  arrival: { top: arrivalSchema.shape, lines: [arrivalSchema.shape.lines.element.shape] },
  delivery: { top: deliverySchema.shape, lines: [deliverySchema.shape.lines.element.shape] },
  production: { top: productionSchema.shape, lines: [productionSchema.shape.materials.element.shape] },
  task: { top: taskSchema.shape, lines: [] },
};
export function editableFields(module: string) {
  const shapes = Object.hasOwn(editableShapes, module) ? editableShapes[module] : undefined;
  return { top: new Set(shapes ? Object.keys(shapes.top) : []), lines: new Set(shapes ? shapes.lines.flatMap((s) => Object.keys(s)) : []) };
}

/** 按确认时同一个执行函数在回滚点里试一遍：读出改后的目标记录、顺带动到的记录和库存净变化（card-rehearsal.ts） */
function rehearse(ctx: ToolContext, plan: ToolPlan, actor: Actor, binding: string, list: Target[]): Tried {
  const tried = rehearseChanges(
    ctx,
    () => {
      // 执行函数要等结果的不试（回滚之后它接着写的会真的落库）：它包在试执行的函数里，返回值要单独查
      refuseAsync(ctx.tools.commit(plan, actor, binding));
      return list.map((t) => readTarget(ctx, t, actor));
    },
    (t) => readTarget(ctx, asTarget(t), actor),
  );
  return { after: tried.result, changes: tried.changes, moves: tried.stock };
}

/**
 * 流程类卡片（chat/workflow-cards.ts）写一条记录或一张单据会怎样，用同一份写法：title 是动的是哪条（带客户或供应商），
 * lines 是每行品名数量；给了 rehearsal 就在回滚点里按确认后同一个执行函数试一遍，接上库存从多少变成多少。
 */
export function recordCard(ctx: ToolContext, module: string, id: number, actor: Actor, rehearsal?: () => unknown) {
  const row = readTarget(ctx, asTarget({ module, id }), actor);
  const moves = rehearsal ? rehearseChanges(ctx, rehearsal, () => undefined).stock : [];
  return { title: recordTitle(module, row), lines: [...documentLines(ctx, row), ...stockLines(ctx, moves)] };
}

/** 给方案写上卡片内容和带名称的标题。删除（records.delete，卡片按删除预览画）、清空、识别工作区有自己的卡片，不另试一遍 */
export function withCard(ctx: ToolContext, plan: ToolPlan, actor: Actor, binding: string): ToolPlan {
  if (plan.summary || plan.tool === 'records.delete') return plan;
  const own = ownCard(plan);
  return own ? { ...plan, summary: own } : changeCard(ctx, plan, actor, binding);
}

/** 识别工作区、一键清空：不在回滚点里试（会动文件或要先拍快照），写清楚动哪些、多少 */
function ownCard(plan: ToolPlan): Line[] | undefined {
  if (plan.tool === 'management.workspaces')
    return (asList(plan.before) ?? []).map((w) => ({ label: '文件', value: field(w, 'fileName') + (field(w, 'state') ? '（' + field(w, 'state') + '）' : '') }));
  if (plan.tool === 'management.reset') {
    const tables = field(plan.before, 'tables');
    const total = Object.values(isRecord(tables) ? tables : {}).reduce((n: number, v) => n + Number(v), 0);
    return [{ label: '清空', value: plan.label + '，共 ' + total + ' 条记录' }];
  }
  return undefined;
}

/** 方案里写的动作（数据管理命令写在 input 里） */
const planAction = (plan: ToolPlan) => field(plan.args, 'action') ?? field(field(plan.args, 'input'), 'action');
const archivingPlan = (plan: ToolPlan, action: unknown) =>
  plan.tool === 'records.propose_lifecycle' || plan.tool === 'records.propose_batch_lifecycle' || action === 'archive' || action === 'restore';
/** 收件改成的状态 */
const inboxStatusNames: Record<string, string> = { pending: '待处理', converted: '已处理', ignored: '已忽略' };

/** 改记录、单据、库存的卡片：在回滚点里试一遍，列出目标记录变了什么、顺带动到的记录和库存前后 */
function changeCard(ctx: ToolContext, plan: ToolPlan, actor: Actor, binding: string): ToolPlan {
  const list = targets(plan);
  const before = list.map((t) => readTarget(ctx, t, actor));
  const tried = rehearse(ctx, plan, actor, binding, list);
  const isTarget = (t: Touched) => list.some((x) => x.module === t.module && x.id === t.id);
  // 这一步新建的记录（不管从哪条命令来）：试执行前没有、试执行后有
  const others: Other[] = tried.changes.filter((c) => !isTarget(c)).map((c) => ({ ...c, before: readTarget(ctx, asTarget(c), actor) }));
  const titles = cardTitles(ctx, plan, list, before, others);
  const lines: Line[] = [];
  const action = planAction(plan),
    archiving = archivingPlan(plan, action);
  // 归档、恢复那一行已经逐条写了名称，不再另列“记录”
  // 新建的那条在下面“新建”里列全，不另列“记录”
  if (titles.length && !archiving && list.length) lines.push({ label: titles.length > 1 ? '记录（' + titles.length + ' 条）' : '记录', value: titles.join('、') });
  if (archiving) lines.push(archiveLine(plan, action, titles));
  else lines.push(...targetLines(ctx, plan, { list, before, tried, titles }));
  lines.push(...sideLines(ctx, others, !list.length ? mainModule(plan) : ''));
  if (plan.tool === 'inbox.set_status') {
    const status = field(field(plan.args, 'input'), 'status');
    lines.push({ label: '改成', value: (typeof status === 'string' && Object.hasOwn(inboxStatusNames, status) ? inboxStatusNames[status] : undefined) ?? String(status) });
  }
  lines.push(...stockLines(ctx, tried.moves));
  const reason = field(field(plan.args, 'input'), 'reason') ?? field(plan.args, 'reason');
  if (typeof reason === 'string' && reason.trim()) lines.push({ label: '原因', value: reason.trim() });
  const name = titles.length > 1 ? titles[0] + ' 等 ' + titles.length + ' 条' : titles[0];
  if (titles.length && !lines.length) lines.push({ label: '记录', value: titles.join('、') });
  return { ...plan, label: name && !plan.label.includes(name) ? plan.label + '：' + name : plan.label, summary: lines };
}

/** 卡片标题里的名称：有目标记录写目标记录；没有目标、这一步新建了记录的，写新建的那条（和方案同一个模块的优先） */
function cardTitles(ctx: ToolContext, plan: ToolPlan, list: Target[], before: (Obj | undefined)[], others: Other[]) {
  const created = others.filter((c): c is Other & { after: Obj } => !c.before && !!c.after);
  if (list.length || !created.length) return list.map((t, i) => recordTitle(t.module, before[i])).filter(Boolean);
  const main = mainModule(plan);
  const shown = created.some((c) => c.module === main) ? created.filter((c) => c.module === main) : created.slice(0, 1);
  return shown.map((c) => newTitle(ctx, c.module, c.after));
}

/** 归档、恢复写成一句：逐条写名称 */
function archiveLine(plan: ToolPlan, action: unknown, titles: string[]): Line {
  const first = (asList(field(plan.args, 'children')) ?? [])[0];
  const archive = (plan.tool === 'records.propose_batch_lifecycle' ? field(field(first, 'args'), 'action') : action) === 'archive';
  return { label: archive ? '归档' : '恢复', value: titles.join('、') + (archive ? '（不删除，可以恢复）' : '（恢复后照常使用）') };
}

/** 目标记录变了什么：改字段的命令按参数结构一个不漏；单据另列每行，订货单另列到货安排和已到 */
function targetLines(ctx: ToolContext, plan: ToolPlan, card: { list: Target[]; before: (Obj | undefined)[]; tried: Tried; titles: string[] }): Line[] {
  const { list, tried, titles } = card;
  const lines: Line[] = [];
  list.forEach((t, i) => {
    const before = card.before[i],
      after = tried.after[i];
    if (!before || !after) return;
    // 改字段的命令按参数结构一个不漏；核对、撤销、取消这类动作只看状态和库存（核对时补上的验收数、尺寸快照不算人改的）
    const editing = plan.tool === 'records.propose_save' || plan.tool === 'management.execute';
    const items = cardChanges(t.module, before, after, historyRefs(ctx.store, [{ before, after }]), editing ? editableFields(t.module) : { top: new Set<string>(), lines: new Set<string>() });
    for (const item of items) lines.push(list.length > 1 ? { label: titles[i] + ' ' + item.label, value: item.value } : item);
    // 目标记录也一样：改了、但一行都列不出来时明说，不出一张空卡片（测试拦着这句，看到就去补叫法）
    // 库存品的余额变化在“库存”那几行里写了
    const moved = t.module === 'stock_items' && tried.moves.some((m) => m.item === t.id);
    // 订货单、收件有自己专门的几行（到货安排和已到前后、改成什么状态）
    const own = t.module === 'order_batch' || t.module === 'inbox';
    if (!items.length && !moved && !own && stable(before) !== stable(after)) lines.push({ label: titles[i] || '记录', value: UNLISTED });
    // 更正送货单、完工单逐行写更正前后（取自预览），别的单据列原单每行
    if (flowKindOf(t.module)) lines.push(...(correctionCardLines(plan) ?? documentLines(ctx, before)));
    if (t.module === 'order_batch') lines.push(...batchLines(plan, before, after));
  });
  return lines;
}

/**
 * 这一步顺带动到的别的记录：新建的列全内容，删掉的写明删哪条，改了的逐个字段列前后（和目标记录同一个比法）。
 * creating：这张方案本身就是新建（没有别的目标），第一条新建的记录写成“新建”，不叫“连带”。
 */
function sideLines(ctx: ToolContext, others: Other[], creating: string): Line[] {
  const out: Line[] = [];
  others.forEach((c, i) => {
    // 这一步本身新建的（和方案同一个模块，一次几条的每条都是）写成“新建”并列全；别的叫“连带”
    const prefix = creating && !c.before && (c.module === creating || (i === 0 && !others.some((o) => o.module === creating))) ? '' : '连带：';
    if (!c.before && c.after) out.push(...createdLines(ctx, c.module, c.after, prefix));
    else if (c.before && !c.after) out.push({ label: prefix + '删除', value: recordTitle(c.module, c.before) });
    else if (c.before && c.after) out.push(...changedLines(ctx, c.module, c.before, c.after));
  });
  return out;
}
/** 新建的记录：这一步本身新建的列全内容；连带新建的一行摘要（哪种单据、单号、每行品名数量），不逐个字段罗列，免得盖住这一步的重点 */
function createdLines(ctx: ToolContext, module: string, after: Obj, prefix: string): Line[] {
  if (prefix) {
    const brief = briefOf(ctx, module, after);
    return [{ label: prefix + '新建', value: newTitle(ctx, module, after) + (module === 'order_batch' && brief ? '：' + brief : '') }];
  }
  // 单号确认建出来才定（试执行拿到的号不占住），内容里也不写
  const { number: _number, ...row } = after;
  return [{ label: '新建', value: newTitle(ctx, module, after) }, ...cardContents(module, row, historyRefs(ctx.store, [{ after: row }]))];
}
/** 连带改了的记录：逐个字段列前后 */
function changedLines(ctx: ToolContext, module: string, before: Obj, after: Obj): Line[] {
  const items = cardChanges(module, before, after, historyRefs(ctx.store, [{ before, after }]), editableFields(module));
  const out = items.map((item) => ({ label: '连带：' + recordTitle(module, before) + ' ' + item.label, value: item.value }));
  // 兜底：改了、但修改历史那套写法列不出来的（派生的进度、合计这类），也要说一声动了哪条
  // 库存品的余额变化在“库存”那几行里写了
  if (!items.length && module !== 'stock_items' && stable(before) !== stable(after))
    out.push({ label: '连带：' + recordTitle(module, before), value: '跟着更新（进度、合计这类由单据算出的内容）' });
  return out;
}

/** 目标记录有改动、但字段叫法不全列不出来时卡片上写的话；tests/assistant-card-lines.test.ts 见到它就失败 */
export const UNLISTED = '有改动但列不出明细';
/** 每次保存都会变的版本号、时间：比较前去掉 */
const VOLATILE = new Set(['version', 'updatedAt', 'updated_at', 'confirmedAt']);
/** 比较用的写法：去掉版本号、时间后的 JSON */
const stable = (row: Obj) => JSON.stringify(row, (k: string, v: unknown) => (VOLATILE.has(k) ? undefined : v));

/** 这张方案本身动的模块：数据管理命令写在 input 里，别的按方案认（plan-rules.ts 的 planModule） */
const mainModule = (plan: ToolPlan) => String(field(field(plan.args, 'input'), 'module') ?? planModule(plan));
