import { Download, FileText } from 'lucide-react';
import { Facts, Hint, Section, StatusChip, type Tone, beijingTime } from '../ui/index';
import {
  inboxChannelLabels,
  type InboxChannel,
  type InboxItem,
  type InboxKind,
  type InboxStatus as Status,
} from '../../shared/import/index';
import { inboxFileUrl } from './inbox-api';

/** 收件箱的来源名称，列表和详情共用；叫法只在共用的 inboxChannelLabels 定义。 */
export const channelName = (channel: InboxChannel) => inboxChannelLabels[channel];
/** 能交给 AI 识别成订单或到货单的文件。 */
export const importable = /\.(xls|xlsx|doc|docx|pdf|jpg|jpeg|png)$/i;

const statusNames: Record<Status, [string, Tone]> = {
  pending: ['待处理', 'accent'],
  converted: ['已处理', 'success'],
  ignored: ['已忽略', 'neutral'],
};
const kindNames: Partial<Record<InboxKind, string>> = { image: '图片', text: '文字消息', file: '文件' };

export function inboxKicker(row: Pick<InboxItem, 'kind'>) {
  return '收件箱 · ' + (kindNames[row.kind] || '文件');
}
export function inboxSubtitle(row: Pick<InboxItem, 'channel' | 'senderName' | 'conversation'>) {
  return [channelName(row.channel), row.senderName, row.conversation]
    .filter(Boolean)
    .join(' · ');
}
export function InboxStatus({ row }: { row: Pick<InboxItem, 'status'> }) {
  const [label, tone] = statusNames[row.status];
  return <StatusChip tone={tone}>{label}</StatusChip>;
}

/** 右侧详情正文：先看内容（文字、图片、附件），再看来源。 */
export default function InboxDetail({ row }: { row: InboxItem }) {
  const file = inboxFileUrl(row.id);
  return (
    <>
      {row.status === 'pending' && row.fileName && !importable.test(row.fileName) && (
        <Hint>这种文件不能自动识别，看完后手动新建订单，或标为已处理。</Hint>
      )}
      <Section title="内容">
        {row.text && <p className="adm-message">{row.text}</p>}
        {row.kind === 'image' && (
          <img className="adm-image" src={file} alt={row.fileName || '图片'} />
        )}
        {row.fileName && (
          <div className="adm-file-card">
            <FileText size={18} aria-hidden="true" />
            <span title={row.fileName}>{row.fileName}</span>
            <a
              className="button-link secondary"
              href={file}
              download
              aria-label={'下载 ' + row.fileName}
            >
              <Download size={14} aria-hidden="true" />
              下载
            </a>
          </div>
        )}
        {!row.text && !row.fileName && <p className="adm-muted">没有内容</p>}
      </Section>
      <Section title="来源">
        <Facts
          items={[
            { label: '来源', value: channelName(row.channel) },
            { label: '发送人', value: row.senderName },
            { label: '会话', value: row.conversation },
            { label: '收到时间', value: beijingTime(row.receivedAt) },
            { label: '处理人', value: row.handledBy },
          ]}
        />
      </Section>
    </>
  );
}
