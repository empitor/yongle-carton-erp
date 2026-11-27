import { useEffect, useRef, useState } from 'react';
import { useBusinessRevision, useLoad, useResettingPage } from '../ui/index';
import { errorMessage, pageParams } from '../../shared/core/index';
import type { InboxChannelOption, InboxItem, InboxList, InboxStatus } from '../../shared/import/index';
import { readInbox, readInboxChannels, readInboxItem, type InboxFilter } from './inbox-api';

/** 机器人收到的消息在后台进来，页面开着时隔这么久看一眼 */
const POLL_MS = 15000;
/** 搜索框打字时等一会儿再读 */
const TYPING_MS = 150;

/**
 * 读一页列表；打开的那一条不在当前页（比如从今日点进来的）时单独再读一次，详情不会自己关掉；
 * 处理完换了状态的，离开这个页签，详情随之关闭。
 */
function usePage(filter: InboxFilter, revision: number, setError: (message: string) => void) {
  const [data, setData] = useState<InboxList | null>(null),
    [selected, setSelected] = useState<InboxItem | null>(null);
  const selectedRef = useRef<InboxItem | null>(null);
  selectedRef.current = selected;
  const { status, channel, q, page } = filter;
  useEffect(() => {
    let active = true;
    const reopen = (open: InboxItem) =>
      readInboxItem(open.id)
        .then((row) => {
          if (active) setSelected((c) => (c?.id !== row.id ? c : row.status === status ? row : null));
        })
        .catch(() => {
          if (active) setSelected((c) => (c?.id === open.id ? null : c));
        });
    const timer = setTimeout(() => {
      readInbox({ status, channel, q, page })
        .then((v) => {
          if (!active) return;
          setData(v);
          const open = selectedRef.current,
            fresh = open && v.rows.find((r) => r.id === open.id);
          if (fresh) setSelected(fresh);
          else if (open) void reopen(open);
        })
        .catch((e: unknown) => {
          if (active) setError(errorMessage(e));
        });
    }, TYPING_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [status, channel, q, page, revision, setError]);
  return { data, selected, setSelected };
}

/** 消息来源（带连没连上），定时重读；顺带让列表也定时重读（bump） */
function useChannels(bump: () => void) {
  const [channels, setChannels] = useState<InboxChannelOption[]>([]);
  // bump 每次渲染都是新函数：放进 ref 取最新的，定时器只在打开页面时起一次
  const latestBump = useRef(bump);
  useEffect(() => {
    latestBump.current = bump;
  });
  useEffect(() => {
    const readChannels = () =>
      readInboxChannels()
        .then(setChannels)
        .catch(() => {
          // 来源只是筛选的选项：这次没读到就留着上次的，下一次定时再读
        });
    void readChannels();
    const timer = setInterval(() => {
      void readChannels();
      latestBump.current();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);
  return channels;
}

/**
 * 收件箱页的列表：按状态、来源、搜索读一页，打开的那一条跟着刷新；
 * 地址带 item=编号（今日的“查看”）时直接打开那一条。业务数据变了、定时都重读。
 */
export function useInboxList() {
  const [status, setStatus] = useState<InboxStatus>('pending'),
    [channel, setChannel] = useState(''),
    [q, setQ] = useState(''),
    [error, setError] = useState('');
  const [revision, bump] = useBusinessRevision();
  const [page, setPage] = useResettingPage([status, channel, q].join('|'));
  const { data, selected, setSelected } = usePage({ status, channel, q, page }, revision, setError);
  const channels = useChannels(bump);

  // 地址里 item= 带的收件编号
  const linked = pageParams('inbox', location.hash).item;
  const linkedRow = useLoad(linked ? String(linked) : null, (id) => readInboxItem(Number(id)));
  useEffect(() => {
    const row = linkedRow.data;
    if (!row) return;
    setSelected(row);
    setStatus(row.status);
  }, [linkedRow.data, setSelected]);
  useEffect(() => {
    if (linkedRow.error) setError(linkedRow.error);
  }, [linkedRow.error]);

  return {
    filter: { status, channel, q, page },
    setStatus,
    setChannel,
    setQ,
    setPage,
    data,
    rows: data?.rows ?? [],
    channels,
    selected,
    setSelected,
    error,
    clearError: () => setError(''),
    /** 地址里带的那一条（关详情时把地址改回 #inbox） */
    linked,
  };
}
