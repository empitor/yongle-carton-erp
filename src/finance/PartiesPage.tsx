import { useState } from 'react';
import DetailPanel from '../ui/DetailPanel';
import { ListSummary, PageHeading } from '../ui/ListLayout';
import MoreMenu from '../ui/MoreMenu';
import {
  ErrorLine,
  ExportLink,
  Facts,
  FinList,
  FinTable,
  FormDialog,
  PartyPicker,
  PeriodInput,
  Status,
  Tabs,
  col,
  finGet,
  finSend,
  mon,
  percentOf,
  todayText,
  useFin,
  useFinPerms,
  usePeriod,
  useTab,
  yuan,
} from './kit';
import TermsDialog from './TermsDialog';

const tabs = [
  ['items', '往来单'],
  ['held', '压货款'],
  ['plan', '收付计划'],
  ['soon', '到期提醒'],
  ['discount', '现结优惠'],
  ['aging', '账龄'],
  ['statement', '对账单'],
  ['terms', '账期设置'],
  ['deposits', '保证金'],
  ['interest', '压款利息'],
] as const;
type Kind = 'receivable' | 'payable';
const partyKindOf = (k: Kind) => (k === 'receivable' ? 'customer' : 'supplier');
const describeTerm = (r: any) =>
  r.term_type === 'monthly'
    ? '压 ' + r.term_months + ' 个月，每月 ' + r.payment_day + ' 号付' +
      (r.cutoff_day ? '，' + r.cutoff_day + ' 号截止' : '')
    : r.term_type === 'days' && Number(r.term_days) > 0
      ? '压 ' + r.term_days + ' 天'
      : '没有约定';

