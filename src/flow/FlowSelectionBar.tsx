import type { FlowKind } from '../../shared/core/index';
import { SelectionBar } from '../ui/index';
import type { FlowDocView } from '../../shared/business/index';
import { completableTask } from '../../shared/business/index';
import type { FlowDesk } from './useFlowDesk';

/**
 * 单据页勾选以后底部的选择条：已归档的恢复；生产任务登记完工；更多里批量归档、批量删除。
 * 还没生效的有编辑权限就能删，已生效的要本机管理员或超级管理员模式（删除窗口里核对）。
 */
export default function FlowSelectionBar({
  desk,
  kind,
  archived,
  count,
  selected,
  selectedRows,
  clear,
}: {
  desk: FlowDesk;
  kind: FlowKind;
  archived: boolean;
  /** 选择条上显示几张（排产板上不显示） */
  count: number;
  /** 勾了哪几张（编号） */
  selected: number[];
  selectedRows: FlowDocView[];
  clear: () => void;
}) {
  const { canEdit, local, superMode, busy } = desk;
  const canDeleteSelected =
    local || superMode || (canEdit && selectedRows.length > 0 && selectedRows.every((r) => r.status === 'draft'));
  // 勾的都是已下达、没做完的生产任务才能一起登记完工
  const completable = selectedRows.every((r) => r.kind === 'task' && completableTask(r));
  return (
    <SelectionBar
      count={count}
      unit="张"
      primary={
        archived
          ? {
              label: '恢复（' + selected.length + ' 张）',
              hidden: !canEdit,
              disabled: busy,
              onClick: () => desk.ask('restore', selectedRows),
            }
          : kind === 'task'
            ? {
                label: '登记完工（' + selected.length + ' 张）',
                hidden: !canEdit,
                disabled: busy || !completable,
                title: completable
                  ? undefined
                  : '只有已下达、没做完的任务能登记完工',
                onClick: () => void desk.openCompletion(selected),
              }
            : undefined
      }
      more={[
        {
          label: '批量归档',
          hidden: archived || !canEdit,
          disabled: busy,
          onClick: () => desk.ask('archive', selectedRows),
        },
        {
          label: '批量删除',
          danger: true,
          hidden: !canDeleteSelected,
          disabled: busy,
          onClick: () => desk.ask('delete', selectedRows),
        },
      ]}
      onClear={clear}
    />
  );
}
