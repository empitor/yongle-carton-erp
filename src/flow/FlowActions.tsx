import { pageHref } from '../../shared/core/index';
import { ActionBar, type RecordAction } from '../ui/index';
import { allWaitingReview } from '../../shared/business/index';
import { cancelLabel, correctLabel, isCorrectable, undoLabel } from './flow-words';
import type { FlowAsk } from './flow-desk-actions';

type ActionBase = { id: number; status: string; archived?: boolean; replacedBy?: number; [field: string]: unknown };
/** 操作条按单据的这些字段定有哪些按钮（单据的其余字段原样交给办理的函数） */
export type ActionDoc =
  | (ActionBase & {
      kind: 'task';
      quantity: string;
      completed: string;
      pendingCompleted?: string;
      progress: number;
      hasProduction?: boolean;
    })
  | (ActionBase & { kind: 'delivery'; shippedAt?: string; deliveredAt?: string })
  | (ActionBase & { kind: 'arrival' | 'production' });
type TaskDoc = Extract<ActionDoc, { kind: 'task' }>;

/** 采购单到货记录上的“更正到货单”：flowId 是它的到货单 */
type ReceiptTarget = { flowId: number };

/** 操作条要用的账号情况和办理的函数（单据页、仓库页由 useFlowDesk 给，交进来的单据原样交回去） */
export type FlowActionContext<D extends ActionDoc = ActionDoc> = {
  /** 本机管理员 */
  local: boolean;
  /** 超级管理员模式 */
  superMode: boolean;
  canEdit: boolean;
  busy: boolean;
  begin: (doc: D) => void;
  setView: (doc: D | null) => void;
  /** 核对入库、不导出直接出库：先看库存怎么变，再确认 */
  review: (doc: D) => void;
  /** 打开登记完工窗口，只带这几张任务 */
  openCompletion: (taskIds: number[]) => void;
  /** 送货单的导出窗（导出送货单出库，或重新下载） */
  exportDelivery: (doc: D) => void;
  /** 打开“调整排程”：按这张单现在的计划日期、时间预填，换一个新的请求号 */
  setScheduling: (doc: D) => void;
  setReturning: (doc: D) => void;
  /** 打开“更正××单”：已生效的到货、送货、完工单改数量这类只有这一条路（撤销原单、另出替代单） */
  correct: (doc: D | ReceiptTarget) => void;
  /** 已生效的到货、送货、完工单的“编辑”：只改说明（备注、时间、地址联系人、操作人），不出替代单 */
  editInfo: (doc: D) => void;
  ask: (type: FlowAsk, rows: D[]) => void;
  setContextId: (id: number | null) => void;
  /** 送货中的送货单：客户收到了 */
  markDelivered: (doc: D) => void;
  /** 这张生产任务名下已登记、还待核对入库的完工单（任务详情读到的完工记录；没读到时是空的） */
  pendingCompletions?: (taskId: number) => D[];
};

/** 按单据的状态算出来的几样，和放按钮的四组 */
type Bar<D extends ActionDoc> = {
  view: D;
  ctx: FlowActionContext<D>;
  draft: boolean;
  confirmed: boolean;
  /** 已生效、没被更正替代的到货、送货、完工单：“编辑”只改说明，改数量用“更正××单” */
  effective: boolean;
  edit: RecordAction;
  schedule: RecordAction;
  editInfo: RecordAction;
  primary: RecordAction[];
  secondary: RecordAction[];
  more: RecordAction[];
  danger: RecordAction[];
};

