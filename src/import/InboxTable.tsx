import { FileText, Image as ImageIcon, MessageSquare } from 'lucide-react';
import { EmptyState, TableRegion, beijingTime } from '../ui/index';
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
  <TableRegion label="收件箱列表">
    <table>
      <thead>
        <tr>
          <th>发送人</th>
          <th>内容</th>
          <th className="inbox-time">收到时间</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            tabIndex={0}
            className={'record-row' + (selectedId === row.id ? ' selected' : '')}
            aria-selected={selectedId === row.id}
            onClick={(e) => {
              if (!(e.target instanceof Element && e.target.closest('a,button'))) select(row);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) select(row);
            }}
          >
            <td className="inbox-sender">
              <span>{row.senderName || (row.channel === 'manual' ? channelName('manual') : '—')}</span>
              <small>
                {[row.conversation, row.senderName || row.channel !== 'manual' ? channelName(row.channel) : '']
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </td>
            <td className="inbox-content" title={preview(row)}>
              <KindIcon kind={row.kind} />
              <button
                className="row-key"
                aria-label={'查看 ' + preview(row)}
                onClick={() => select(row)}
              >
                {preview(row)}
              </button>
            </td>
            <td className="record-date inbox-time">{beijingTime(row.receivedAt, 'short')}</td>
          </tr>
        ))}
        {loaded && !rows.length && (
          <tr>
            <td colSpan={3}>
              <EmptyState
                title={
                  status === 'pending'
                    ? '没有待处理的内容'
                    : status === 'converted'
                      ? '还没有处理过的内容'
                      : '没有忽略的内容'
                }
                description={
                  status === 'pending'
                    ? '发给机器人的内容会自动进来，也可以上传文件或粘贴文字。'
                    : '在“待处理”里转订单、标为已处理或忽略后，会出现在这里。'
                }
              />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </TableRegion>
  );
}
