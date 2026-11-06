import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Download, X } from 'lucide-react';
import { managementRequest, useAuthState } from '../session';
import ManagementDialog from '../ManagementDialog';
import Combobox from '../ui/Combobox';
import {
  EmptyState,
  Pagination,
  TableRegion,
  useResettingPage,
} from '../ui/ListLayout';
import { financeReportTemplates } from '../../shared/finance-report-templates';
import { today } from '../../shared/domain';
import { centsText, toCents, yuan } from './money';
import './finance.css';

export { yuan, toCents, centsText, percentOf } from './money';

/* ---------- 请求 ---------- */
const qs = (query?: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {}))
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const text = params.toString();
  return text ? '?' + text : '';
};
export const finGet = <T = any,>(path: string, query?: Record<string, unknown>) =>
  managementRequest<T>('/finance' + path + qs(query));
export function finChanged() {
  window.dispatchEvent(new Event('finance-changed'));
}
export async function finSend<T = any>(method: 'POST' | 'PUT', path: string, body: object = {}) {
  const result = await managementRequest<T>(
    '/finance' + path,
    { requestId: crypto.randomUUID(), ...body },
    method,
  );
  finChanged();
  return result;
}
export async function finUpload(path: string, query: Record<string, unknown>, file: File) {
  const { csrf } = await fetch('/api/auth/state').then((r) => r.json());
  const r = await fetch(
    '/api/finance' + path + qs({ requestId: crypto.randomUUID(), ...query }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-ERP-Auth-Token': csrf },
      body: file,
    },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || file.name + ' 上传失败');
  finChanged();
  return data;
}
export function useFin<T = any>(path: string | null, query?: Record<string, unknown>) {
  const key = path === null ? null : path + qs(query);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string }>({
    key: null,
    data: null,
    error: '',
  });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    window.addEventListener('finance-changed', reload);
    return () => window.removeEventListener('finance-changed', reload);
  }, [reload]);
  useEffect(() => {
    if (key === null) return;
    let active = true;
    managementRequest<T>('/finance' + key)
      .then((data) => active && setState({ key, data, error: '' }))
      .catch((e) => active && setState((s) => ({ key, data: s.data, error: e.message })));
    return () => {
      active = false;
    };
  }, [key, revision]);
  return { data: state.data, error: state.error, loading: state.key !== key, reload };
}
/** 打开财务页面时补扫一次业务单据，让台账和待补清单都是最新的。 */
export async function syncEvents() {
  for (let i = 0; i < 20; i++) {
    const r = await managementRequest<any>('/finance/events/sync', {
      requestId: crypto.randomUUID(),
    });
    if (!r.remaining) return;
  }
}

/* ---------- 权限和共用状态 ---------- */
export function useFinPerms() {
  const auth = useAuthState();
  const has = (p: string) => !!auth?.actor?.permissions.includes('finance:' + p);
  return {
    edit: has('edit'),
    approve: has('approve'),
    cash: has('cash'),
    close: has('close'),
    isSuper: auth?.actor?.role === 'super_admin',
    actorId: auth?.actor?.id,
  };
}
const PERIOD_KEY = 'erp-finance-period';
export function usePeriod() {
  const [period, set] = useState(
    () => sessionStorage.getItem(PERIOD_KEY) || today().slice(0, 7),
  );
  return [
    period,
    (v: string) => {
      if (!v) return;
      sessionStorage.setItem(PERIOD_KEY, v);
      set(v);
    },
  ] as const;
}
export function PeriodInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="fin-period">
      <span>月份</span>
      <input type="month" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
