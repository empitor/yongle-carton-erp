import { flowOverdue, isOpen } from './flow-dates';
import { completableTask } from '../../shared/business/index';
import { title } from './lookups';
import type { FlowDesk } from './useFlowDesk';
import type { FlowDocView, FlowKind } from '../../shared/business/index';
import { ListSummary, PageHeading } from '../ui/index';

/**
 * 生产任务、完工记录页的页头：一行统计（未完工、逾期；待入库）和主按钮。
 * 生产任务页主按钮“安排生产”（plan 打开安排生产窗口），次要“登记完工”；完工记录页主按钮“登记完工”。
 */
export default function FlowPageHeading({
  desk,
  kind,
  rows,
  plan,
}: {
  desk: FlowDesk;
  kind: FlowKind;
  rows: FlowDocView[];
  plan: () => void;
}) {
  const { canEdit, busy } = desk;
  // 页头一行统计：只在这里出现一次
  const live = rows.filter((r) => r.kind === kind && !r.archived);
  const openTasks = live.filter((r) => r.kind === 'task' && completableTask(r));
  const summary =
    kind === 'task'
      ? [
          { label: '未完工', value: live.filter(isOpen).length },
          { label: '逾期', value: live.filter(flowOverdue).length },
        ]
      : kind === 'production'
        ? [{ label: '待入库', value: live.filter((r) => r.status === 'draft').length }]
        : [];
  return (
    <PageHeading
      title={title(kind)}
      meta={summary.length ? <ListSummary items={summary} /> : undefined}
      actions={
        canEdit &&
        (kind === 'task' || kind === 'production') && (
          <>
            {kind === 'task' && (
              <button
                className="secondary"
                disabled={busy || !openTasks.length}
                title={openTasks.length ? undefined : '没有已下达、没做完的任务'}
                onClick={() => void desk.openCompletion([])}
              >
                登记完工
              </button>
            )}
            <button
              className="primary"
              disabled={busy || desk.opening > 0}
              onClick={() => (kind === 'task' ? plan() : void desk.openCompletion([]))}
            >
              {kind === 'task' ? '安排生产' : '登记完工'}
            </button>
          </>
        )
      }
    />
  );
}
