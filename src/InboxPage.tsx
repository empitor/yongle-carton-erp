import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, MessageSquare, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { managementRequest, useAuthState } from './session';
import DetailPanel from './ui/DetailPanel';
import { EmptyState, PageHeading, Pagination, TableRegion, useResettingPage } from './ui/ListLayout';

const PAGE_SIZE = 50;
const tabs = [
  ['pending', '待处理'],
  ['converted', '已转单'],
  ['ignored', '已忽略'],
] as const;
type Status = (typeof tabs)[number][0];
const channelNames: Record<string, string> = {
  manual: '手动添加',
  wecom_bot: '企业微信机器人',
  wecom_kf: '企业微信客服',
  wecom_archive: '企业微信',
};
const importable = /\.(xls|xlsx|doc|docx|pdf|jpg|jpeg|png)$/i;
const preview = (row: any) => row.fileName || row.text || '（无内容）';
const when = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'text' ? MessageSquare : FileText;
  return <Icon size={15} aria-hidden="true" className="inbox-kind" />;
}

export default function InboxPage() {
  const auth = useAuthState(),
    canEdit = !!auth?.actor?.permissions.includes('business:edit') || !!auth?.actor?.superAdminMode;
  const [status, setStatus] = useState<Status>('pending'),
    [channel, setChannel] = useState(''),
    [q, setQ] = useState(''),
    [data, setData] = useState<any>(null),
    [channels, setChannels] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [pasting, setPasting] = useState(false),
    [pasted, setPasted] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const [page, setPage] = useResettingPage([status, channel, q].join('|'));
  const input = useRef<HTMLInputElement>(null);
  const rows: any[] = data?.rows || [];

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ status, page: String(page), pageSize: String(PAGE_SIZE) });
    if (channel) query.set('channel', channel);
    if (q.trim()) query.set('q', q.trim());
    const timer = setTimeout(() => {
      managementRequest<any>('/inbox?' + query)
        .then((v) => {
          if (active) {
            setData(v);
            setSelected((s: any) => (s ? v.rows.find((r: any) => r.id === s.id) || null : null));
          }
        })
        .catch((e) => active && setError(e.message));
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [status, channel, q, page, revision]);
  useEffect(() => {
    const readChannels = () =>
      managementRequest<any[]>('/inbox/channels').then(setChannels).catch(() => {});
    void readChannels();
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener('erp-business-changed', refresh);
    // 机器人收到的消息在后台进来，页面开着时定时看一眼。
    const timer = setInterval(() => {
      void readChannels();
      refresh();
    }, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('erp-business-changed', refresh);
    };
  }, []);

  const changed = () => {
    setRevision((v) => v + 1);
    window.dispatchEvent(new Event('erp-business-changed'));
  };
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mark = (row: any, next: Status, extra: object = {}) =>
    managementRequest('/inbox/' + row.id + '/status', {
      status: next,
      expectedVersion: row.version,
      ...extra,
    });
  const convert = (row: any, kind: 'order' | 'arrival' | 'mark') =>
    work(async () => {
      const result = await managementRequest<any>('/inbox/' + row.id + '/convert', {
        kind,
        expectedVersion: row.version,
      });
      changed();
      location.hash = '#ai-import?workspace=' + result.workspaceId;
    });
  const addText = () =>
    work(async () => {
      await managementRequest('/inbox', { text: pasted.trim() });
      setPasted('');
      setPasting(false);
      setStatus('pending');
      changed();
    });
  const addFiles = (files: File[]) =>
    work(async () => {
      const { csrf } = await fetch('/api/auth/state').then((r) => r.json());
      for (const file of files) {
        const r = await fetch('/api/inbox/upload?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-ERP-Auth-Token': csrf,
          },
          body: file,
        });
        if (!r.ok) throw new Error((await r.json()).message || file.name + ' 上传失败');
      }
      setStatus('pending');
      changed();
    });

  const actions = (row: any) => {
    if (row.status !== 'pending')
      return row.convertedKind && row.convertedRef ? (
        <a href={'#ai-import?workspace=' + row.convertedRef}>查看导入任务</a>
      ) : (
        <button disabled={!canEdit || busy} onClick={() => void work(async () => {
          await mark(row, 'pending');
          changed();
        })}>
          恢复待处理
        </button>
      );
    const canImport = !!row.fileName && importable.test(row.fileName);
    return (
      <>
        {canImport ? (
          <>
            <button disabled={!canEdit || busy} onClick={() => void convert(row, 'order')}>
              转订单
            </button>
            <button disabled={!canEdit || busy} onClick={() => void convert(row, 'arrival')}>
              转到货
            </button>
            <button disabled={!canEdit || busy} onClick={() => void convert(row, 'mark')}>
              转唛头
            </button>
          </>
        ) : (
          <>
            <a className="button" href={'#orders?create=1&inbox=' + row.id}>
              新建订单
            </a>
            <button
              disabled={!canEdit || busy}
              onClick={() =>
                void work(async () => {
                  await mark(row, 'converted');
                  changed();
                })
              }
            >
              已处理
            </button>
          </>
        )}
        <button
          disabled={!canEdit || busy}
          onClick={() =>
            void work(async () => {
              await mark(row, 'ignored');
              changed();
            })
          }
        >
          忽略
        </button>
      </>
    );
  };
  const step = (delta: number) => {
    const next = rows[rows.findIndex((r) => r.id === selected?.id) + delta];
    if (next) setSelected(next);
  };
  const bot = channels.find((c) => c.id === 'wecom_bot');
  const botDown = !!bot?.configured && bot.state !== 'connected';
  const isAdmin = auth?.actor?.role === 'super_admin';

  return (
    <div className="inbox-page">
      <PageHeading
        title="收件箱"
        actions={
          <>
            <button onClick={() => setRevision((v) => v + 1)}>
              <RefreshCw size={15} aria-hidden="true" />
              <span className="sr-only">刷新</span>
            </button>
            <button disabled={!canEdit} onClick={() => setPasting(true)}>
              <Plus size={15} />
              粘贴文字
            </button>
            <button className="primary" disabled={!canEdit} onClick={() => input.current?.click()}>
              <Upload size={15} />
              上传文件
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="上传到收件箱"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files || []));
                e.target.value = '';
              }}
            />
          </>
        }
      />
      <section className="list-filters" aria-label="收件箱筛选">
        <div className="record-view-tabs" aria-label="处理状态">
          {tabs.map(([value, label]) => (
            <button
              key={value}
              className={status === value ? 'selected' : ''}
              onClick={() => setStatus(value)}
            >
              {label}
              {data?.counts ? ' ' + data.counts[value] : ''}
            </button>
          ))}
        </div>
        <input
          className="inbox-search"
          aria-label="搜索收件箱"
          placeholder="搜索发送人、内容、文件名"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select aria-label="筛选来源" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">全部来源</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </section>
      {bot && (botDown || !bot.configured) && (
        <p className="inbox-channel-note">
          {botDown
            ? '企业微信机器人现在没有连上，发给它的消息暂时进不来。'
            : '企业微信机器人还没有连接；现在可以手动上传或粘贴。'}
          {isAdmin && (
            <>
              {' '}
              <a href="#ai-settings?tab=channels">去设置</a>
            </>
          )}
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="关闭提示" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      <section className="panel business-records">
        <TableRegion label="收件箱列表">
          <table>
            <thead>
              <tr>
                <th>来源</th>
                <th>发送人</th>
                <th>内容</th>
                <th>收到时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  className={'record-row' + (selected?.id === row.id ? ' selected' : '')}
                  aria-selected={selected?.id === row.id}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('a,button')) setSelected(row);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target === e.currentTarget) setSelected(row);
                  }}
                >
                  <td>{channelNames[row.channel] || row.channel}</td>
                  <td className="cell-wrap">
                    {row.senderName || '—'}
                    {row.conversation && <span className="sub"> {row.conversation}</span>}
                  </td>
                  <td className="cell-wrap inbox-content" title={preview(row)}>
                    <KindIcon kind={row.kind} />
                    <button
                      className="row-key"
                      aria-label={'查看 ' + preview(row)}
                      onClick={() => setSelected(row)}
                    >
                      {preview(row)}
                    </button>
                  </td>
                  <td className="record-date">{when(row.receivedAt)}</td>
                  <td>
                    <div className="inbox-row-actions">{actions(row)}</div>
                  </td>
                </tr>
              ))}
              {data && !rows.length && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      title={status === 'pending' ? '没有待处理的内容' : '这里还是空的'}
                      description={
                        status === 'pending' ? '发给企业微信机器人的内容会自动进来，也可以上传文件或粘贴文字。' : ' '
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableRegion>
        <Pagination
          page={data?.page ?? 1}
          total={data?.filteredRecords ?? 0}
          pageSize={PAGE_SIZE}
          onChange={setPage}
        />
      </section>
      {selected && (
        <DetailPanel
          title={selected.fileName || selected.senderName || '文字消息'}
          actions={actions(selected)}
          close={() => setSelected(null)}
          previous={() => step(-1)}
          next={() => step(1)}
        >
          <dl className="record-detail-grid">
            {(
              [
                ['来源', channelNames[selected.channel] || selected.channel],
                ['发送人', selected.senderName],
                ['会话', selected.conversation],
                ['收到时间', new Date(selected.receivedAt).toLocaleString('zh-CN')],
                ['处理人', selected.handledBy],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || '—'}</dd>
              </div>
            ))}
          </dl>
          {selected.text && <p className="inbox-text">{selected.text}</p>}
          {selected.kind === 'image' && (
            <img
              className="inbox-image"
              src={'/api/inbox/' + selected.id + '/file'}
              alt={selected.fileName || '图片'}
            />
          )}
          {selected.fileName && (
            <a href={'/api/inbox/' + selected.id + '/file'} download>
              下载 {selected.fileName}
            </a>
          )}
        </DetailPanel>
      )}
      {pasting && (
        <div className="overlay" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="粘贴文字">
            <header className="modal-head">
              <h2>粘贴文字</h2>
              <button className="icon-button" aria-label="关闭" onClick={() => setPasting(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="inbox-paste">
              <textarea
                autoFocus
                rows={8}
                aria-label="粘贴的内容"
                placeholder="把客户发来的文字粘贴到这里"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <div className="form-actions">
                <button onClick={() => setPasting(false)}>取消</button>
                <button className="primary" disabled={!pasted.trim() || busy} onClick={() => void addText()}>
                  加入收件箱
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
