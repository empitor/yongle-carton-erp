import { useState } from 'react';
import { PageHeading } from '../ui/ListLayout';
import {
  ErrorLine,
  Facts,
  FinTable,
  FormDialog,
  Status,
  Tabs,
  col,
  finSend,
  toCents,
  useAction,
  useFin,
  useFinPerms,
  useTab,
} from './kit';
import { today } from '../../shared/domain';

const tabs = [
  ['basic', '基本设置'],
  ['accounts', '科目'],
  ['periods', '会计期间'],
] as const;
const rateFields = [
  ['smallVat', '小规模征收率 %'],
  ['urban', '城建税率 %'],
  ['education', '教育费附加率 %'],
  ['localEducation', '地方教育附加率 %'],
  ['income', '所得税率 %'],
] as const;
/** 税率以基点存：填 “3” 或 “1.5”，转成 300、150。空着就是未设置，不猜默认值。 */
const toBp = (text: string | undefined) => {
  if (text === undefined || text.trim() === '') return null;
  return toCents(text);
};
const fromBp = (bp: number | null | undefined) =>
  bp === null || bp === undefined ? '' : String(bp / 100);

function EnablePanel({ settings }: { settings: any }) {
  const [rows, setRows] = useState<
    { accountCode: string; debit: string; credit: string; yearDebit: string; yearCredit: string }[]
  >([]);
  const accounts = useFin<any[]>('/accounts');
  const [open, setOpen] = useState(false);
  const options = (accounts.data || []).filter((a) => a.leaf);
  const parse = (v: string) => (v.trim() ? toCents(v) : 0);
  const sum = (key: 'debit' | 'credit') =>
    rows.reduce((n, r) => {
      try {
        return n + parse(r[key]);
      } catch {
        return n;
      }
    }, 0);
  return (
    <section className="panel fin-card business-records">
      <h2>启用财务</h2>
      <p className="fin-note">
        选一个开始记账的月份，填上期初余额。启用后期初和纳税人身份锁定。启用月之前的单据不进账，也不进台账。
        期初可以先空着，只想看理论和实际盈亏时不用启用。
      </p>
      <div className="fin-actions">
        <button className="primary" onClick={() => setOpen(true)}>
          开始启用
        </button>
      </div>
      {open && (
        <FormDialog
          title="启用财务"
          intro="期初借贷必须相等。启用后不能再改，填之前核对一下。"
          submitLabel="确认启用"
          fields={[
            { name: 'period', label: '启用月份', type: 'month', required: true },
            {
              name: 'taxpayer',
              label: '纳税人身份',
              type: 'select',
              required: true,
              options: [
                ['general', '一般纳税人'],
                ['small', '小规模纳税人'],
              ],
            },
          ]}
          initial={{ period: today().slice(0, 7) }}
          close={() => setOpen(false)}
          submit={(v) =>
            finSend('POST', '/opening/enable', {
              ...v,
              version: settings.version,
              rows: rows.map((r) => ({
                accountCode: r.accountCode,
                debit: parse(r.debit),
                credit: parse(r.credit),
                yearDebit: parse(r.yearDebit),
                yearCredit: parse(r.yearCredit),
              })),
            })
          }
        >
          <div className="fin-subform fin-wide">
            <h3>期初余额（按元填，可不填）</h3>
            <div className="table-wrap">
              <table className="fin-lines">
                <thead>
                  <tr>
                    <th>科目</th>
                    <th>期初借方</th>
                    <th>期初贷方</th>
                    <th>本年累计借方</th>
                    <th>本年累计贷方</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const update = (patch: object) =>
                      setRows((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                      <tr key={i}>
                        <td>
                          <select
                            aria-label="期初科目"
                            value={r.accountCode}
                            onChange={(e) => update({ accountCode: e.target.value })}
                          >
                            <option value="">请选择</option>
                            {options.map((a) => (
                              <option key={a.code} value={a.code}>
                                {a.code} {a.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        {(['debit', 'credit', 'yearDebit', 'yearCredit'] as const).map((k) => (
                          <td key={k}>
                            <input
                              aria-label={k}
                              inputMode="decimal"
                              value={r[k]}
                              onChange={(e) => update({ [k]: e.target.value })}
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            type="button"
                            onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="fin-toolbar">
              <button
                type="button"
                onClick={() =>
                  setRows((all) => [
                    ...all,
                    { accountCode: '', debit: '', credit: '', yearDebit: '', yearCredit: '' },
                  ])
                }
              >
                加一行
              </button>
              <span className="fin-grow" />
              <span className={sum('debit') === sum('credit') ? 'fin-note' : 'fin-note fin-negative'}>
                借方 {(sum('debit') / 100).toFixed(2)} · 贷方 {(sum('credit') / 100).toFixed(2)}
              </span>
            </div>
          </div>
        </FormDialog>
      )}
    </section>
  );
}

function BasicTab() {
  const perms = useFinPerms();
  const { data, error } = useFin('/settings');
  const [editing, setEditing] = useState(false);
  if (!data) return <ErrorLine text={error} />;
  const rates = data.taxRates || {};
  return (
    <>
      <ErrorLine text={error} />
      {!data.startPeriod && perms.close && <EnablePanel settings={data} />}
      <section className="panel fin-card business-records">
        <h2>当前设置</h2>
        <Facts
          items={[
            ['启用月份', data.startPeriod || '未启用'],
            ['纳税人', data.taxpayer === 'small' ? '小规模' : data.taxpayer === 'general' ? '一般纳税人' : '未设置'],
            ['制单和审核分开', data.requireSeparateApprover ? '是' : '否'],
            ['收入确认', data.revenueRecognition === 'invoice' ? '开票时' : '送货时'],
            ['成本分摊', data.costAllocation === 'material' ? '按材料' : '按产量'],
            ['账龄分段（天）', (data.agingDays || []).join('、')],
            ...rateFields.map(
              ([k, label]) => [label, rates[k] === null || rates[k] === undefined ? '未设置' : rates[k] / 100 + '%'] as [string, string],
            ),
          ]}
        />
        {perms.close && (
          <div className="fin-actions fin-subform">
            <button onClick={() => setEditing(true)}>修改</button>
          </div>
        )}
      </section>
      {editing && (
        <FormDialog
          title="修改财务设置"
          intro="税率都由你填，系统没有默认值。结账计提税费时缺哪个会提示。"
          fields={[
            {
              name: 'revenueRecognition',
              label: '收入确认',
              type: 'select',
              required: true,
              options: [
                ['delivery', '送货时'],
                ['invoice', '开票时'],
              ],
            },
            {
              name: 'costAllocation',
              label: '成本分摊',
              type: 'select',
              required: true,
              options: [
                ['output', '按产量'],
                ['material', '按材料'],
              ],
            },
            ...(perms.isSuper
              ? [{ name: 'requireSeparateApprover', label: '制单和审核必须不同人', type: 'check' as const }]
              : []),
            { name: 'agingDays', label: '账龄分段（5 个递增天数，顿号分开）', wide: true },
            ...rateFields.map(([name, label]) => ({ name, label })),
          ]}
          initial={{
            revenueRecognition: data.revenueRecognition,
            costAllocation: data.costAllocation,
            requireSeparateApprover: data.requireSeparateApprover,
            agingDays: (data.agingDays || []).join('、'),
            ...Object.fromEntries(rateFields.map(([k]) => [k, fromBp(rates[k])])),
          }}
          close={() => setEditing(false)}
          submit={(v) =>
            finSend('PUT', '/settings', {
              version: data.version,
              revenueRecognition: v.revenueRecognition,
              costAllocation: v.costAllocation,
              ...(perms.isSuper ? { requireSeparateApprover: v.requireSeparateApprover } : {}),
              agingDays: String(v.agingDays || '')
                .split(/[、,，\s]+/)
                .filter(Boolean)
                .map(Number),
              taxRates: Object.fromEntries(rateFields.map(([k]) => [k, toBp(v[k])])),
            })
          }
        />
      )}
    </>
  );
}

const categories = [
  ['asset', '资产'],
  ['liability', '负债'],
  ['equity', '所有者权益'],
  ['cost', '成本'],
  ['profit', '损益'],
] as const;
function AccountsTab() {
  const perms = useFinPerms();
  const { data, error } = useFin<any[]>('/accounts');
  const [q, setQ] = useState('');
  const [row, setRow] = useState<any>(null);
  const action = useAction();
  const rows = (data || []).filter(
    (a) => !q.trim() || String(a.code).startsWith(q.trim()) || String(a.name).includes(q.trim()),
  );
  return (
    <>
      <div className="fin-toolbar">
        <input
          type="text"
          aria-label="搜索科目"
          placeholder="搜索编码或名称"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="fin-note">已使用的科目不能改类别和方向。</span>
        <span className="fin-grow" />
        {perms.close && (
          <button className="primary" onClick={() => setRow({})}>
            新增科目
          </button>
        )}
      </div>
      <ErrorLine text={error} />
      <ErrorLine text={action.error} close={action.clear} />
      <section className="panel business-records">
        <FinTable
          label="科目表"
          rows={rows}
          rowKey={(a) => a.code}
          onRow={perms.close ? setRow : undefined}
          cols={[
            col('code', '编码'),
            col('name', '名称'),
            col('category', '类别', {
              render: (a) => categories.find(([k]) => k === a.category)?.[1] ?? a.category,
            }),
            col('direction', '方向', { render: (a) => (a.direction === 'debit' ? '借' : '贷') }),
            col('cash_kind', '资金', {
              render: (a) => (a.cash_kind === 'cash' ? '现金' : a.cash_kind === 'bank' ? '银行' : '—'),
            }),
            col('auxiliary', '辅助', { render: (a) => a.auxiliary || '—' }),
            col('enabled', '启用', { render: (a) => (a.enabled ? '是' : '否') }),
          ]}
        />
      </section>
      {row && (
        <FormDialog
          title={row.code ? '修改科目 ' + row.code : '新增科目'}
          fields={[
            { name: 'code', label: '编码', required: true, hint: '4 位起，每级加 2 位' },
            { name: 'name', label: '名称', required: true },
            { name: 'category', label: '类别', type: 'select', required: true, options: categories },
            {
              name: 'direction',
              label: '方向',
              type: 'select',
              required: true,
              options: [
                ['debit', '借'],
                ['credit', '贷'],
              ],
            },
            {
              name: 'cashKind',
              label: '资金类型',
              type: 'select',
              options: [
                ['cash', '现金'],
                ['bank', '银行'],
              ],
            },
            {
              name: 'auxiliary',
              label: '辅助核算',
              type: 'select',
              options: [
                ['customer', '客户'],
                ['supplier', '供应商'],
                ['department', '部门'],
                ['employee', '员工'],
                ['project', '项目'],
              ],
            },
            { name: 'enabled', label: '启用', type: 'check' },
          ]}
          initial={
            row.code
              ? {
                  code: row.code,
                  name: row.name,
                  category: row.category,
                  direction: row.direction,
                  cashKind: row.cash_kind,
                  auxiliary: row.auxiliary,
                  enabled: !!row.enabled,
                }
              : { category: 'profit', direction: 'debit', enabled: true }
          }
          close={() => setRow(null)}
          submit={(v) =>
            finSend('PUT', '/accounts', {
              account: {
                code: v.code,
                name: v.name,
                category: v.category,
                direction: v.direction,
                cashKind: v.cashKind ?? null,
                auxiliary: v.auxiliary ?? null,
                enabled: v.enabled,
              },
              ...(row.code ? { version: row.version } : {}),
            })
          }
        />
      )}
    </>
  );
}

function PeriodsTab() {
  const { data, error } = useFin<any>('/periods');
  const rows = Array.isArray(data) ? data : data?.rows || [];
  return (
    <>
      <ErrorLine text={error} />
      <section className="panel business-records">
        <FinTable
          label="会计期间"
          rows={rows}
          rowKey={(r) => r.period}
          empty="还没有期间，启用后自动产生"
          cols={[
            col('period', '月份'),
            col('status', '状态', { render: (r) => <Status value={r.status} /> }),
          ]}
        />
      </section>
      <p className="fin-note">结账、反结账在“报表结账”页。</p>
    </>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useTab('basic');
  return (
    <div className="fin-page">
      <PageHeading title="财务设置" />
      <Tabs label="财务设置分类" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'basic' && <BasicTab />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'periods' && <PeriodsTab />}
    </div>
  );
}
