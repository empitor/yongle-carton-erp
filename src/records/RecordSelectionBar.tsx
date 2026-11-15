import type { RecordEntity } from '../../shared/business/index';
import { SelectionBar, type RecordAction } from '../ui/index';
import { useBulkActions } from './BulkActions';
import type { RecordRowOf } from './record-rows';

/**
 * 勾选后底部的选择条：一个正向批量主操作（排产、送货、订料……，见 BulkActions），批量恢复、归档、删除在“更多”。
 * 归档页、已归档范围里没有开单这类正向操作，“批量恢复”就是主操作。
 */
export default function RecordSelectionBar<E extends RecordEntity>({
  entity,
  unit,
  picked,
  canEdit,
  superMode,
  archivedView,
  busy,
  isArchived,
  lifecycle,
  remove,
  clear,
}: {
  entity: E;
  unit: string;
  /** 勾选的行 */
  picked: RecordRowOf[E][];
  canEdit: boolean;
  superMode: boolean;
  /** 看的是已归档的（已归档范围或归档页） */
  archivedView: boolean;
  busy: boolean;
  isArchived: (row: RecordRowOf[E]) => boolean;
  lifecycle: (selection: { action: 'archive' | 'restore'; rows: RecordRowOf[E][] }) => void;
  remove: (rows: RecordRowOf[E][]) => void;
  clear: () => void;
}) {
  const bulk = useBulkActions({ entity, rows: picked, canEdit, archived: archivedView, clear });
  const restorable = picked.filter((r) => isArchived(r)),
    archivable = picked.filter((r) => !isArchived(r));
  const restore: RecordAction = {
    label: '批量恢复',
    hidden: !restorable.length,
    disabled: !canEdit || busy,
    onClick: () => lifecycle({ action: 'restore', rows: restorable }),
  };
  const others: RecordAction[] = [
    {
      label: '批量归档',
      hidden: !archivable.length,
      disabled: !canEdit || busy,
      onClick: () => lifecycle({ action: 'archive', rows: archivable }),
    },
    { label: '批量删除', danger: true, hidden: !superMode, onClick: () => remove(picked) },
  ];
  const restoreFirst = archivedView && !bulk.primary;
  return (
    <>
      <SelectionBar
        count={picked.length}
        unit={unit}
        primary={bulk.primary || (restoreFirst ? restore : undefined)}
        secondary={bulk.secondary}
        more={[...bulk.more, ...(restoreFirst ? [] : [restore]), ...others]}
        onClear={clear}
      />
      {bulk.dialogs}
    </>
  );
}