/** 生产任务：没做完的登记完工；剩下的都在等核对入库的，主按钮是核对入库 */
function taskButtons<D extends ActionDoc>(b: Bar<D>, doc: TaskDoc, openTask: boolean) {
  const { ctx } = b;
  // 生产任务开工前（没有任何完工登记，待入库的也算）还能整张编辑；开工后只调排程（本机管理员在“更多”里还能编辑）
  const untouched = !doc.hasProduction && !Number(doc.completed || 0);
  if (openTask && allWaitingReview(doc)) {
    // 剩下的都已登记、在等核对入库（登记完工窗口里只剩空状态）：主按钮就是核对入库。
    // 只有一张待入库的直接打开它的核对窗；几张的到完工记录的待处理里逐张核对
    const pending = ctx.pendingCompletions?.(doc.id) || [];
    b.primary.push(
      pending.length === 1
        ? {
            label: '核对入库',
            hidden: !ctx.canEdit,
            disabled: ctx.busy,
            title: '剩下的数量都已登记完工，核对入库后成品才进库存',
            onClick: () => ctx.review(pending[0]),
          }
        : {
            label: '核对入库',
            hidden: !ctx.canEdit,
            title: '剩下的数量都已登记完工，到完工记录里逐张核对入库',
            href: pageHref('production', { view: 'production', pending: true }),
          },
    );
    b.secondary.push(b.schedule);
  } else if (openTask) {
    b.primary.push({
      label: '登记完工',
      hidden: !ctx.canEdit,
      title: '登记这张任务做完多少、领了哪些纸板，成品直接入库',
      onClick: () => ctx.openCompletion([doc.id]),
    });
    b.secondary.push(untouched ? b.edit : b.schedule);
    // 开工后整张改（含已入库的数）只有本机管理员，服务端同一个保存
    if (!untouched && ctx.local) b.more.push(b.edit);
  }
}

/** 完工单：待入库的核对入库、编辑；已入库的只改说明，更正要超级管理员模式（和撤销这次完工同一级） */
function productionButtons<D extends ActionDoc>(b: Bar<D>) {
  const { ctx, view } = b;
  if (b.draft) {
    b.primary.push({ label: '核对入库', hidden: !ctx.canEdit, disabled: ctx.busy, onClick: () => ctx.review(view) });
    b.secondary.push(b.edit);
  }
  if (b.effective) {
    b.secondary.push(b.editInfo);
    if (ctx.superMode) b.more.push({ label: correctLabel('production'), onClick: () => ctx.correct(view) });
  }
}

/** 到货单：待入库的核对入库、编辑；已入库的备注、到货时间直接“编辑”（不出替代单），数量、单价走“更正到货单” */
function arrivalButtons<D extends ActionDoc>(b: Bar<D>) {
  const { ctx, view } = b;
  if (b.draft) {
    b.primary.push({ label: '核对入库', hidden: !ctx.canEdit, disabled: ctx.busy, onClick: () => ctx.review(view) });
    b.secondary.push(b.edit);
  }
  if (b.effective) b.secondary.push(b.editInfo);
  if (b.confirmed && ctx.canEdit) b.secondary.push({ label: '采购退货', onClick: () => ctx.setReturning(view) });
  if (b.effective && ctx.canEdit) b.more.push({ label: correctLabel('arrival'), onClick: () => ctx.correct(view) });
}

/** 送货单：待送货的导出送货单（出库）；送货中的确认送达；重新下载、打印都在送货单的导出窗里，不另放“打印” */
function deliveryButtons<D extends ActionDoc>(b: Bar<D>, doc: Extract<ActionDoc, { kind: 'delivery' }>) {
  const { ctx, view } = b;
  if (b.draft) {
    b.primary.push({ label: '导出送货单', hidden: !ctx.canEdit, onClick: () => ctx.exportDelivery(view) });
    b.secondary.push(b.edit);
    b.more.push({ label: '不导出直接出库', hidden: !ctx.canEdit, disabled: ctx.busy, onClick: () => ctx.review(view) });
    b.more.push(b.schedule);
  } else if (doc.status === 'confirmed') {
    if (b.confirmed && doc.shippedAt && !doc.deliveredAt)
      b.primary.push({ label: '确认送达', hidden: !ctx.canEdit, disabled: ctx.busy, onClick: () => ctx.markDelivered(view) });
    b.secondary.push({ label: '送货单', onClick: () => ctx.exportDelivery(view) });
    if (b.effective) b.secondary.push(b.editInfo);
    // 送货更正和撤销这次送货同一级：有编辑权限就能做（客户已签收的也能更正）
    if (b.effective && ctx.canEdit) b.more.push({ label: correctLabel('delivery'), onClick: () => ctx.correct(view) });
  }
}