function ObligationsTab({ kind }: { kind: Kind }) {
  const perms = useFinPerms();
  const [partyId, setPartyId] = useState('');
  const [row, setRow] = useState<any>(null);
  const [dialog, setDialog] = useState<'new' | 'due' | 'bad' | 'recalc' | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState('');
  const openRecalc = async () => {
    setError('');
    try {
      setPreview(await finGet('/due-recalculation', { kind, partyId }));
      setDialog('recalc');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <div className="fin-toolbar">
        <PartyPicker kind={partyKindOf(kind)} value={partyId} onChange={setPartyId} allowAll />
        <span className="fin-grow" />
        {perms.edit && (
          <>
            <button disabled={!partyId} onClick={openRecalc}>
              按新账期重算到期日
            </button>
            <button onClick={() => setDialog('new')}>手工录往来</button>
          </>
        )}
      </div>
      <ErrorLine text={error} close={() => setError('')} />
      <FinList
        path="/obligations"
        label="往来单"
        query={{ kind, partyId: partyId || undefined }}
        onRow={setRow}
        selected={row?.id}
        cols={[
          col('date', '日期'),
          col('source_number', '单据', { render: (r) => r.source_number || '手工' }),
          col('party_name', '往来单位', { wrap: true }),
          col('tax_status', '税率', {
            render: (r) =>
              r.tax_status === 'pending' ? <Status value="info_pending" /> : '已明确',
          }),
          col('due_date', '到期日', { render: (r) => r.due_date || '没有账期' }),
          mon('amount_cents', '金额 / 元'),
          mon('allocated', '已核销'),
          mon('balance', '余额'),
        ]}
      />
      {row && (
        <DetailPanel
          title={row.party_name + ' · ' + row.date}
          close={() => setRow(null)}
          actions={
            perms.edit ? (
              <div className="fin-actions">
                <button onClick={() => setDialog('due')}>改到期日</button>
                {kind === 'receivable' && row.voucher_id && (
                  <button onClick={() => setDialog('bad')}>坏账</button>
                )}
              </div>
            ) : undefined
          }
        >
          <Facts
            items={[
              ['单据', row.source_number],
              ['摘要', row.description],
              ['金额 / 元', yuan(row.amount_cents)],
              ['已核销 / 元', yuan(row.allocated)],
              ['余额 / 元', yuan(row.balance)],
              ['到期日', row.due_date || '没有账期'],
              ['距到期', row.days_to_due != null ? row.days_to_due + ' 天' : null],
              ['已开票 / 元', yuan(row.invoiced)],
              ['凭证', row.voucher_id ? <a href={'#finance-ledger?voucher=' + row.voucher_id}>查看</a> : '未生成'],
            ]}
          />
        </DetailPanel>
      )}
      {dialog === 'new' && (
        <FormDialog
          title={kind === 'receivable' ? '手工录应收' : '手工录应付'}
          intro="用于没有送货单、到货单的往来。保存后生成凭证草稿。"
          fields={[
            { name: 'partyId', label: '往来单位', type: 'party', required: true, partyKind: partyKindOf(kind) },
            { name: 'date', label: '日期', type: 'date', required: true },
            { name: 'dueDate', label: '到期日', type: 'date' },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
            { name: 'counterAccount', label: '对方科目', type: 'account', required: true },
            { name: 'description', label: '摘要', required: true, wide: true },
          ]}
          initial={{ date: todayText(), partyId }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/obligations', { ...v, kind })}
        />
      )}
      {dialog === 'due' && row && (
        <FormDialog
          title="改到期日"
          intro="改动留审计记录。"
          fields={[
            { name: 'dueDate', label: '到期日', type: 'date', required: true },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ dueDate: row.due_date }}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('PUT', '/obligations/' + row.id + '/due', { ...v, version: row.version });
            setRow(null);
          }}
        />
      )}
      {dialog === 'bad' && row && (
        <FormDialog
          title="坏账处理"
          fields={[
            {
              name: 'kind',
              label: '方式',
              type: 'select',
              required: true,
              options: [
                ['writeoff', '直接核销'],
                ['provision', '计提准备'],
              ],
            },
            { name: 'date', label: '日期', type: 'date', required: true },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
            {
              name: 'counterAccount',
              label: '备抵科目',
              type: 'account',
              required: true,
              show: (v) => v.kind === 'provision',
            },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ kind: 'writeoff', date: todayText(), amount: row.balance }}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('POST', '/obligations/' + row.id + '/bad-debt', {
              ...v,
              version: row.version,
            });
            setRow(null);
          }}
        />
      )}
      {dialog === 'recalc' && preview && (
        <FormDialog
          title="按新账期重算到期日"
          intro={
            preview.rows.length + preview.installments.length
              ? '会改 ' + preview.rows.length + ' 张单据、' + preview.installments.length + ' 个分期的到期日。已收付的部分不变。'
              : '当前账期算出来的到期日和现有的一样，不需要重算。'
          }
          fields={[{ name: 'reason', label: '原因', required: true, wide: true }]}
          submitLabel="确认重算"
          close={() => setDialog(null)}
          submit={(v) =>
            finSend('POST', '/due-recalculation', {
              kind,
              partyId,
              digest: preview.digest,
              reason: v.reason,
            })
          }
        >
          {preview.rows.length > 0 && (
            <FinTable
              label="重算预览"
              rows={preview.rows}
              cols={[
                col('before', '原到期日', { render: (r) => r.before || '没有' }),
                col('dueDate', '新到期日'),
                mon('balance', '余额'),
              ]}
            />
          )}
        </FormDialog>
      )}
    </>
  );
}

function HeldTab({ kind }: { kind: Kind }) {
  const [date, setDate] = useState(todayText());
  const [data, setData] = useState<any>(null);
  const rows: any[] = data?.rows || [];
  const sum = (key: string) => rows.reduce((n, r) => n + Number(r[key] || 0), 0);
  return (
    <>
      <div className="fin-toolbar">
        <label className="fin-period">
          <span>截至</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <ListSummary
        items={[
          { label: kind === 'receivable' ? '客户压我们，还没到期' : '我们压供应商，还没到期', value: yuan(sum('held')) },
          { label: '已到期未结', value: yuan(sum('due')) },
          { label: '没有约定账期', value: yuan(sum('no_terms')) },
        ]}
      />
      <FinList
        path="/held"
        label="压货款"
        query={{ kind, date }}
        onData={setData}
        rowKey={(r) => r.party_id}
        cols={[
          col('party_name', '往来单位', { wrap: true }),
          col('term', '约定', { render: describeTerm }),
          col('earliest_due', '最早到期', { render: (r) => r.earliest_due || '—' }),
          mon('held', '压着（未到期）'),
          mon('due', '已到期'),
          mon('no_terms', '无账期'),
          col('over_limit', '超授信', {
            money: true,
            render: (r) =>
              Number(r.over_limit) > 0 ? <span className="fin-negative">{yuan(r.over_limit)}</span> : '—',
          }),
        ]}
      />
    </>
  );
}

