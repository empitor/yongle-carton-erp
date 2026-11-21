import { lazy, Suspense, useState, type ReactNode } from 'react';
import { displayAmount, errorMessage, finishedUnit, today, type Order } from '../../shared/core/index';
import type { FlowDocView, NextStep } from '../../shared/business/index';
import { yuan, notify, beijingTime, canEditBusiness, useAuthState, useAction, ConfirmDialog, Facts, emit, FormMessage, Loading } from '../ui/index';
import { BatchReceiveButton, OrderBatchButton } from '../operations/BatchCard';
import TodaySide from './TodaySide';
import TodayRow from './TodayRow';
import { todayGroups, TODAY_SHOWN, type TodayRowData } from './today-groups';
import { RecordDialogView } from './record-dialogs';
import { orderStepDialog, type RecordDialog } from './order-step';
import { changeOrderStatus } from '../recordkit/record-api';
import { readFlow } from '../flow/flow-api';
import { useTodayData } from './useTodayData';

type TodayGroup = ReturnType<typeof todayGroups>[number];

const DeliveryExportDialog = lazy(() =>
  import('../documents/pages').then((m) => ({ default: m.DeliveryExportDialog })),
);

/** 一组待办：标题和条数，默认只列前几条，“全部 N 条”展开或跳到对应列表 */
function TodayGroupSection({ group: g, renderRow }: { group: TodayGroup; renderRow: (r: TodayRowData) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const total = g.total ?? g.rows.length,
    rows = open ? g.rows : g.rows.slice(0, TODAY_SHOWN);
  return (
    <section className="td-group" aria-label={g.title}>
      <header>
        <h2>
          {g.title} <span className="td-count">{total}</span>
        </h2>
        {g.extra && (
          <a className="td-all" href={g.extra.href}>
            {g.extra.text}
          </a>
        )}
        {total > rows.length &&
          (g.all ? (
            <a className="td-all" href={g.all}>
              全部 {total} 条
            </a>
          ) : (
            <button type="button" className="td-all" onClick={() => setOpen(true)}>
              全部 {total} 条
            </button>
          ))}
        {open && (
          <button type="button" className="td-all" onClick={() => setOpen(false)}>
            收起
          </button>
        )}
      </header>
      <ul>{rows.map(renderRow)}</ul>
    </section>
  );
}

/** 今日页的“确认订单”：写明客户、交期、产品，确认后才能安排生产和送货 */
function ConfirmOrderDialog({ order, close }: { order: Order; close: () => void }) {
  const confirm = useAction();
  return (
    <ConfirmDialog
      title={'确认订单 ' + order.number}
      subtitle={
        <a className="td-detail-link" href={'#orders?order=' + order.id}>
          查看订单详情
        </a>
      }
      confirmLabel="确认订单"
      busy={confirm.busy}
      error={confirm.error}
      note="确认后才能安排生产和送货。"
      onConfirm={() =>
        void confirm.run(async () => {
          await changeOrderStatus(order, 'confirm');
          notify('订单 ' + order.number + ' 已确认。');
          close();
          emit('erp-business-changed');
        })
      }
      close={close}
    >
      <Facts
        items={[
          { label: '客户', value: order.customerName },
          { label: '交货日期', value: order.deliveryDate },
          {
            label: '产品',
            wide: true,
            value: order.lines
              .map((l) => l.productName + ' ' + l.quantity + ' ' + finishedUnit(l.unit))
              .join('、'),
          },
        ]}
      />
    </ConfirmDialog>
  );
}

/**
 * 今日：只放要办的事。按动作分组，每张单只在一组里出现、只给最该做的那一步；
 * 行按钮直接打开对应的窗口，办完关窗回到今日，底部提示结果。
 */
export default function TodayQueue() {
  const { data, error, pendingConfirm, mail, imports, dueRows, aiNote, reload } = useTodayData();
  const canEdit = canEditBusiness(useAuthState());
  const [resolving, setResolving] = useState(''),
    [actionError, setActionError] = useState(''),
    // 订单下一步的办理窗口：和订单详情的“下一步”同一套（record-dialogs.tsx）
    [dialog, setDialog] = useState<RecordDialog | null>(null),
    [confirming, setConfirming] = useState<Order | null>(null),
    [exporting, setExporting] = useState<FlowDocView | null>(null);

  /**
   * 订单的下一步：服务端已按订单详情同一套规则（几张单抢同一批货时按交期分库存）算好这一步和要带的参数，
   * 这里照着打开和订单详情同一个窗口，不再自己重算；没有对应窗口的打开订单详情。
   */
  const openStep = (orderId: number, step: { kind: NextStep['kind']; params?: Record<string, string> }) => {
    setActionError('');
    const next = orderStepDialog(orderId, step);
    if (next) setDialog(next);
    else location.hash = '#orders?order=' + orderId;
  };
  const openExport = async (row: TodayRowData, id: number) => {
    setResolving(row.key);
    setActionError('');
    try {
      setExporting(await readFlow(id));
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setResolving('');
    }
  };

  if (error) return <FormMessage>{error}</FormMessage>;
  if (!data)
    return (
      <div className="td-empty">
        <Loading what="今日待办" />
      </div>
    );

  const groups = todayGroups({ data, pendingConfirm, mail, imports, aiNote, today: today() });
  /** 行上的动作画成按钮或链接：按钮类的要业务编辑权限 */
  const actionOf = (row: TodayRowData): ReactNode => {
    const a = row.action;
    if (!a) return undefined;
    if (a.kind === 'link')
      return (
        <a className="button-link secondary" href={a.href}>
          {a.label}
        </a>
      );
    if (!canEdit) return undefined;
    if (a.kind === 'orderSheet') return <OrderBatchButton purchaseIds={[a.purchaseId]} label={a.label} />;
    if (a.kind === 'receive') return <BatchReceiveButton purchaseId={a.purchaseId} primary={false} />;
    const run = () => {
      if (a.kind === 'confirm') setConfirming(a.order);
      else if (a.kind === 'step') openStep(a.orderId, a.step);
      else if (a.kind === 'ship') setDialog({ type: 'delivery', orderIds: [a.orderId] });
      else if (a.kind === 'export') void openExport(row, a.deliveryId);
    };
    return (
      <button type="button" className="secondary" disabled={!!resolving} onClick={run}>
        {resolving === row.key ? '正在打开…' : a.label}
      </button>
    );
  };
  const shownGroups = groups.filter((g) => g.rows.length);
  const s = data.summary,
    overdueCount = data.overdue.length;
  const schedule = data.schedule;
  const hasSchedule = !!(schedule.arrivals.length || schedule.tasks.length || schedule.deliveries.length);
  const side = hasSchedule || dueRows.length > 0 || data.zeroStock.length > 0;
  const renderRow = (r: TodayRowData) => <TodayRow row={r} key={r.key} action={actionOf(r)} />;
  const finish = (message: string) => {
    notify(message);
    reload();
  };

  return (
    <>
      {data.backupFailedAt && (
        <FormMessage>
          自动备份失败（{beijingTime(data.backupFailedAt)}
          ）。请检查磁盘空间或备份目录权限，并尽快手动备份。
        </FormMessage>
      )}
      <FormMessage close={() => setActionError('')}>{actionError}</FormMessage>
      <div className="td-stats" aria-label="本月摘要">
        <div>
          本月接单 <strong>¥{yuan(s.monthOrderCents)}</strong>
        </div>
        <div>
          本月发货 <strong>¥{displayAmount(s.monthShippedAmount)}</strong>
        </div>
        <a className={overdueCount ? 'is-warn' : ''} href="#orders?view=pending&range=all">
          逾期未发货 <strong>{overdueCount}</strong>
        </a>
      </div>
      <div className={'td-grid' + (side ? '' : ' no-side')}>
        <div className="td-groups">
          {shownGroups.map((g) => (
            <TodayGroupSection key={g.id} group={g} renderRow={renderRow} />
          ))}
          {!shownGroups.length && (
            <section className="td-group td-done">
              <p>今天没有要处理的事。</p>
              {canEdit && (
                <a className="button-link secondary" href="#orders?create=1">
                  新建订单
                </a>
              )}
            </section>
          )}
        </div>
        {side && <TodaySide schedule={schedule} dueRows={dueRows} zeroStock={data.zeroStock} />}
      </div>
      {dialog && (
        <RecordDialogView
          dialog={dialog}
          close={() => {
            setDialog(null);
            reload();
          }}
          done={(message) => {
            setDialog(null);
            finish(message);
          }}
        />
      )}
      {exporting && (
        <Suspense fallback={<p role="status">正在打开…</p>}>
          <DeliveryExportDialog
            doc={exporting}
            close={() => setExporting(null)}
            onDone={(message: string) => {
              setExporting(null);
              finish(message);
            }}
          />
        </Suspense>
      )}
      {confirming && <ConfirmOrderDialog order={confirming} close={() => setConfirming(null)} />}
    </>
  );
}
