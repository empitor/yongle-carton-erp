import { useEffect, useState } from 'react';
import DetailPanel from '../ui/DetailPanel';
import { ListSummary, PageHeading } from '../ui/ListLayout';
import {
  ErrorLine,
  ExportLink,
  FinList,
  FormDialog,
  PeriodInput,
  Status,
  col,
  documentName,
  finGet,
  finSend,
  metricNames,
  sourceMonthName,
  syncEvents,
  taxModes,
  useAction,
  useFinPerms,
  useFin,
  usePeriod,
  yuan,
} from './kit';
import { SourceDetail } from './OverviewPage';

const views = [
  ['', '全部'],
  ['theoreticalIncome', '送货'],
  ['theoreticalExpense', '到货'],
  ['actualIncome', '实收'],
  ['actualExpense', '实付'],
  ['ordered', '接单'],
] as const;

/** 单张补录：逐行填税率和口径。缺价格或数量时也在这里补金额。 */
function ResolvePanel({ row, done }: { row: any; done: () => void }) {
  const perms = useFinPerms();
  const lines0: any[] = row.detail?.financialLines || row.detail?.doc?.lines || row.detail?.doc?.items || [];
  const [lines, setLines] = useState(() =>
    lines0.map((l) => ({
      exact: String(l.exact ?? ''),
      rate: String(l.rate ?? l.taxRate ?? '').replace(/%$/, ''),
      mode: (l.mode ?? l.taxMode) === '不含税' ? '未税' : ['含税', '未税'].includes(l.mode ?? l.taxMode) ? (l.mode ?? l.taxMode) : '',
    })),
  );
  const [evidence, setEvidence] = useState('');
  const action = useAction();
  if (!row.id || !perms.edit) return null;
  const save = () =>
    action.run(async () => {
      const event = await finGet('/events/' + row.id);
      await finSend('POST', '/events/' + row.id + '/resolve', {
        version: event.version,
        ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
        lines,
      });
      done();
    });
  return (
    <>
      <h3>补财务资料</h3>
      <p className="fin-note">只改财务记录，不动送货单、到货单原件，也不影响理论盈亏。</p>
      <div className="table-wrap">
        <table className="fin-lines">
          <thead>
            <tr>
              <th>行</th>
              <th>金额 / 元</th>
              <th>税率 %</th>
              <th>口径</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const update = (patch: object) =>
                setLines((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行金额'}
                      value={l.exact}
                      onChange={(e) => update({ exact: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行税率'}
                      value={l.rate}
                      onChange={(e) => update({ rate: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={'第 ' + (i + 1) + ' 行口径'}
                      value={l.mode}
                      onChange={(e) => update({ mode: e.target.value })}
                    >
                      <option value="">请选择</option>
                      {taxModes.map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="field">
        <span>依据（选填）</span>
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </label>
      <ErrorLine text={action.error} close={action.clear} />
      <div className="fin-actions">
        <button
          className="primary"
          disabled={action.busy || lines.some((l) => !l.exact || !l.mode || l.rate === '')}
          onClick={save}
        >
          保存
        </button>
        <button
          disabled={action.busy}
          onClick={() => {
            setLines((all) => all.map((x) => ({ ...x, rate: '0', mode: '未税' })));
          }}
        >
          填成无税 / 不开票
        </button>
      </div>
    </>
  );
}

export default function FlowLedgerPage() {
  const [period, setPeriod] = usePeriod();
  const perms = useFinPerms();
  const [metric, setMetric] = useState('');
  const [missing, setMissing] = useState(
    () => new URLSearchParams(location.hash.split('?')[1] || '').get('missing') === '1',
  );
  const [sourceMonth, setSourceMonth] = useState('');
  const [row, setRow] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [dialog, setDialog] = useState<'picked' | 'party' | null>(null);
  const [synced, setSynced] = useState(0);
  const [syncError, setSyncError] = useState('');
  useEffect(() => {
    syncEvents()
      .then(() => setSynced((v) => v + 1))
      .catch((e) => setSyncError(e.message));
  }, [period]);
  const query = {
    period,
    metric: metric || undefined,
    missingTax: missing ? 1 : undefined,
    sourceMonth: sourceMonth || undefined,
    synced,
  };
  const flow = useFin('/flow', { period, pageSize: 1, synced });
  const s = flow.data?.summary;
  const taxable = rows.filter((r) => r.missing_tax && r.id);
  const allPicked = taxable.length > 0 && taxable.every((r) => picked.includes(r.id));
  const batchFields = [
    {
      name: 'how',
      label: '怎么补',
      type: 'select' as const,
      required: true,
      options: [
        ['rate', '填写税率'],
        ['noTax', '无税 / 不开票'],
        ['party', '用往来单位默认税率'],
      ] as const,
    },
    {
      name: 'rate',
      label: '税率 %',
      required: true,
      show: (v: any) => v.how === 'rate',
    },
    {
      name: 'mode',
      label: '口径',
      type: 'select' as const,
      required: true,
      options: taxModes,
      show: (v: any) => v.how === 'rate',
    },
    { name: 'evidence', label: '依据（选填）', wide: true },
  ];
  const howBody = (v: any) => ({
    ...(v.how === 'rate' ? { rate: v.rate, mode: v.mode } : {}),
    ...(v.how === 'noTax' ? { noTax: true } : {}),
    ...(v.how === 'party' ? { usePartyDefault: true } : {}),
    ...(v.evidence ? { evidence: v.evidence } : {}),
  });
  return (
    <div className="fin-page">
      <PageHeading
        title="月度台账"
        actions={
          <>
            <ExportLink
              path="/flow/export"
              query={{
                period,
                metric: metric || undefined,
                missingTax: missing ? 1 : undefined,
                sourceMonth: sourceMonth || undefined,
              }}
            />
            <PeriodInput
              value={period}
              onChange={(v) => {
                setPeriod(v);
                setPicked([]);
              }}
            />
          </>
        }
      />
      <ErrorLine text={syncError} close={() => setSyncError('')} />
      <ListSummary
        items={[
          { label: '接单', value: yuan(s?.ordered) },
          { label: '送货（理论收入）', value: yuan(s?.theoreticalIncome) },
          { label: '到货（理论支出）', value: yuan(s?.theoreticalExpense) },
          { label: '应收余额（本月单）', value: yuan(s?.receivableRemaining), hint: '已收 ' + yuan(s?.receivablePaid) },
          { label: '应付余额（本月单）', value: yuan(s?.payableRemaining), hint: '已付 ' + yuan(s?.payablePaid) },
          {
            label: '待补税率',
            value: s?.missingTax ?? '—',
            active: missing,
            onClick: () => {
              setMissing(!missing);
              setPicked([]);
            },
          },
        ]}
      />
      <section className="list-filters" aria-label="台账筛选">
        <div className="fin-toolbar">
          <div className="record-view-tabs" aria-label="单据类型">
            {views.map(([key, label]) => (
              <button
                key={key}
                className={metric === key ? 'selected' : ''}
                onClick={() => {
                  setMetric(key);
                  setPicked([]);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="fin-check">
            <input
              type="checkbox"
              checked={missing}
              onChange={(e) => {
                setMissing(e.target.checked);
                setPicked([]);
              }}
            />
            只看待补税率
          </label>
          <input
            type="text"
            aria-label="按单据月份筛选"
            placeholder="单据月份 2026-02"
            value={sourceMonth}
            onChange={(e) => setSourceMonth(e.target.value.trim())}
          />
          <span className="fin-grow" />
          {perms.edit && (
            <>
              <button disabled={!picked.length} onClick={() => setDialog('picked')}>
                补选中 {picked.length || ''} 张
              </button>
              <button onClick={() => setDialog('party')}>按单位整月补</button>
            </>
          )}
        </div>
      </section>
      <FinList
        key={synced}
        path="/flow"
        label="月度台账"
        query={query}
        onData={(d) => setRows(d.rows)}
        rowKey={(r, i) => r.metric + ':' + r.id + ':' + i}
        selected={row ? row.metric + ':' + row.id + ':' + rows.indexOf(row) : null}
        onRow={setRow}
        empty="这个月没有符合条件的单据"
        cols={[
          ...(perms.edit
            ? [
                col('pick', '', {
                  render: (r: any) =>
                    r.missing_tax && r.id ? (
                      <input
                        type="checkbox"
                        aria-label={'选择 ' + r.number}
                        checked={picked.includes(r.id)}
                        onChange={(e) =>
                          setPicked((p) =>
                            e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id),
                          )
                        }
                      />
                    ) : null,
                }),
              ]
            : []),
          col('date', '日期'),
          col('metric', '类型', { render: (r) => metricNames[r.metric] || r.metric }),
          col('number', '单号', { render: documentName }),
          col('party', '往来单位', { wrap: true }),
          col('source_month', '单据月份', { render: (r) => sourceMonthName(r.source_month) }),
          col('status', '状态', { render: (r) => <Status value={r.status} /> }),
          col('due_date', '到期日', { render: (r) => r.due_date || '—' }),
          col('amount', '金额 / 元', {
            money: true,
            render: (r) => (r.amount === null ? '缺价格' : yuan(r.amount)),
          }),
        ]}
      />
      {perms.edit && taxable.length > 0 && (
        <div className="fin-toolbar">
          <button onClick={() => setPicked(allPicked ? [] : taxable.map((r) => r.id))}>
            {allPicked ? '取消全选' : '全选本页待补'}
          </button>
        </div>
      )}
      {row && (
        <DetailPanel
          title={(metricNames[row.metric] || '') + ' ' + documentName(row)}
          status={<Status value={row.status} />}
          close={() => setRow(null)}
        >
          <SourceDetail row={row} />
          {row.status === 'info_pending' && (
            <ResolvePanel
              key={row.id}
              row={row}
              done={() => {
                setRow(null);
                setSynced((v) => v + 1);
              }}
            />
          )}
        </DetailPanel>
      )}
      {dialog === 'picked' && (
        <FormDialog
          title={'补 ' + picked.length + ' 张单据的税率'}
          intro="只改财务记录，单据原件和理论盈亏不变。"
          fields={batchFields}
          initial={{ how: 'rate' }}
          close={() => setDialog(null)}
          submit={async (v) => {
            const items = await Promise.all(
              picked.map(async (id) => {
                const e = await finGet('/events/' + id);
                return { id, version: e.version };
              }),
            );
            await finSend('POST', '/tax-completion/batch', { items, ...howBody(v) });
            setPicked([]);
            setSynced((n) => n + 1);
          }}
        />
      )}
      {dialog === 'party' && (
        <FormDialog
          title={'按单位补 ' + period + ' 的税率'}
          intro="一次补这个单位当月所有待补单据，每批最多 200 张。"
          fields={[
            {
              name: 'kind',
              label: '单位类型',
              type: 'select',
              required: true,
              options: [
                ['customer', '客户（送货单）'],
                ['supplier', '供应商（到货单）'],
              ],
            },
            {
              name: 'partyId',
              label: '单位',
              type: 'party',
              required: true,
              partyKind: (v) => v.kind,
            },
            ...batchFields,
          ]}
          initial={{ kind: 'customer', how: 'rate' }}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('POST', '/tax-completion/batch', {
              kind: v.kind,
              partyId: String(v.partyId),
              period,
              ...howBody(v),
            });
            setSynced((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
