import { flowStatusText, type FlowDocView as DocView } from '../../shared/business/index';
import { DetailPanel, FinanceRelatedSlot, FormMessage, Hint, ManagementDialog, useBusinessRevision, useLoad, Loading } from '../ui/index';
import FlowDetails, { FlowStatus, flowSubtitle } from './FlowDetails';
import { FlowActionBar } from './FlowActions';
import { ArrivalReturns } from './ArrivalReturns';
import { ArrivalHistorySection } from './FulfillmentDetails';
import { readFlowRecord } from './flow-api';
import { docName } from './flow-words';
import { detailLookups } from './lookups';
import type { FlowDesk } from './useFlowDesk';

/** 到货单、送货单是哪一种（另两种单据没有台账记录） */
const ledgerKind = (view: DocView) => (view.kind === 'arrival' || view.kind === 'delivery' ? view.kind : null);

/**
 * 到货单、送货单在台账里的样子：点开一张读一张（已归档的也读），单据改了、退货了、业务数据变了都重读，
 * 重读时先接着显示这一张上次读到的。换了一张、还没读到时 ready 为假；别的单据不读，ready 一直为真。
 */
function useFlowRecord(view: DocView, returnRevision: number) {
  const [revision] = useBusinessRevision();
  const kind = ledgerKind(view);
  const loaded = useLoad(kind && [kind, view.id, view.version, returnRevision, revision].join('|'), () =>
    kind ? readFlowRecord(kind, view.id) : Promise.resolve(null),
  );
  const shown = loaded.data;
  const record = shown && ('flowId' in shown ? shown.flowId : shown.id) === view.id ? shown : undefined;
  return { record, ready: !kind || !loaded.loading || !!record, error: loaded.error };
}

/**
 * 一张单据的详情：单据页、到货送货页（在用的和已归档的）里是右侧面板（能上一张、下一张），从别处弹出时是窗口；
 * 正文一份（FlowDetails），到货单后面是采购退货和这张采购单的到货记录，到货、送货最后是财务段。
 * 按钮规则在 FlowActionBar，办理在 useFlowDesk。没有打开的单据时什么都不显示。
 */
export default function FlowDocView({
  desk,
  dialog = false,
  previous,
  next,
}: {
  desk: FlowDesk;
  /** 从别处弹出：用窗口，没办成的原因显示在窗口里 */
  dialog?: boolean;
  /** 面板里切到上一张、下一张（src/ui/stepper.ts） */
  previous?: () => void;
  next?: () => void;
}) {
  const { view, setView } = desk;
  if (!view) return null;
  const actions = <FlowActionBar view={view} ctx={desk.actionContext} />;
  const body = <FlowDocBody desk={desk} view={view} dialog={dialog} />;
  if (dialog)
    return (
      <ManagementDialog
        title={docName(view) + ' · ' + view.number}
        subtitle={[flowStatusText(view), flowSubtitle(view, desk.data)].filter(Boolean).join(' · ')}
        size="lg"
        close={() => setView(null)}
        footer={actions}
      >
        <FormMessage>{desk.error}</FormMessage>
        {body}
      </ManagementDialog>
    );
  return (
    <DetailPanel
      kicker={docName(view)}
      title={view.number}
      subtitle={flowSubtitle(view, desk.data)}
      status={<FlowStatus doc={view} />}
      actions={actions}
      close={() => setView(null)}
      previous={previous}
      next={next}
    >
      {body}
    </DetailPanel>
  );
}

/**
 * 详情的正文：单据内容（关联档案和台账记录读到才显示），到货单的退货和到货记录，到货、送货的财务段。
 * 从别处弹出的窗口里退货、到货记录只列出来，不能撤销退货、更正到货单（到到货页去办，一个窗口只交互一次）。
 */
function FlowDocBody({ desk, view, dialog }: { desk: FlowDesk; view: DocView; dialog: boolean }) {
  const { record, ready, error } = useFlowRecord(view, desk.returnRevision);
  const kind = ledgerKind(view);
  // 到货单挂的采购单（详情读档案时读了采购单）：列它的全部到货记录
  const purchase =
    view.kind === 'arrival'
      ? desk.data.purchases.find((p) => view.lines.some((l) => l.purchaseId === p.id || p.lines.some((x) => x.id === l.purchaseLineId)))
      : undefined;
  return (
    <>
      {error && <Hint tone="danger">验收入库和库存流水读取失败：{error}</Hint>}
      {desk.ready(detailLookups(view)) && ready ? (
        <FlowDetails doc={view} data={desk.data} record={record} />
      ) : (
        <Loading what="关联档案" />
      )}
      {view.kind === 'arrival' && (
        <ArrivalReturns
          arrivalId={view.id}
          canEdit={desk.canEdit && !dialog}
          superMode={desk.superMode}
          revision={desk.returnRevision}
          changed={() => {
            desk.setReturnRevision((v) => v + 1);
            desk.refresh();
          }}
        />
      )}
      {purchase && (
        <ArrivalHistorySection
          arrivalId={view.id}
          purchase={purchase}
          correct={desk.canEdit && !dialog ? desk.actionContext.correct : undefined}
        />
      )}
      {/* 财务段自己就是一节（Section），外面不再套一层卡片 */}
      {kind && <FinanceRelatedSlot kind={kind} id={view.id} />}
    </>
  );
}
