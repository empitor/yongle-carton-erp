import { flowStatusText } from '../../shared/business/index';
import { DetailPanel, FormMessage, ManagementDialog } from '../ui/index';
import FlowDetails, { FlowStatus, flowSubtitle } from './FlowDetails';
import { FlowActionBar } from './FlowActions';
import { ArrivalReturns } from './ArrivalReturns';
import { docName } from './flow-words';
import { detailLookups } from './lookups';
import type { FlowDesk } from './useFlowDesk';

/**
 * 一张单据的详情：单据页里是右侧面板（能上一张、下一张），从别处弹出时是窗口。
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
  const { view, setView, data } = desk;
  if (!view) return null;
  const details = desk.ready(detailLookups(view)) ? (
    <FlowDetails doc={view} data={data} />
  ) : (
    <p className="help-text" role="status">
      正在读取关联档案…
    </p>
  );
  const actions = <FlowActionBar view={view} ctx={desk.actionContext} />;
  if (dialog)
    return (
      <ManagementDialog
        title={docName(view) + ' · ' + view.number}
        subtitle={[flowStatusText(view), flowSubtitle(view, data)].filter(Boolean).join(' · ')}
        size="lg"
        close={() => setView(null)}
        footer={actions}
      >
        <FormMessage>{desk.error}</FormMessage>
        {details}
      </ManagementDialog>
    );
  return (
    <DetailPanel
      kicker={docName(view)}
      title={view.number}
      subtitle={flowSubtitle(view, data)}
      status={<FlowStatus doc={view} />}
      actions={actions}
      close={() => setView(null)}
      previous={previous}
      next={next}
    >
      {details}
      {view.kind === 'arrival' && (
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
      )}
    </DetailPanel>
  );
}
