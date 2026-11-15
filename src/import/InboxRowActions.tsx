import { ActionBar, type RecordAction } from '../ui/index';
import { importable } from './InboxDetail';
import type { ConvertedKind, InboxItem, InboxStatus } from '../../shared/import/index';

/**
 * 列表行不放按钮，点行开详情；所有动作都在详情头部：
 * 能识别的文件主按钮“转订单”，转到货次要（唛头不识别，在产品里直接上传）；文字消息主按钮“新建订单”，次要“标为已处理”。
 * 标为已处理、忽略这类少用的收进“更多”。没有权限的不显示。
 */
export default function InboxRowActions({
  row,
  canEdit,
  busy,
  convert,
  setRowStatus,
}: {
  row: InboxItem;
  canEdit: boolean;
  busy: boolean;
  convert: (row: InboxItem, kind: ConvertedKind) => void;
  setRowStatus: (row: InboxItem, next: InboxStatus, message: string) => void;
}) {
  const hidden = !canEdit;
  if (row.status !== 'pending')
    return row.convertedKind && row.convertedRef ? (
      <ActionBar primary={[{ label: '查看导入任务', href: '#ai-import?workspace=' + row.convertedRef }]} />
    ) : (
      <ActionBar
        secondary={[
          {
            label: '恢复待处理',
            hidden,
            disabled: busy,
            onClick: () => setRowStatus(row, 'pending', '已恢复到待处理。'),
          },
        ]}
      />
    );
  const done: RecordAction = {
    label: '标为已处理',
    hidden,
    disabled: busy,
    onClick: () => setRowStatus(row, 'converted', '已标为已处理，可在“已处理”里查看。'),
  };
  const ignore: RecordAction = {
    label: '忽略',
    hidden,
    disabled: busy,
    onClick: () => setRowStatus(row, 'ignored', '已忽略，可在“已忽略”里恢复。'),
  };
  if (row.fileName && importable.test(row.fileName))
    return (
      <ActionBar
        primary={[{ label: '转订单', hidden, disabled: busy, onClick: () => convert(row, 'order') }]}
        secondary={[
          { label: '转到货', hidden, disabled: busy, onClick: () => convert(row, 'arrival') },
        ]}
        more={[done, ignore]}
      />
    );
  return (
    <ActionBar
      primary={[{ label: '新建订单', hidden, href: '#orders?create=1&inbox=' + row.id }]}
      secondary={[done]}
      more={[ignore]}
    />
  );
}
