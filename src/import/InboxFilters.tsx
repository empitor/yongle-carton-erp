import type { InboxChannelOption, InboxStatus } from '../../shared/import/index';
import { ListToolbar } from '../ui/index';
import type { useInboxList } from './useInboxList';

const tabs: [InboxStatus, string][] = [
  ['pending', '待处理'],
  ['converted', '已处理'],
  ['ignored', '已忽略'],
];
/** 分段点出来的值（只会是上面几种之一） */
const isStatus = (value: string): value is InboxStatus => tabs.some(([key]) => key === value);

/** 收件箱筛选：搜索、处理状态（带条数）、来源。 */
export function InboxFilters({ list }: { list: ReturnType<typeof useInboxList> }) {
  const { status, channel, q } = list.filter;
  const counts = list.data?.counts;
  return (
    <ListToolbar
      label="收件箱筛选"
      search={q}
      onSearch={list.setQ}
      searchLabel="搜索收件箱"
      placeholder="搜索发送人、内容、文件名"
      scopeLabel="处理状态"
      scopes={tabs.map(([value, label]) => ({ value, label: label + (counts ? ' ' + counts[value] : '') }))}
      scope={status}
      onScope={(v) => {
        if (isStatus(v)) list.setStatus(v);
      }}
      keyFilter={
        <select aria-label="筛选来源" value={channel} onChange={(e) => list.setChannel(e.target.value)}>
          <option value="">全部来源</option>
          {list.channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** 配好了却没连上的机器人；一家都没配时提示可以手动上传。超级管理员给“去设置”。 */
export function ChannelNote({ channels, isAdmin }: { channels: InboxChannelOption[]; isAdmin: boolean }) {
  const bots = channels.filter((c) => c.id !== 'manual');
  const down = bots.filter((c) => c.configured && c.state !== 'connected').map((c) => c.label);
  const noBot = bots.length > 0 && !bots.some((c) => c.configured);
  if (!down.length && !noBot) return null;
  return (
    <p className="inbox-channel-note">
      {down.length
        ? down.join('、') + '现在没有连上，发给' + (down.length > 1 ? '它们' : '它') + '的消息暂时进不来。'
        : '还没有接机器人；现在可以手动上传或粘贴。'}
      {isAdmin && (
        <>
          {' '}
          <a href="#ai-settings?tab=channels">去设置</a>
        </>
      )}
    </p>
  );
}