function PlanTab() {
  const [months, setMonths] = useState(6);
  const [dueMonth, setDueMonth] = useState('');
  const date = todayText();
  const { data, error } = useFin('/payment-plan', {
    date,
    months,
    dueMonth: dueMonth || undefined,
  });
  return (
    <>
      <div className="fin-toolbar">
        <label className="fin-period">
          <span>看未来</span>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>
                {m} 个月
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorLine text={error} />
      <ListSummary
        items={[
          { label: '现在的资金', value: yuan(data?.openingCash) },
          { label: '无账期应收', value: yuan(data?.noTerms?.receivable), hint: '没算进预测' },
          { label: '无账期应付', value: yuan(data?.noTerms?.payable), hint: '没算进预测' },
          ...((data?.deposits || []) as any[]).map((d) => ({
            label: d.kind === 'paid' ? '付出的保证金' : '收到的保证金',
            value: yuan(d.balance),
          })),
        ]}
      />
      <section className="panel business-records">
        <FinTable
          label="按月收付计划"
          rows={data?.forecast || []}
          rowKey={(r) => r.period}
          onRow={(r) => setDueMonth(r.period === 'overdue' ? '' : r.period === dueMonth ? '' : r.period)}
          selected={dueMonth}
          cols={[
            col('period', '月份', { render: (r) => (r.period === 'overdue' ? '已逾期' : r.period) }),
            mon('receivable', '应收到'),
            mon('payable', '应付出'),
            col('forecastCash', '预计资金', {
              money: true,
              render: (r) => (
                <span className={Number(r.forecastCash) < 0 ? 'fin-negative' : undefined}>
                  {yuan(r.forecastCash)}
                </span>
              ),
            }),
          ]}
        />
      </section>
      {dueMonth && (
        <section className="panel business-records">
          <FinTable
            label={dueMonth + ' 到期明细'}
            rows={data?.detail?.rows || []}
            rowKey={(r, i) => r.id + ':' + r.installment_id + ':' + i}
            cols={[
              col('kind', '类型', { render: (r) => (r.kind === 'receivable' ? '应收' : '应付') }),
              col('party_name', '往来单位', { wrap: true }),
              col('date', '单据日期'),
              col('due_date', '到期日'),
              mon('balance', '金额 / 元'),
            ]}
          />
        </section>
      )}
    </>
  );
}

function SoonTab() {
  const [days, setDays] = useState(7);
  return (
    <>
      <div className="fin-toolbar">
        <label className="fin-period">
          <span>未来</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 15, 30, 60].map((d) => (
              <option key={d} value={d}>
                {d} 天
              </option>
            ))}
          </select>
        </label>
        <span className="fin-note">已逾期的也列在这里。</span>
      </div>
      <FinList
        path="/due-soon"
        label="到期提醒"
        query={{ days }}
        rowKey={(r, i) => r.id + ':' + r.installment_id + ':' + i}
        empty="这段时间没有到期的单子"
        cols={[
          col('due_date', '到期日'),
          col('days_to_due', '距今', {
            num: true,
            render: (r) =>
              Number(r.days_to_due) < 0 ? (
                <span className="fin-negative">逾期 {-r.days_to_due} 天</span>
              ) : (
                r.days_to_due + ' 天'
              ),
          }),
          col('kind', '类型', { render: (r) => (r.kind === 'receivable' ? '应收' : '应付') }),
          col('party_name', '往来单位', { wrap: true }),
          col('date', '单据日期'),
          mon('balance', '金额 / 元'),
        ]}
      />
    </>
  );
}

function DiscountTab({ kind }: { kind: Kind }) {
  return (
    <>
      <p className="fin-note">
        {kind === 'payable'
          ? '现在付款能拿到供应商优惠的单子。年化收益用来对比把钱留着的价值。'
          : '客户现在结清可以享受优惠的单子。'}
        收付款时在核销里填优惠金额即可。
      </p>
      <FinList
        path="/discount-opportunities"
        label="现结优惠"
        query={{ kind }}
        empty="现在没有可用的优惠"
        cols={[
          col('date', '单据日期'),
          col('party_name', '往来单位', { wrap: true }),
          col('due_date', '到期日', { render: (r) => r.due_date || '—' }),
          mon('balance', '未结 / 元'),
          col('rate', '优惠', { num: true, render: (r) => r.offer.rate + '%' }),
          col('offer', '可省 / 元', { num: true, render: (r) => yuan(r.offer.amount) }),
          col('deadline', '最晚付款', { render: (r) => r.offer.deadline }),
          col('annual', '年化', {
            num: true,
            render: (r) =>
              r.offer.annualized
                ? percentOf(r.offer.annualized.numerator, r.offer.annualized.denominator)
                : '—',
          }),
        ]}
      />
    </>
  );
}

