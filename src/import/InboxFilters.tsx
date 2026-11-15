import type { InboxChannelOption, InboxStatus } from '../../shared/import/index';
import type { useInboxList } from './useInboxList';

const tabs: [InboxStatus, string][] = [
  ['pending', '待处理'],
  ['converted', '已处理'],
  ['ignored', '已忽略'],
];

/** 收件箱筛选：处理状态（带条数）、搜索、来源。 */
export function InboxFilters({ list }: { list: ReturnType<typeof useInboxList> }) {
  const { status, channel, q } = list.filter;
  return (
    <section className="list-filters" aria-label="收件箱筛选">
      <div className="record-view-tabs" aria-label="处理状态">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            className={status === value ? 'selected' : ''}
            onClick={() => list.setStatus(value)}
          >
            {label}
            {list.data?.counts ? ' ' + list.data.counts[value] : ''}
          </button>
        ))}
      </div>
      <input
        className="inbox-search"
        aria-label="搜索收件箱"
        placeholder="搜索发送人、内容、文件名"
        value={q}
        onChange={(e) => list.setQ(e.target.value)}
      />
      <select aria-label="筛选来源" value={channel} onChange={(e) => list.setChannel(e.target.value)}>
        <option value="">全部来源</option>
        {list.channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </section>
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
