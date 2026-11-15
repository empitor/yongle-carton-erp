import { useEffect, useState } from 'react';
import { ARRIVAL_HISTORY_TITLE, type ArrivalDaily, type FlowDocView } from '../../shared/business/index';
import { businessStatusTone } from '../recordkit/record-meta';
import { DetailPanel, Section, StatusChip } from '../ui/index';
import { FinanceRelatedSlot } from '../ui/index';
import { FlowActionBar } from '../flow/FlowActions';
import { docName } from '../flow/flow-words';
import { ArrivalReturns } from '../flow/ArrivalReturns';
import CorrectionNote from '../flow/CorrectionNote';
import type { FlowDesk } from '../flow/useFlowDesk';
import { ReceiptHistory } from './FulfillmentDetails';
import { ArrivalSections, DeliverySections } from './WarehouseRecordSections';
import { partyOf, warehouseOverdue, type WarehousePurchase, type WarehouseRecord } from './warehouse-list';

type PanelDesk = Pick<
  FlowDesk,
  'view' | 'actionContext' | 'canEdit' | 'superMode' | 'returnRevision' | 'setReturnRevision' | 'refresh'
>;

type Props = {
  kind: 'arrival' | 'delivery';
  record: WarehouseRecord;
  status: string;
  /** 到货关联的采购单（含到货批次），到货批次里点“更正”要用 */
  purchase: WarehousePurchase | null;
  /** desk.view 是这条记录对应的单据（打开着才显示面板） */
  desk: PanelDesk;
  close: () => void;
  previous: () => void;
  next: () => void;
};

/**
 * 到货、送货的详情面板：只管显示（到货、送货的记录内容、退货、到货批次、财务关联）。
 * 按钮和办理和单据页是同一套：按钮规则在 FlowActionBar，办理和窗口在 useFlowDesk / FlowDeskDialogs，
 * desk.view 是这条记录对应的单据。
 */
export default function WarehouseRecordPanel({ kind, record: r, status, purchase, desk, close, previous, next }: Props) {
  const { view } = desk;
  if (!view) return null;
  return (
    <DetailPanel
      kicker={docName(view)}
      title={view.number}
      status={
        <span className="flow-status">
          <StatusChip tone={businessStatusTone(status)}>{status}</StatusChip>
          {warehouseOverdue(r) && <StatusChip tone="danger">逾期</StatusChip>}
        </span>
      }
      subtitle={[partyOf(r), r.lines.length + (kind === 'arrival' ? ' 种纸板' : ' 种产品')].filter(Boolean).join(' · ')}
      actions={<FlowActionBar view={view} ctx={desk.actionContext} />}
      close={close}
      previous={previous}
      next={next}
    >
      {/* 更正关系：原单“已更正为 ××”、替代单“更正自 ××”，和单据页详情同一处 */}
      <CorrectionNote d={view} />
      {'flowId' in r ? (
        <ArrivalBody record={r} view={view} purchase={purchase} desk={desk} />
      ) : (
        <>
          <DeliverySections record={r} />
          {/* 财务段自己就是一节（Section），外面不再套一层卡片 */}
          <FinanceRelatedSlot kind="delivery" id={view.id} />
        </>
      )}
    </DetailPanel>
  );
}

/** 到货的正文：记录内容、退货、这张采购单的全部到货批次（点开才列）、财务关联 */
function ArrivalBody({
  record: r,
  view,
  purchase,
  desk,
}: {
  record: ArrivalDaily;
  view: FlowDocView;
  purchase: WarehousePurchase | null;
  desk: PanelDesk;
}) {
  const [history, setHistory] = useState(false);
  // 换了一条记录：收起上一条的到货批次
  useEffect(() => setHistory(false), [r.id]);
  return (
    <>
      <ArrivalSections record={r} />
      <ArrivalReturns
        arrivalId={view.id}
        canEdit={desk.canEdit}
        superMode={desk.superMode}
        revision={desk.returnRevision}
        changed={() => {
          desk.setReturnRevision((v) => v + 1);
          desk.refresh();
        }}
      />
      {purchase && (
        <Section
          title={ARRIVAL_HISTORY_TITLE}
          extra={
            <button type="button" className="wh-link" aria-expanded={history} onClick={() => setHistory((v) => !v)}>
              {history ? '收起' : '展开 ' + purchase.receipts.length + ' 批'}
            </button>
          }
        >
          {history ? (
            <ReceiptHistory row={purchase} correct={desk.canEdit ? desk.actionContext.correct : undefined} />
          ) : (
            <p className="wh-muted">采购单 {purchase.number} 的全部到货批次，更正过的能看到原始记录。</p>
          )}
        </Section>
      )}
      {/* 财务段自己就是一节（Section），外面不再套一层卡片 */}
      <FinanceRelatedSlot kind="arrival" id={view.id} />
    </>
  );
}