function AgingTab({ kind }: { kind: Kind }) {
  const [basis, setBasis] = useState<'document' | 'due'>('document');
  const [overdue, setOverdue] = useState(false);
  const [data, setData] = useState<any>(null);
  const bands: number[] = data?.bands || [];
  const bandName = (i: number) =>
    i === 0
      ? '未满'
      : i > bands.length
        ? bands.at(-1) + ' 天以上'
        : (bands[i - 2] || 0) + 1 + '–' + bands[i - 1] + ' 天';
  return (
    <>
      <div className="fin-toolbar">
        <select aria-label="账龄起算" value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
          <option value="document">按单据日算</option>
          <option value="due">按到期日算</option>
        </select>
        <label className="fin-check">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          只看逾期
        </label>
      </div>
      <ListSummary
        items={((data?.totals || []) as any[]).map((t) => ({
          label: bandName(Number(t.bucket)),
          value: yuan(t.balance),
          hint: t.count + ' 笔',
        }))}
      />
      <FinList
        path="/aging"
        label="账龄"
        query={{ kind, basis, overdue: overdue ? 1 : undefined }}
        onData={setData}
        empty="没有未结清的单子"
        cols={[
          col('date', '单据日期'),
          col('party_name', '往来单位', { wrap: true }),
          col('due_date', '到期日', { render: (r) => r.due_date || '没有账期' }),
          col('days', '账龄', { num: true, render: (r) => r.days + ' 天' }),
          mon('balance', '余额 / 元'),
        ]}
      />
    </>
  );
}

function StatementTab({ kind }: { kind: Kind }) {
  const perms = useFinPerms();
  const [period] = usePeriod();
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState(period + '-01');
  const [to, setTo] = useState(todayText());
  const [dialog, setDialog] = useState(false);
  const query = { kind, partyId, from, to };
  const { data, error } = useFin(partyId ? '/statements' : null, query);
  return (
    <>
      <div className="fin-toolbar">
        <PartyPicker kind={partyKindOf(kind)} value={partyId} onChange={setPartyId} />
        <input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} />
        至
        <input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="fin-grow" />
        {partyId && <ExportLink path="/statements/export" query={query} />}
        {partyId && perms.edit && <button onClick={() => setDialog(true)}>标记状态</button>}
      </div>
      <ErrorLine text={error} />
      {!partyId && <p className="fin-note">先选往来单位。</p>}
      {data && (
        <>
          <ListSummary
            items={[
              { label: '期初', value: yuan(data.opening) },
              { label: '期末', value: yuan(data.closing) },
              { label: '状态', value: <Status value={data.state?.status || 'draft'} /> },
              ...(data.state?.discrepancy ? [{ label: '差异', value: data.state.discrepancy }] : []),
            ]}
          />
          <section className="panel business-records">
            <FinTable
              label="对账单"
              rows={data.items}
              rowKey={(_, i) => i}
              empty="这段时间没有发生额"
              cols={[
                col('date', '日期'),
                col('number', '凭证号', { render: (r) => r.number ?? '未记账' }),
                col('description', '摘要', { wrap: true }),
                col('due_date', '到期日', { render: (r) => r.due_date || '—' }),
                mon('delta', '发生额 / 元'),
              ]}
            />
          </section>
        </>
      )}
      {dialog && (
        <FormDialog
          title="标记对账状态"
          fields={[
            {
              name: 'status',
              label: '状态',
              type: 'select',
              required: true,
              options: [
                ['sent', '已发给对方'],
                ['confirmed', '对方已确认'],
                ['difference', '有差异'],
              ],
            },
            { name: 'discrepancy', label: '差异说明', wide: true, show: (v) => v.status === 'difference' },
          ]}
          initial={{ status: data?.state?.status, discrepancy: data?.state?.discrepancy }}
          close={() => setDialog(false)}
          submit={(v) =>
            finSend('PUT', '/statements', {
              ...query,
              status: v.status,
              discrepancy: v.discrepancy || '',
              ...(data?.state ? { version: data.state.version } : {}),
            })
          }
        />
      )}
    </>
  );
}