/** 管理类（归档 / 恢复、修改历史）和危险项（取消还没生效的、撤销已生效的、删除） */
function manageButtons<D extends ActionDoc>(b: Bar<D>, doc: ActionDoc, openTask: boolean) {
  const { ctx, view } = b;
  const archived = !!doc.archived;
  b.more.push({
    label: archived ? '恢复' : '归档',
    hidden: !ctx.canEdit,
    disabled: ctx.busy,
    onClick: () => ctx.ask(archived ? 'restore' : 'archive', [view]),
  });
  b.more.push({ label: '关联记录与修改历史', onClick: () => ctx.setContextId(doc.id) });
  if (b.draft || openTask)
    b.danger.push({ label: cancelLabel(doc), hidden: !ctx.canEdit, danger: true, onClick: () => ctx.ask('cancel', [view]) });
  // 送货、到货发错或登记重了：有编辑权限就能撤销；生产任务、完工的撤销要超级管理员模式
  if (b.confirmed && ((ctx.canEdit && (doc.kind === 'delivery' || doc.kind === 'arrival')) || ctx.superMode))
    b.danger.push({
      label: undoLabel(doc.kind),
      danger: true,
      // 只打开撤销确认窗，详情留着：点“取消”回到详情；撤销成功后由执行处关掉详情（FlowPage 的 perform）
      onClick: () => ctx.ask('reverse', [view]),
    });
  // 还没生效的有编辑权限就能删；已生效的要本机管理员或超级管理员模式（验证密码），删前看影响清单、自动留快照
  if (ctx.local || ctx.superMode || (b.draft && ctx.canEdit))
    b.danger.push({ label: '删除', danger: true, disabled: ctx.busy, onClick: () => ctx.ask('delete', [view]) });
}

/**
 * 详情的操作，按状态只有一个主按钮（当前的下一步）、一两个次要，其余进“更多”：
 * 低频业务动作（更正××单） → 归档、修改历史 → 分隔线 → 红色的取消、撤销、删除。
 */
export function FlowActionBar<D extends ActionDoc>({ view, ctx }: { view: NoInfer<D>; ctx: FlowActionContext<D> }) {
  const doc: ActionDoc = view;
  const archived = !!doc.archived;
  const confirmed = doc.status === 'confirmed' && !archived;
  const openTask = doc.kind === 'task' && confirmed && doc.progress < 100;
  const b: Bar<D> = {
    view,
    ctx,
    draft: doc.status === 'draft' && !archived,
    confirmed,
    effective: confirmed && isCorrectable(doc.kind) && !doc.replacedBy,
    edit: {
      label: '编辑',
      hidden: !ctx.canEdit,
      onClick: () => {
        ctx.begin(view);
        ctx.setView(null);
      },
    },
    schedule: { label: '调整排程', hidden: !ctx.canEdit, onClick: () => ctx.setScheduling(view) },
    editInfo: { label: '编辑', hidden: !ctx.canEdit, onClick: () => ctx.editInfo(view) },
    primary: [],
    secondary: [],
    more: [],
    danger: [],
  };
  if (doc.kind === 'task') taskButtons(b, doc, openTask);
  if (doc.kind === 'production') productionButtons(b);
  if (doc.kind === 'arrival') arrivalButtons(b);
  if (doc.kind === 'delivery') deliveryButtons(b, doc);
  manageButtons(b, doc, openTask);
  return <ActionBar primary={b.primary} secondary={b.secondary} more={[...b.more, ...b.danger]} />;
}
