import { FileText, Image as ImageIcon, MessageSquare } from 'lucide-react';
import { DataTable, beijingTime, type Col } from '../ui/index';
import { channelName } from './InboxDetail';
import type { InboxItem, InboxStatus } from '../../shared/import/index';

const preview = (row: InboxItem) => row.fileName || row.text || '（无内容）';

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'text' ? MessageSquare : FileText;
  return <Icon size={15} aria-hidden="true" className="inbox-kind" />;
}

/** 收件箱列表：发送人、内容、收到时间。行上不放按钮，点行打开详情。 */
export default function InboxTable({
  rows,
  loaded,
  status,
  selectedId,
  select,
}: {
  rows: InboxItem[];
  loaded: boolean;
  status: InboxStatus;
  selectedId?: number;
  select: (row: InboxItem) => void;
}) {
  return (
    <DataTable
      label="收件箱列表"
      cols={inboxCols(select)}
      rows={rows}
      onRow={select}
      selected={selectedId}
      // 读到之前不说“没有”
      empty={
        !loaded
          ? null
          : status === 'pending'
            ? '没有待处理的内容'
            : status === 'converted'
              ? '还没有处理过的内容'
              : '没有忽略的内容'
      }
      emptyNote={
        status === 'pending'
          ? '发给机器人的内容会自动进来，也可以上传文件或粘贴文字。'
          : '在“待处理”里转订单、标为已处理或忽略后，会出现在这里。'
      }
    />
  );
}

const inboxCols = (select: (row: InboxItem) => void): Col<InboxItem>[] => [
  {
    key: 'sender',
    label: '发送人',
    cellClass: 'inbox-sender',
    render: (row) => (
      <>
        <span>{row.senderName || (row.channel === 'manual' ? channelName('manual') : '—')}</span>
        <small>
          {[row.conversation, row.senderName || row.channel !== 'manual' ? channelName(row.channel) : '']
            .filter(Boolean)
            .join(' · ')}
        </small>
      </>
    ),
  },
  {
    key: 'content',
    label: '内容',
    cellClass: 'inbox-content',
    title: preview,
    render: (row) => (
      <>
        <KindIcon kind={row.kind} />
        <button className="row-key" aria-label={'查看 ' + preview(row)} onClick={() => select(row)}>
          {preview(row)}
        </button>
      </>
    ),
  },
  {
    key: 'received',
    label: '收到时间',
    className: 'inbox-time',
    cellClass: 'record-date',
    render: (row) => beijingTime(row.receivedAt, 'short'),
  },
];
