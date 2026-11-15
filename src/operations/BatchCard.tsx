import { Suspense, lazy, useState, type ReactNode } from 'react';
import OrderSheetRow from './OrderSheetRow';
import { ManagementDialog, notify, useAction, useBusinessRevision, useLoad } from '../ui/index';
import { canEditBusiness, useAuthState } from '../ui/index';
import { EditorFooter, FormMessage } from '../ui/index';
import { Section, StatusChip } from '../ui/index';
import type { OrderBatchView } from '../../shared/business/index';
import { quantityString } from '../../shared/core/index';
import { batchOfPurchase, scheduleOrderBatch } from '../warehouse/order-batch-api';
import { rowDrafts, scheduleBody, scheduleProblem, type RowDrafts } from './BatchSchedule';
// 两个窗口点了按钮才打开，按需加载（别处也都是 lazy 引用，这里静态引用会把它们拉进主包）
const OrderBatchDialog = lazy(() => import('./OrderBatchDialog'));
const BatchReceiveDialog = lazy(() => import('../warehouse/BatchReceiveDialog'));

const stateTone = (state: OrderBatchView['progress']['state']) =>
  state === '已到齐' ? 'success' : state === '部分到货' ? 'accent' : 'info';

/**
 * 采购单详情里的“订货单”一节：这张采购单所在的订货批次、还差多少、到货单。
 * 导出、登记到货在详情头部；这里只留编辑到货安排一个小入口。
 */
export default function BatchCard({ purchaseId }: { purchaseId: number }) {
  const auth = useAuthState(),
    canEdit = canEditBusiness(auth);
  const [dialog, setDialog] = useState<'' | 'schedule'>('');
  const [revision] = useBusinessRevision();
  // 读到的订货单带着是哪张采购单的：换了一张，上一张的不再显示；读不到就不显示这一节
  const loaded = useLoad(purchaseId + '|' + revision, () =>
    batchOfPurchase(purchaseId)
      .catch(() => null)
      .then((b) => ({ purchaseId, b })),
  );
  const batch = loaded.data?.purchaseId === purchaseId ? loaded.data.b : null;
  if (!batch) return null;
  const finished = batch.progress.state === '已到齐';
  return (
    <Section
      title={'订货单 ' + batch.number}
      extra={
        <span className="ob-card-extra">
          <StatusChip tone={stateTone(batch.progress.state)}>
            {batch.progress.state}
            {batch.progress.overdue ? ' · 有逾期' : ''}
          </StatusChip>
          {canEdit && !finished && (
            <button
              type="button"
              className="text-link ob-card-link"
              onClick={() => setDialog('schedule')}
            >
              编辑到货安排
            </button>
          )}
        </span>
      }
    >
      <p className="ob-card-sub">
        {batch.orderDate} 下单
        {batch.purchases.length > 1
          ? ' · 含 ' + batch.purchases.map((p) => p.number).join('、')
          : ''}
      </p>
      <ul className="ob-card-rows">
        {batch.rows.map((r) => (
          <li key={r.key}>
            <div>
              <strong>{r.name}</strong>
              <small>
                已到 {quantityString(r.receivedUnits)} / {quantityString(r.orderedUnits)} {r.unit}
              </small>
            </div>
            <div className="ob-due">
              {r.schedule
                .filter((s) => s.remainingUnits > 0)
                .map((s, i) => (
                  <StatusChip key={i} tone={s.state === 'overdue' ? 'danger' : 'neutral'}>
                    {s.dueDate ? s.dueDate.slice(5) + ' 前 ' : '日期待定 '}
                    {quantityString(s.remainingUnits)}
                    {s.state === 'overdue' ? ' · 逾期' : ''}
                  </StatusChip>
                ))}
            </div>
          </li>
        ))}
      </ul>
      {batch.arrivals.length > 0 && (
        <p className="ob-card-sub">
          到货单：
          {batch.arrivals
            .map((a) => a.number + (a.reference ? '（' + a.reference + '）' : '') + ' ' + a.date.slice(5))
            .join('、')}
        </p>
      )}
      {dialog === 'schedule' && (
        <ScheduleDialog
          batch={batch}
          close={() => setDialog('')}
          saved={(b) => {
            loaded.reload();
            setDialog('');
            notify('订货单 ' + b.number + ' 的到货安排已保存。');
          }}
        />
      )}
    </Section>
  );
}

/** 编辑到货安排：每行几段“多少在哪天前到”。只改安排，不动采购单和库存。 */
function ScheduleDialog({
  batch,
  close,
  saved,
}: {
  batch: OrderBatchView;
  close: () => void;
  saved: (b: OrderBatchView) => void;
}) {
  const [drafts, setDrafts] = useState<RowDrafts>(() => rowDrafts(batch.rows));
  const { busy, error, run } = useAction();
  const problem = scheduleProblem(batch.rows, drafts);
  return (
    <ManagementDialog
      title={'到货安排 · 订货单 ' + batch.number}
      subtitle={batch.supplierName}
      size="md"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="已经到的从截止日期最早的那段开始扣；不写日期的部分一直留在待到货里。">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !!problem}
            onClick={() => void run(async () => saved(await scheduleOrderBatch(batch, scheduleBody(drafts))))}
          >
            保存到货安排
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error || problem}</FormMessage>
      <div className="ob-rows">
        {batch.rows.map((r) => (
          <OrderSheetRow
            key={r.key}
            row={r}
            note={'已到 ' + quantityString(r.receivedUnits)}
            value={drafts[r.key] || []}
            disabled={busy}
            onChange={(v) => setDrafts((s) => ({ ...s, [r.key]: v }))}
          />
        ))}
      </div>
    </ManagementDialog>
  );
}

/** 点开一个窗口的按钮：窗口办完就关、页面提示结果（一个窗口只交互一次）。 */
function DialogButton({
  label,
  primary,
  dialog,
}: {
  label: string;
  primary?: boolean;
  dialog: (close: () => void, done: (message: string) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        className={primary ? 'primary' : 'secondary'}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <Suspense fallback={null}>
          {dialog(close, (m) => {
            close();
            notify(m);
          })}
        </Suspense>
      )}
    </>
  );
}

/** “导出订货单”按钮：打开订货单导出窗口（全站只有这一个导出窗口）。 */
export function OrderBatchButton({
  purchaseIds,
  primary,
  label = '导出订货单',
}: {
  purchaseIds: number[];
  primary?: boolean;
  label?: string;
}) {
  return (
    <DialogButton
      label={label}
      primary={primary}
      dialog={(close, done) => <OrderBatchDialog purchaseIds={purchaseIds} close={close} done={done} />}
    />
  );
}

/** “登记到货”按钮：打开按订货单登记到货的窗口。 */
export function BatchReceiveButton({
  purchaseId,
  batchId,
  primary = true,
  label = '登记到货',
}: {
  purchaseId?: number;
  batchId?: number;
  primary?: boolean;
  label?: string;
}) {
  return (
    <DialogButton
      label={label}
      primary={primary}
      dialog={(close, done) => (
        <BatchReceiveDialog purchaseId={purchaseId} batchId={batchId} close={close} done={done} />
      )}
    />
  );
}
