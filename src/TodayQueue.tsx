import { useEffect, useState } from 'react';
import { displayAmount } from '../shared/display-amount';
import { managementRequest } from './session';
import Chain from './ui/Chain';

type Row = {
  key: string;
  number?: string;
  main: string;
  note?: string;
  href: string;
  action: string;
  order?: any;
};
type Group = { id: string; title: string; tone?: 'danger' | 'ai'; rows: Row[] };

/** 今日：先列出卡住和该处理的单据，每行只有一个动作；经营数字只占一行。 */
export default function TodayQueue() {
  const [data, setData] = useState<any>(null),
    [inbox, setInbox] = useState<any[]>([]),
    [mail, setMail] = useState<any[]>([]),
    [dueRows, setDueRows] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const load = () => {
      managementRequest<any>('/business/today')
        .then((v) => {
          setData(v);
          setError('');
        })
        .catch((e) => setError(e.message));
      managementRequest<any>('/inbox?status=pending&page=1&pageSize=5')
        .then((v) => setMail(v.rows))
        .catch(() => {});
      // 没有财务权限会被拒绝，这时今日页就不显示这一组。
      managementRequest<any>('/finance/due-soon?days=7&pageSize=10')
        .then((v) => setDueRows(v.rows))
        .catch(() => setDueRows([]));
      fetch('/api/ai/imports', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => setInbox((s?.workspaces || []).filter((w: any) => !w.imported)))
        .catch(() => {});
    };
    load();
    window.addEventListener('erp-business-changed', load);
    return () => window.removeEventListener('erp-business-changed', load);
  }, []);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <div className="queue-empty">正在读取今日待办…</div>;
  const orderRow = (o: any, note: string, action: string, href?: string): Row => ({
    key: 'o' + o.id,
    number: o.number,
    main: o.customerName + ' · ' + o.summary,
    note,
    href: href || '#orders?order=' + o.id,
    action,
    order: o,
  });
  const groups = (
    [
    {
      id: 'overdue',
      title: '逾期未发货',
      tone: 'danger',
      rows: data.overdue.map((o: any) => orderRow(o, '超期 ' + o.lateDays + ' 天', '处理')),
    },
    {
      id: 'unscheduled',
      title: '未排产',
      rows: data.unscheduled.map((o: any) => orderRow(o, '交期 ' + o.deliveryDate, '排产')),
    },
    {
      id: 'mail',
      title: '收件箱待处理',
      rows: mail.map((m: any) => ({
        key: 'm' + m.id,
        main: m.fileName || m.text || '（无内容）',
        note: m.senderName || '手动添加',
        href: '#inbox',
        action: '处理',
      })),
    },
    {
      id: 'inbox',
      title: 'AI 导入待核对',
      tone: 'ai',
      rows: inbox.map((w) => ({
        key: 'w' + w.id,
        main: w.fileName,
        note: w.hasDraft ? '已识别，待核对' : '待识别',
        href: '#ai-import?workspace=' + w.id,
        action: w.hasDraft ? '核对' : '识别',
      })),
    },
    {
      id: 'financeDue',
      title: '货款到期',
      rows: dueRows.map((d: any) => ({
        key: 'd' + d.id + ':' + d.installment_id,
        main: d.party_name + ' · ' + (d.kind === 'receivable' ? '应收 ' : '应付 ') + (Number(d.balance) / 100).toFixed(2) + ' 元',
        note: Number(d.days_to_due) < 0 ? '逾期 ' + -d.days_to_due + ' 天' : d.days_to_due + ' 天后到期',
        href: '#finance-ar?tab=soon',
        action: '查看',
      })),
    },
    {
      id: 'toOrder',
      title: '待下单采购',
      rows: data.toOrder.map((p: any) => ({
        key: 'p' + p.id,
        number: p.number,
        main: p.supplierName + ' · ' + p.summary,
        href: '#purchases?record=' + p.id,
        action: '下单',
      })),
    },
    {
      id: 'arrivalsDue',
      title: '到货待登记',
      rows: data.arrivalsDue.map((p: any) => ({
        key: 'a' + p.id,
        number: p.number,
        main: p.supplierName + ' · ' + p.summary,
        note: '预计 ' + p.expectedDate,
        href: '#purchases?record=' + p.id,
        action: '登记到货',
      })),
    },
    {
      id: 'ready',
      title: '可安排送货',
      rows: data.ready.map((o: any) =>
        orderRow(
          o,
          '交期 ' + o.deliveryDate,
          '安排送货',
          '#warehouse?kind=finished&createDelivery=1&order=' + o.id,
        ),
      ),
    },
    {
      id: 'draftDeliveries',
      title: '送货待确认',
      rows: data.draftDeliveries.map((d: any) => ({
        key: 'd' + d.id,
        number: d.number,
        main: d.customerName,
        note: '计划 ' + d.plannedDate,
        href: '#warehouse?kind=finished&deliveries=1&doc=' + d.id,
        action: '确认发货',
      })),
    },
    ] as Group[]
  ).filter((g) => g.rows.length);
  const s = data.summary;
  return (
    <>
      {data.backupFailedAt && (
        <div className="error" role="alert">
          自动备份失败（{new Date(data.backupFailedAt).toLocaleString('zh-CN')}
          ）。请检查磁盘空间或备份目录权限，并尽快手动备份。
        </div>
      )}
      <div className="today-strip" aria-label="经营摘要">
        <div>
          本月接单 <strong>¥{(s.monthOrderCents / 100).toLocaleString('zh-CN')}</strong>
        </div>
        <div>
          本月发货 <strong>¥{displayAmount(s.monthShippedAmount)}</strong>
        </div>
        <a className={data.overdue.length ? 'warn' : ''} href="#orders?view=pending&range=all">
          逾期 <strong>{data.overdue.length}</strong>
        </a>
        <div>
          未排产 <strong>{data.unscheduled.length}</strong>
        </div>
        <a href={'#warehouse?deliveries=1&kind=finished&date=' + data.date}>
          今日送货 <strong>{data.schedule.deliveries.length}</strong>
        </a>
      </div>
      <div className="today-grid">
        <section className="today-card">
          <h2>待处理</h2>
          {groups.map((g) => (
            <div className={'queue-group' + (g.tone ? ' tone-' + g.tone : '')} key={g.id}>
              <h3>
                {g.title} <span>{g.rows.length}</span>
              </h3>
              {g.rows.map((r) => (
                <a className="queue-row" href={r.href} key={r.key}>
                  {r.number && <span className="record-no">{r.number}</span>}
                  <span className="queue-main" title={r.main}>
                    {r.main}
                  </span>
                  {r.order && <Chain order={r.order} />}
                  {r.note && <span className="queue-note">{r.note}</span>}
                  <span className="queue-action">{r.action}</span>
                </a>
              ))}
            </div>
          ))}
          {!groups.length && <div className="queue-empty">今天没有待处理事项。</div>}
        </section>
        <div>
          <section className="today-card">
            <h2>今日安排</h2>
            <ul className="schedule-list">
              {data.schedule.arrivals.map((r: any) => (
                <li key={'a' + r.id}>
                  <b>到货</b>
                  <a href="#warehouse?arrivals=1">{r.label}</a>
                </li>
              ))}
              {data.schedule.tasks.map((r: any) => (
                <li key={'t' + r.id}>
                  <b>生产</b>
                  <a href="#production">{r.label}</a>
                </li>
              ))}
              {data.schedule.deliveries.map((r: any) => (
                <li key={'d' + r.id}>
                  <b>送货</b>
                  <a href="#warehouse?deliveries=1&kind=finished">{r.label}</a>
                </li>
              ))}
              {!data.schedule.arrivals.length &&
                !data.schedule.tasks.length &&
                !data.schedule.deliveries.length && <li>今天没有安排。</li>}
            </ul>
          </section>
          <section className="today-card">
            <h2>原材料零库存</h2>
            <ul className="schedule-list">
              {data.zeroStock.map((i: any) => (
                <li key={i.id}>
                  <a href={'#warehouse?kind=raw&q=' + encodeURIComponent(i.name)}>{i.name}</a>
                  {i.onOrder !== '0' && <small> 在途 {i.onOrder}</small>}
                </li>
              ))}
              {!data.zeroStock.length && <li>没有零库存的原材料。</li>}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