/** 页签写进地址，刷新或从别处跳转都能回到同一页签。 */
export function useTab(first: string) {
  const read = () =>
    new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || first;
  const [tab, set] = useState(read);
  // 必须只注册一次：App 处理同一事件时会同步重渲染，每次渲染都重新注册的话，
  // 这个监听会在派发途中被移除，页签就跟不上地址了。
  useEffect(() => {
    const listener = () =>
      set(new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || first);
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, [first]);
  return [
    tab,
    (next: string) => {
      const [base, raw] = location.hash.split('?');
      const params = new URLSearchParams(raw || '');
      params.set('tab', next);
      history.replaceState(null, '', base + '?' + params);
      set(next);
    },
  ] as const;
}
export function Tabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly (readonly [string, string])[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="record-view-tabs fin-tabs" aria-label={label}>
      {tabs.map(([key, text]) => (
        <button
          key={key}
          className={value === key ? 'selected' : ''}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
/** 全新安装时财务还没启用，记账和报表类页面先给这个提示，不要直接报错。 */
export function useFinanceEnabled() {
  const { data } = useFin('/settings');
  return data ? !!data.startPeriod : true;
}
export function NeedEnable({ what }: { what: string }) {
  return (
    <div className="fin-banner" data-tone="info">
      <span className="fin-grow">财务还没启用，启用后才能使用{what}。理论和实际盈亏不用启用也能看。</span>
      <a href="#finance-settings">去财务设置</a>
    </div>
  );
}
export function ErrorLine({ text, close }: { text: string; close?: () => void }) {
  if (!text) return null;
  return (
    <div className="error" role="alert">
      {text}
      {close && (
        <button aria-label="关闭提示" onClick={close}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
export function ExportLink({
  path,
  query,
  label = '导出',
}: {
  path: string;
  query?: Record<string, unknown>;
  label?: string;
}) {
  return (
    <a className="button fin-export" href={'/api/finance' + path + qs(query)} download>
      <Download size={14} aria-hidden="true" />
      {label}
    </a>
  );
}

/* ---------- 状态 ---------- */
const statusNames: Record<string, [string, string]> = {
  draft: ['草稿', 'muted'],
  pending: ['待审核', 'warning'],
  approved: ['已审核', 'info'],
  posted: ['已记账', 'success'],
  void: ['已作废', 'muted'],
  confirmed: ['已确认', 'success'],
  cancelled: ['已撤销', 'muted'],
  open: ['未结账', 'info'],
  closed: ['已结账', 'success'],
  info_pending: ['待补资料', 'warning'],
  ready: ['待制单', 'info'],
  difference: ['有差异', 'warning'],
  source_deleted: ['来源已删', 'warning'],
  cost_pending: ['待算成本', 'muted'],
  waiting_invoice: ['等发票', 'muted'],
  awaiting_allocation_reversal: ['待撤销核销', 'warning'],
  generated: ['已制单', 'success'],
  before_opening: ['启用前', 'muted'],
  corrected: ['已更正', 'muted'],
  superseded: ['已替代', 'muted'],
  no_amount: ['无金额', 'muted'],
  acknowledged: ['已核对', 'muted'],
  resolved: ['已处理', 'muted'],
  submitted: ['待审批', 'warning'],
  rejected: ['已退回', 'muted'],
  paid: ['已付款', 'success'],
  in_use: ['在用', 'success'],
  active: ['有效', 'success'],
  disposed: ['已处置', 'muted'],
  sent: ['已发送', 'info'],
  known: ['已明确', 'success'],
};
export function Status({ value }: { value: unknown }) {
  const [text, tone] = statusNames[String(value)] || [String(value ?? '—'), 'muted'];
  return (
    <span className="business-status" data-tone={tone}>
      {text}
    </span>
  );
}
export const metricNames: Record<string, string> = {
  theoreticalIncome: '送货',
  theoreticalExpense: '到货',
  actualIncome: '实收',
  actualExpense: '实付',
  discountIncome: '收到优惠',
  discountExpense: '给出优惠',
  interestIncome: '利息收入',
  interestExpense: '利息支出',
  depositIncome: '保证金收入',
  depositExpense: '保证金支出',
  ordered: '接单',
};
/** 收付款单和手工凭证没有业务单号，只有内部编号，要说明是什么。 */
export const documentName = (row: any) => {
  if (!/^\d+$/.test(String(row.number ?? ''))) return row.number || '—';
  if (row.detail?.voucherId) return '凭证 ' + row.number;
  if (row.detail?.cashId) return '收付款单 ' + row.number;
  return row.number;
};
export const sourceMonthName = (v: unknown) =>
  v === 'advance' ? '预收预付' : v === 'unallocated' ? '未核销' : String(v ?? '—');

/* ---------- 表格 ---------- */
const cellText = (v: unknown): ReactNode =>
  v === null || v === undefined || v === ''
    ? '—'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : (v as ReactNode);
export type Col = {
  key: string;
  label: string;
  /** 分转元，右对齐 */
  money?: boolean;
  num?: boolean;
  wrap?: boolean;
  render?: (row: any) => ReactNode;
};
export const col = (key: string, label: string, extra: Partial<Col> = {}): Col => ({
  key,
  label,
  ...extra,
});
export const mon = (key: string, label: string): Col => ({ key, label, money: true });
export function FinTable({
  cols,
  rows,
  rowKey = (r) => r.id,
  onRow,
  selected,
  empty,
  label = '财务记录表格',
}: {
  cols: Col[];
  rows: any[];
  rowKey?: (row: any, index: number) => string | number;
  onRow?: (row: any) => void;
  selected?: string | number | null;
  empty?: string;
  label?: string;
}) {
  return (
    <TableRegion label={label}>
      <table className="fin-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={c.money || c.num ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const k = rowKey(row, i);
            return (
              <tr
                key={k}
                className={(onRow ? 'record-row' : '') + (selected === k ? ' selected' : '')}
                aria-selected={onRow ? selected === k : undefined}
                tabIndex={onRow ? 0 : undefined}
                onClick={(e) => {
                  if (onRow && !(e.target as HTMLElement).closest('a,button,input,select,label'))
                    onRow(row);
                }}
                onKeyDown={(e) => {
                  if (onRow && e.key === 'Enter' && e.target === e.currentTarget) onRow(row);
                }}
              >
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={
                      c.money || c.num ? 'num' : c.wrap ? 'cell-wrap' : undefined
                    }
                  >
                    {c.render ? c.render(row) : c.money ? yuan(row[c.key]) : cellText(row[c.key])}
                  </td>
                ))}
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={cols.length}>
                <EmptyState title={empty || '这里还没有记录'} description="" />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </TableRegion>
  );
}
/** 带翻页的列表：组件自己取数，条件变了自动回第一页。 */
export function FinList({
  path,
  query,
  cols,
  rowKey,
  onRow,
  selected,
  empty,
  label,
  onData,
  pageSize = 50,
}: {
  path: string;
  query?: Record<string, unknown>;
  cols: Col[];
  rowKey?: (row: any, index: number) => string | number;
  onRow?: (row: any) => void;
  selected?: string | number | null;
  empty?: string;
  label?: string;
  onData?: (data: any) => void;
  pageSize?: number;
}) {
  const [page, setPage] = useResettingPage(path + JSON.stringify(query || {}));
  const { data, error } = useFin(path, { ...query, page, pageSize });
  useEffect(() => {
    if (data) onData?.(data);
    // onData 只是回传，不作为重新取数的依据
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  return (
    <section className="panel business-records">
      <ErrorLine text={error} />
      <FinTable
        cols={cols}
        rows={data?.rows || []}
        rowKey={rowKey}
        onRow={onRow}
        selected={selected}
        empty={data ? empty : '正在读取…'}
        label={label}
      />
      {data && data.filteredRecords > (data.pageSize || pageSize) && (
        <Pagination
          page={data.page || page}
          total={data.filteredRecords}
          pageSize={data.pageSize || pageSize}
          onChange={setPage}
        />
      )}
    </section>
  );
}
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="record-detail-grid">
      {items
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/* ---------- 下拉选项 ---------- */
export function useParties(kind: 'customer' | 'supplier' | null) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (!kind) return;
    let active = true;
    managementRequest<any>(kind === 'customer' ? '/customers' : '/suppliers')
      .then((r) => active && setRows(Array.isArray(r) ? r : r.rows || r.items || []))
      .catch(() => active && setRows([]));
    return () => {
      active = false;
    };
  }, [kind]);
  return rows.map((p) => ({ value: String(p.id), label: p.name }));
}
export function PartyPicker({
  kind,
  value,
  onChange,
  allowAll,
}: {
  kind: 'customer' | 'supplier';
  value: string;
  onChange: (v: string) => void;
  allowAll?: boolean;
}) {
  const options = useParties(kind);
  return (
    <div className="fin-party-picker">
      <Combobox
        ariaLabel={kind === 'customer' ? '选择客户' : '选择供应商'}
        placeholder={(allowAll ? '全部' : '选择') + (kind === 'customer' ? '客户' : '供应商')}
        value={value}
        options={options}
        onChange={onChange}
      />
      {allowAll && value && (
        <button className="icon-button" aria-label="清除单位筛选" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
export const cashFlowItems: string[] = Object.values(
  financeReportTemplates.cashflow.groups as Record<string, readonly string[]>,
).flat();
function AccountInput({
  value,
  onChange,
  label,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
}) {
  const { data } = useFin<any[]>('/accounts');
  const options = (data || [])
    .filter((a) => a.leaf && a.enabled)
    .map((a) => ({ value: String(a.code), label: a.code + ' ' + a.name, keywords: a.name }));
  return (
    <Combobox
      ariaLabel={label}
      value={value}
      required={required}
      options={options}
      onChange={onChange}
    />
  );
}
export function useCashAccounts() {
  const { data } = useFin<any>('/cash/accounts', { pageSize: 200 });
  return ((data?.rows || []) as any[]).filter((a) => a.enabled);
}

/* ---------- 通用表单窗口 ---------- */
export type Field = {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'money'
    | 'date'
    | 'month'
    | 'int'
    | 'select'
    | 'textarea'
    | 'party'
    | 'account'
    | 'cash-account'
    | 'cash-flow'
    | 'obligation'
    | 'check';
  options?: readonly (readonly [string, string])[];
  required?: boolean;
  wide?: boolean;
  hint?: string;
  partyKind?: 'customer' | 'supplier' | ((values: Record<string, any>) => 'customer' | 'supplier');
  /** type 为 obligation 时，从这个单位未结清的往来单里选。 */
  obligation?: { kind: 'receivable' | 'payable'; partyId: unknown };
  show?: (values: Record<string, any>) => boolean;
};
function CashAccountSelect({
  value,
  onChange,
  label,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
}) {
  const accounts = useCashAccounts();
  return (
    <select aria-label={label} required={required} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">请选择</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.last_four ? ' · ' + a.last_four : ''}
        </option>
      ))}
    </select>
  );
}
function PartyField({
  kind,
  value,
  onChange,
  label,
  required,
}: {
  kind: 'customer' | 'supplier';
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
}) {
  const options = useParties(kind);
  return (
    <Combobox ariaLabel={label} value={value} required={required} options={options} onChange={onChange} />
  );
}
/** 从未结清的往来单里选，不用记内部编号。 */
function ObligationSelect({
  kind,
  partyId,
  value,
  onChange,
  label,
  required,
}: {
  kind: string;
  partyId: unknown;
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
}) {
  const { data } = useFin('/obligations', { kind, partyId: String(partyId), pageSize: 200 });
  const rows = ((data?.rows || []) as any[]).filter((o) => Number(o.balance) > 0);
  return (
    <select aria-label={label} required={required} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{data && !rows.length ? '这个单位没有未结清的单子' : '请选择'}</option>
      {rows.map((o) => (
        <option key={o.id} value={o.id}>
          {(o.source_number || o.description) + ' · ' + o.date + ' · 未结 ' + yuan(o.balance) + ' 元'}
        </option>
      ))}
    </select>
  );
}
export function FormDialog({
  title,
  intro,
  fields,
  initial = {},
  submitLabel = '保存',
  submit,
  close,
  danger,
  children,
}: {
  title: string;
  intro?: ReactNode;
  fields: Field[];
  initial?: Record<string, any>;
  submitLabel?: string;
  /** 收到已转换的值：金额为分，整数和单位 ID 为数字，空值已去掉。 */
  submit: (values: Record<string, any>) => Promise<unknown>;
  close: () => void;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, any>>(() => {
    const out: Record<string, any> = {};
    for (const f of fields) {
      const v = initial[f.name];
      out[f.name] =
        f.type === 'check' ? !!v : f.type === 'money' ? centsText(v) : (v ?? '') === '' ? '' : String(v);
    }
    return { ...initial, ...out };
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const set = (name: string, v: unknown) => setValues((s) => ({ ...s, [name]: v }));
  const convert = () => {
    const out: Record<string, any> = {};
    for (const f of fields) {
      if (f.show && !f.show(values)) continue;
      const v = values[f.name];
      if (f.type === 'check') {
        out[f.name] = !!v;
        continue;
      }
      if (v === '' || v === null || v === undefined) continue;
      if (f.type === 'money') out[f.name] = toCents(String(v));
      else if (
        f.type === 'int' ||
        f.type === 'cash-account' ||
        f.type === 'party' ||
        f.type === 'obligation'
      )
        out[f.name] = Number(v);
      else out[f.name] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  };
  return (
    <ManagementDialog title={title} busy={busy} close={close} danger={danger}>
      <form
        className="fin-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await submit(convert());
            close();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {intro && <p className="form-intro">{intro}</p>}
        <div className="form-grid">
          {fields
            .filter((f) => !f.show || f.show(values))
            .map((f) => {
              const value = values[f.name] ?? '';
              const control = (() => {
                switch (f.type) {
                  case 'select':
                    return (
                      <select
                        required={f.required}
                        value={value}
                        onChange={(e) => set(f.name, e.target.value)}
                      >
                        {!f.required && <option value="">未选择</option>}
                        {f.options?.map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    );
                  case 'textarea':
                    return (
                      <textarea
                        required={f.required}
                        value={value}
                        rows={3}
                        onChange={(e) => set(f.name, e.target.value)}
                      />
                    );
                  case 'party':
                    return (
                      <PartyField
                        label={f.label}
                        required={f.required}
                        kind={
                          typeof f.partyKind === 'function'
                            ? f.partyKind(values)
                            : f.partyKind || 'customer'
                        }
                        value={String(value)}
                        onChange={(v) => set(f.name, v)}
                      />
                    );
                  case 'account':
                    return (
                      <AccountInput
                        label={f.label}
                        required={f.required}
                        value={String(value)}
                        onChange={(v) => set(f.name, v)}
                      />
                    );
                  case 'cash-account':
                    return (
                      <CashAccountSelect
                        label={f.label}
                        required={f.required}
                        value={String(value)}
                        onChange={(v) => set(f.name, v)}
                      />
                    );
                  case 'obligation':
                    return (
                      <ObligationSelect
                        label={f.label}
                        required={f.required}
                        kind={f.obligation!.kind}
                        partyId={f.obligation!.partyId}
                        value={String(value)}
                        onChange={(v) => set(f.name, v)}
                      />
                    );
                  case 'cash-flow':
                    return (
                      <select
                        required={f.required}
                        value={value}
                        onChange={(e) => set(f.name, e.target.value)}
                      >
                        <option value="">请选择</option>
                        {cashFlowItems.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    );
                  case 'check':
                    return (
                      <input
                        type="checkbox"
                        checked={!!value}
                        onChange={(e) => set(f.name, e.target.checked)}
                      />
                    );
                  default:
                    return (
                      <input
                        type={
                          f.type === 'date'
                            ? 'date'
                            : f.type === 'month'
                              ? 'month'
                              : f.type === 'int'
                                ? 'number'
                                : 'text'
                        }
                        inputMode={f.type === 'money' ? 'decimal' : undefined}
                        required={f.required}
                        value={value}
                        onChange={(e) => set(f.name, e.target.value)}
                      />
                    );
                }
              })();
              return (
                <label
                  key={f.name}
                  className={
                    'field' +
                    (f.wide || f.type === 'textarea' ? ' wide' : '') +
                    (f.type === 'check' ? ' fin-check' : '')
                  }
                >
                  <span>
                    {f.label}
                    {f.required ? ' *' : ''}
                  </span>
                  {control}
                  {f.hint && <small className="fin-hint">{f.hint}</small>}
                </label>
              );
            })}
        </div>
        {children}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className={danger ? 'danger' : 'primary'} disabled={busy}>
            {busy ? '处理中…' : submitLabel}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
/** 按钮点一下就执行、失败时给出原因的小动作。 */
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
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
  return { busy, error, run, clear: () => setError('') };
}
export const taxModes = [
  ['含税', '含税'],
  ['未税', '未税'],
] as const;
export const todayText = () => today();