function TermsTab({ kind }: { kind: Kind }) {
  const perms = useFinPerms();
  const pk = partyKindOf(kind);
  const [editing, setEditing] = useState<{ partyId?: string } | null>(null);
  return (
    <>
      <div className="fin-toolbar">
        <span className="fin-note">
          压货款、默认税率、现结优惠、分期、保证金和压款利息都按单位设。
        </span>
        <span className="fin-grow" />
        {perms.edit && (
          <button className="primary" onClick={() => setEditing({})}>
            设置{pk === 'customer' ? '客户' : '供应商'}账期
          </button>
        )}
      </div>
      <FinList
        path="/party-terms"
        label="账期设置"
        query={{ kind: pk }}
        rowKey={(r) => r.party_id}
        onRow={perms.edit ? (r) => setEditing({ partyId: String(r.party_id) }) : undefined}
        empty="还没有设置账期。没设的单位，到期日留空，不影响业务。"
        cols={[
          col('party_name', '往来单位', { wrap: true }),
          col('term', '压货款', { render: describeTerm }),
          col('tax', '默认税率', {
            render: (r) => (r.tax_rate ? r.tax_rate + '% ' + (r.tax_mode || '') : '未设'),
          }),
          col('discounts', '现结优惠', {
            render: (r) => {
              const o = JSON.parse(r.options || '{}');
              return o.discounts?.length ? o.discounts.map((d: any) => d.rate + '%').join('、') : '—';
            },
          }),
          col('interest', '利息', {
            render: (r) => {
              const o = JSON.parse(r.options || '{}');
              return o.interest ? o.interest.rate + '%' : '—';
            },
          }),
          col('credit_limit', '授信 / 元', {
            money: true,
            render: (r) => (r.credit_limit == null ? '—' : yuan(r.credit_limit)),
          }),
        ]}
      />
      {editing && (
        <TermsDialog kind={pk} partyId={editing.partyId} close={() => setEditing(null)} />
      )}
    </>
  );
}

