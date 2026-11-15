import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { emit, notify, useAction, ConfirmDialog, FormField, FormSection, type RecordAction } from '../ui/index';
import type { RecordEntity, RecordStatusAction } from '../../shared/business/index';
import { changePurchaseStatus } from '../operations/purchase-api';
import { changeOrderStatus } from '../recordkit/record-api';
import { RecordDialogView } from './record-dialogs';
import { nextPlan, type RecordDialog } from './order-step';
import { useRelatedData, type Related } from './useRelatedData';
import {
  customerActions,
  orderActions,
  productActions,
  purchaseActions,
  stockActions,
  supplierActions,
  type ActionContext,
  type ActionLists,
} from './record-action-lists';
import type { RecordRowOf } from './record-rows';

const none: ActionLists = { steps: [], extra: [], danger: [], leadEdit: true };
/** 各类记录的动作清单；不能办业务时（live 为假）只有编辑和“更多”里的管理项，库存品照样把“编辑”收进更多 */
const builders: { [E in RecordEntity]: (c: ActionContext<RecordRowOf[E]>, live: boolean) => ActionLists } = {
  orders: (c, live) => (live ? orderActions(c) : none),
  purchases: (c, live) => (live ? purchaseActions(c) : none),
  products: (c, live) => (live ? productActions(c) : none),
  customers: (c, live) => (live ? customerActions(c) : none),
  suppliers: (c, live) => (live ? supplierActions(c) : none),
  stock_items: stockActions,
};

/** 取消订单、取消采购单的确认窗：一个窗口里写原因、确认，办完就关 */
type Cancelling = { title: string; message: string; label: string; done: string };

/** 详情头部操作要的记录、权限和各个入口（RecordPanel 的属性也从这里来） */
export type RecordActionProps<E extends RecordEntity> = {
  entity: E;
  row: RecordRowOf[E];
  archived: boolean;
  canEdit: boolean;
  superMode: boolean;
  localAdmin: boolean;
  busy: boolean;
  onEdit: () => void;
  onLifecycle: () => void;
  onHistory: () => void;
  onDelete: () => void;
  /** 库存品：出入库 / 盘点 */
  onMove?: (row: RecordRowOf[E]) => void;
};

/**
 * 详情头部的操作：主按钮是当前状态下的下一步，次要放“编辑”等最多两个，
 * 其余低频业务动作、归档 / 恢复、修改历史进“更多”，取消、删除这类危险项在“更多”最下面。
 */
export function useRecordActions<E extends RecordEntity>({
  entity,
  row,
  archived,
  canEdit,
  superMode,
  localAdmin,
  busy,
  onEdit,
  onLifecycle,
  onHistory,
  onDelete,
  onMove,
}: RecordActionProps<E>) {
  const { data, error: loadError } = useRelatedData(entity, row, true);
  const plan = nextPlan(entity, row, data, canEdit);
  const [dialog, setDialog] = useState<RecordDialog | null>(null),
    [cancelling, setCancelling] = useState<Cancelling | null>(null),
    [reason, setReason] = useState('');
  const status = useAction(),
    cancelAction = useAction();
  const working = status.busy || cancelAction.busy;
  // 换了一条记录才清掉上一条没办成的说明
  const clearStatus = useEffectEvent(() => status.clear());
  useEffect(() => clearStatus(), [row.id]);
  const live = canEdit && !archived;
  /** 改状态：确认、退回、取消、恢复各是一个动作（recordkit/record-api.ts、operations/purchase-api.ts），带读到时的版本号。 */
  const change = (action: RecordStatusAction, why?: string) =>
    entity === 'orders' ? changeOrderStatus(row, action, why) : changePurchaseStatus(row, action, why);
  const saveStatus = (action: RecordStatusAction, message: string) =>
    void status.run(async () => {
      await change(action);
      emit('erp-business-changed');
      notify(message);
    });
  const ask = (title: string, message: string, label: string, done: string) => {
    setReason('');
    cancelAction.clear();
    setCancelling({ title, message, label, done });
  };
  const cancel = (c: Cancelling) =>
    void cancelAction.run(async () => {
      await change('cancel', reason.trim());
      setCancelling(null);
      emit('erp-business-changed');
      notify(c.done);
    });
  const edit: RecordAction = {
    label: '编辑',
    icon: <Pencil size={14} aria-hidden="true" />,
    hidden: !(canEdit && (!archived || superMode)),
    onClick: onEdit,
  };
  const manage: RecordAction[] = [
    { label: archived ? '恢复' : '归档', disabled: !canEdit || busy, onClick: onLifecycle },
    { label: '关联记录与修改历史', onClick: onHistory },
    { label: '删除', danger: true, hidden: !(localAdmin || superMode), disabled: busy, onClick: onDelete },
  ];
  const context: ActionContext<RecordRowOf[E]> = { row, plan, working, localAdmin, saveStatus, ask, setDialog, onEdit, edit };
  const { steps, extra, danger, leadEdit } = builders[entity](context, live);
  const move: RecordAction | null =
    entity === 'stock_items' && live && onMove ? { label: '出入库 / 盘点', onClick: () => onMove(row) } : null;
  const primary = steps.slice(0, 1);
  // 次要只放“编辑”（库存品是“出入库 / 盘点”）。产品：“安排生产”是主操作，“新建订单”同样高亮紧挨着；
  // 资料不全的产品主按钮是“补全资料”，“安排生产”“新建订单”排次要。订单的其余下一步进“更多”。
  const keep = entity === 'products' ? 3 : 1;
  const secondary = [...(leadEdit ? [edit] : []), ...(move ? [move] : []), ...steps.slice(1, keep)];
  const overflow = secondary.filter((a) => !a.hidden).slice(2);
  const more = [
    ...overflow,
    ...steps.slice(keep),
    ...extra,
    ...manage.filter((a) => !a.danger),
    ...danger,
    ...manage.filter((a) => a.danger),
  ];
  const done = (message: string) => {
    setDialog(null);
    notify(message);
  };
  const dialogs: ReactNode = (
    <>
      {cancelling && (
        <ConfirmDialog
          title={cancelling.title}
          confirmLabel={cancelling.label}
          danger
          size="md"
          busy={working}
          disabled={!reason.trim()}
          error={cancelAction.error}
          onConfirm={() => cancel(cancelling)}
          close={() => setCancelling(null)}
        >
          <p>{cancelling.message}</p>
          <FormSection columns={1}>
            <FormField label="取消原因" required span="full">
              <textarea aria-label="取消原因" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </FormField>
          </FormSection>
        </ConfirmDialog>
      )}
      {dialog && <RecordDialogView dialog={dialog} close={() => setDialog(null)} done={done} />}
    </>
  );
  const related: Related = { data, plan, error: status.error || loadError, canEdit };
  return {
    primary,
    secondary: secondary.filter((a) => !a.hidden).slice(0, 2),
    more,
    dialogs,
    related,
  };
}