function DepositsTab() {
  const perms = useFinPerms();
  const [dialog, setDialog] = useState<'new' | 'refund' | 'apply' | null>(null);
  const [row, setRow] = useState<any>(null);
  return (
    <>
      <div className="fin-toolbar">
        <span className="fin-note">保证金不算收入支出，在经营报表里单独列。</span>
        <span className="fin-grow" />
        {perms.cash && (
          <button className="primary" onClick={() => setDialog('new')}>
            新增保证金
          </button>
        )}
      </div>
      <FinList
        path="/deposits"
        label="保证金"
        empty="还没有保证金记录"
        cols={[
          col('date', '日期'),
          col('kind', '方向', { render: (r) => (r.kind === 'paid' ? '我们付出' : '我们收到') }),
          col('party_name', '往来单位', { wrap: true }),
          col('description', '说明', { wrap: true }),
          mon('amount_cents', '金额 / 元'),
          mon('balance', '余额 / 元'),
          col('ops', '', {
            render: (r) =>
              Number(r.balance) > 0 ? (
                <MoreMenu>
                  {perms.cash && (
                    <button
                      onClick={() => {
                        setRow(r);
                        setDialog('refund');
                      }}
                    >
                      退回
                    </button>
                  )}
                  {perms.edit && (
                    <button
                      onClick={() => {
                        setRow(r);
                        setDialog('apply');
                      }}
                    >
                      转抵货款
                    </button>
                  )}
                </MoreMenu>
              ) : null,
          }),
        ]}
      />
      {dialog === 'new' && (
        <FormDialog
          title="新增保证金"
          fields={[
            {
              name: 'kind',
              label: '方向',
              type: 'select',
              required: true,
              options: [
                ['paid', '我们付出'],
                ['received', '我们收到'],
              ],
            },
            {
              name: 'partyKind',
              label: '单位类型',
              type: 'select',
              required: true,
              options: [
                ['supplier', '供应商'],
                ['customer', '客户'],
              ],
            },
            { name: 'partyId', label: '单位', type: 'party', required: true, partyKind: (v) => v.partyKind },
            { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
            { name: 'date', label: '日期', type: 'date', required: true },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
            { name: 'description', label: '说明', required: true, wide: true },
          ]}
          initial={{ kind: 'paid', partyKind: 'supplier', date: todayText() }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/deposits', v)}
        />
      )}
      {(dialog === 'refund' || dialog === 'apply') && row && (
        <FormDialog
          title={dialog === 'refund' ? '退回保证金' : '转抵货款'}
          intro={'余额 ' + yuan(row.balance) + ' 元'}
          fields={[
            { name: 'date', label: '日期', type: 'date', required: true },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
            ...(dialog === 'refund'
              ? [{ name: 'accountId', label: '资金账户', type: 'cash-account' as const, required: true }]
              : [
                  {
                    name: 'obligationId',
                    label: '抵扣哪张单子',
                    type: 'obligation' as const,
                    required: true,
                    wide: true,
                    obligation: {
                      kind: row.kind === 'paid' ? ('payable' as const) : ('receivable' as const),
                      partyId: row.party_id,
                    },
                  },
                ]),
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ date: todayText(), amount: row.balance }}
          close={() => setDialog(null)}
          submit={(v) =>
            finSend('POST', '/deposits/' + row.id + '/actions', {
              ...v,
              kind: dialog,
              version: row.version,
            })
          }
        />
      )}
    </>
  );
}

function InterestTab({ kind }: { kind: Kind }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [row, setRow] = useState<any>(null);
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <span className="fin-note">系统按账期里设的利率给建议，确认后才入账。填 0 表示免除。</span>
      </div>
      <FinList
        path="/interest"
        label="压款利息"
        query={{ period, kind }}
        empty="没有设置利息的单位，或者这个月没有计息的单子"
        cols={[
          col('date', '单据日期'),
          col('party_name', '往来单位', { wrap: true }),
          col('due_date', '到期日', { render: (r) => r.due_date || '—' }),
          mon('balance', '余额 / 元'),
          col('basis', '计算依据', {
            render: (r) =>
              r.estimate
                ? r.estimate.days + ' 天 · ' + r.estimate.rate + '%' + (r.estimate.unit === 'monthly' ? '/月' : '/年')
                : '缺到期日',
          }),
          col('estimate', '建议 / 元', {
            num: true,
            render: (r) => (r.estimate ? yuan(r.estimate.amount) : '—'),
          }),
          col('confirmed', '已确认 / 元', {
            num: true,
            render: (r) => (r.interest_id ? yuan(r.confirmed) : '—'),
          }),
          col('ops', '', {
            render: (r) =>
              perms.edit && !r.interest_id ? <button onClick={() => setRow(r)}>确认</button> : null,
          }),
        ]}
      />
      {row && (
        <FormDialog
          title="确认利息"
          intro={row.party_name + ' · ' + period}
          fields={[
            { name: 'amount', label: '金额 / 元', type: 'money', required: true, hint: '可以改；0 表示免除' },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ amount: row.estimate?.amount ?? 0 }}
          close={() => setRow(null)}
          submit={(v) =>
            finSend('POST', '/interest/confirm', {
              period,
              obligationId: row.id,
              version: row.version,
              amount: v.amount,
              reason: v.reason,
            })
          }
        />
      )}
    </>
  );
}

export default function PartiesPage() {
  const [tab, setTab] = useTab('items');
  const [kind, setKind] = useState<Kind>('receivable');
  const usesKind = !['plan', 'soon', 'deposits'].includes(tab);
  return (
    <div className="fin-page">
      <PageHeading
        title="应收应付"
        actions={
          usesKind ? (
            <div className="record-view-tabs" aria-label="应收或应付">
              <button
                className={kind === 'receivable' ? 'selected' : ''}
                onClick={() => setKind('receivable')}
              >
                应收（客户）
              </button>
              <button
                className={kind === 'payable' ? 'selected' : ''}
                onClick={() => setKind('payable')}
              >
                应付（供应商）
              </button>
            </div>
          ) : undefined
        }
      />
      <Tabs label="应收应付分类" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'items' && <ObligationsTab kind={kind} />}
      {tab === 'held' && <HeldTab kind={kind} />}
      {tab === 'plan' && <PlanTab />}
      {tab === 'soon' && <SoonTab />}
      {tab === 'discount' && <DiscountTab kind={kind} />}
      {tab === 'aging' && <AgingTab kind={kind} />}
      {tab === 'statement' && <StatementTab kind={kind} />}
      {tab === 'terms' && <TermsTab kind={kind} />}
      {tab === 'deposits' && <DepositsTab />}
      {tab === 'interest' && <InterestTab kind={kind} />}
    </div>
  );
}
