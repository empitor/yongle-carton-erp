import { useEffect, useState } from 'react';
import ManagementDialog from '../ManagementDialog';
import DetailPanel from '../ui/DetailPanel';
import { PageHeading } from '../ui/ListLayout';
import Combobox from '../ui/Combobox';
import {
  ErrorLine,
  ExportLink,
  Facts,
  FinList,
  FinTable,
  FormDialog,
  PeriodInput,
  Status,
  Tabs,
  cashFlowItems,
  col,
  finSend,
  mon,
  NeedEnable,
  useFinanceEnabled,
  syncEvents,
  toCents,
  todayText,
  useAction,
  useFin,
  useFinPerms,
  usePeriod,
  useTab,
  yuan,
  useParties,
} from './kit';

const tabs = [
  ['vouchers', '凭证'],
  ['events', '财务事件'],
  ['books', '账簿'],
  ['templates', '记账模板'],
  ['audit', '修改记录'],
] as const;
const voucherStates = [
  ['', '全部'],
  ['draft', '草稿'],
  ['pending', '待审核'],
  ['approved', '已审核'],
  ['posted', '已记账'],
  ['void', '已作废'],
] as const;

type Line = {
  accountCode: string;
  description: string;
  debit: string;
  credit: string;
  cashFlow: string;
  auxId: string;
  auxName: string;
};
const auxLabels: Record<string, string> = {
  customer: '客户',
  supplier: '供应商',
  department: '部门',
  employee: '员工',
  project: '项目',
};
/** 科目要求辅助核算时才要填。客户和供应商从档案选，其他照填名称。 */
function AuxiliaryCell({
  kind,
  line,
  label,
  onChange,
}: {
  kind: string;
  line: Line;
  label: string;
  onChange: (patch: Partial<Line>) => void;
}) {
  const party = kind === 'customer' || kind === 'supplier' ? kind : null;
  const options = useParties(party);
  if (party)
    return (
      <Combobox
        ariaLabel={label}
        placeholder={'选择' + auxLabels[kind]}
        value={line.auxId}
        options={options}
        onChange={(v) =>
          onChange({ auxId: v, auxName: options.find((o) => o.value === v)?.label || '' })
        }
      />
    );
  return (
    <input
      aria-label={label}
      placeholder={auxLabels[kind]}
      value={line.auxName}
      onChange={(e) => onChange({ auxId: e.target.value.trim(), auxName: e.target.value })}
    />
  );
};
const blank = (): Line => ({
  accountCode: '',
  description: '',
  debit: '',
  credit: '',
  cashFlow: '',
  auxId: '',
  auxName: '',
});

function VoucherEditor({ voucher, close, saved }: { voucher?: any; close: () => void; saved: (id: number) => void }) {
  const accounts = useFin<any[]>('/accounts');
  const options = (accounts.data || [])
    .filter((a) => a.leaf && a.enabled)
    .map((a) => ({ value: String(a.code), label: a.code + ' ' + a.name, keywords: a.name }));
  const cashCodes = new Set((accounts.data || []).filter((a) => a.cash_kind).map((a) => String(a.code)));
  const auxKinds = new Map(
    (accounts.data || []).filter((a) => a.auxiliary).map((a) => [String(a.code), String(a.auxiliary)]),
  );
  const [date, setDate] = useState(voucher?.header.date || todayText());
  const [description, setDescription] = useState(voucher?.header.description || '');
  const [attachmentCount, setAttachmentCount] = useState(String(voucher?.header.attachment_count ?? 0));
  const [lines, setLines] = useState<Line[]>(
    voucher
      ? voucher.entries.map((e: any) => ({
          accountCode: e.account_code,
          description: e.description,
          debit: e.debit ? yuan(e.debit).replace(/,/g, '') : '',
          credit: e.credit ? yuan(e.credit).replace(/,/g, '') : '',
          cashFlow: e.cash_flow || '',
          auxId: e.auxiliary_id ? String(e.auxiliary_id) : '',
          auxName: e.auxiliary_name || '',
        }))
      : [blank(), blank()],
  );
  const action = useAction();
  const update = (i: number, patch: Partial<Line>) =>
    setLines((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const total = (key: 'debit' | 'credit') =>
    lines.reduce((n, l) => {
      try {
        return n + (l[key].trim() ? toCents(l[key]) : 0);
      } catch {
        return n;
      }
    }, 0);
  const balanced = total('debit') === total('credit') && total('debit') > 0;
  const submit = () =>
    action.run(async () => {
      const entries = lines.map((l, i) => {
        const kind = auxKinds.get(l.accountCode);
        if (kind && !l.auxName.trim())
          throw new Error('第 ' + (i + 1) + ' 行的科目要填' + auxLabels[kind] + '。');
        return {
          accountCode: l.accountCode,
          description: l.description,
          debit: l.debit.trim() ? toCents(l.debit) : 0,
          credit: l.credit.trim() ? toCents(l.credit) : 0,
          auxiliary: kind ? { kind, id: l.auxId, name: l.auxName.trim() } : null,
          cashFlow: l.cashFlow || null,
        };
      });
      const body = { date, description, attachmentCount: Number(attachmentCount) || 0, entries };
      const result = voucher
        ? await finSend('PUT', '/vouchers/' + voucher.header.id, { ...body, version: voucher.header.version })
        : await finSend('POST', '/vouchers', body);
      saved(result.header.id);
      close();
    });
  return (
    <ManagementDialog title={voucher ? '修改凭证' : '新建凭证'} busy={action.busy} close={close}>
      <div className="fin-form">
        <div className="form-grid">
          <label className="field">
            <span>日期 *</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>附件张数</span>
            <input
              type="number"
              min={0}
              value={attachmentCount}
              onChange={(e) => setAttachmentCount(e.target.value)}
            />
          </label>
          <label className="field wide">
            <span>摘要 *</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <div className="table-wrap">
          <table className="fin-lines fin-voucher-entries">
            <thead>
              <tr>
                <th>科目</th>
                <th>辅助项</th>
                <th>摘要</th>
                <th>借方 / 元</th>
                <th>贷方 / 元</th>
                <th>现金流量</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="fin-acct">
                    <Combobox
                      ariaLabel={'第 ' + (i + 1) + ' 行科目'}
                      value={l.accountCode}
                      options={options}
                      onChange={(v) =>
                        update(
                          i,
                          auxKinds.get(v) === auxKinds.get(l.accountCode)
                            ? { accountCode: v }
                            : { accountCode: v, auxId: '', auxName: '' },
                        )
                      }
                    />
                  </td>
                  <td>
                    {auxKinds.get(l.accountCode) ? (
                      <AuxiliaryCell
                        kind={auxKinds.get(l.accountCode)!}
                        line={l}
                        label={'第 ' + (i + 1) + ' 行辅助项'}
                        onChange={(patch) => update(i, patch)}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行摘要'}
                      value={l.description}
                      onChange={(e) => update(i, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行借方'}
                      inputMode="decimal"
                      value={l.debit}
                      onChange={(e) => update(i, { debit: e.target.value, credit: '' })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行贷方'}
                      inputMode="decimal"
                      value={l.credit}
                      onChange={(e) => update(i, { credit: e.target.value, debit: '' })}
                    />
                  </td>
                  <td>
                    {cashCodes.has(l.accountCode) ? (
                      <select
                        aria-label={'第 ' + (i + 1) + ' 行现金流量'}
                        value={l.cashFlow}
                        onChange={(e) => update(i, { cashFlow: e.target.value })}
                      >
                        <option value="">请选择</option>
                        {cashFlowItems.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {lines.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setLines((all) => all.filter((_, j) => j !== i))}
                      >
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="fin-toolbar">
          <button type="button" onClick={() => setLines((all) => [...all, blank()])}>
            加一行
          </button>
          <span className="fin-grow" />
          <span className={balanced ? 'fin-note' : 'fin-note fin-negative'}>
            借方 {yuan(total('debit'))} · 贷方 {yuan(total('credit'))}
            {balanced ? '' : ' · 借贷不平'}
          </span>
        </div>
        <ErrorLine text={action.error} close={action.clear} />
        <div className="management-dialog-actions">
          <button type="button" onClick={close} disabled={action.busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={action.busy || !balanced || !description.trim() || lines.some((l) => !l.accountCode)}
            onClick={submit}
          >
            保存草稿
          </button>
        </div>
      </div>
    </ManagementDialog>
  );
}

function VoucherPanel({ id, close }: { id: number; close: () => void }) {
  const perms = useFinPerms();
  const { data, error } = useFin('/vouchers/' + id);
  const action = useAction();
  const [dialog, setDialog] = useState<'edit' | 'reverse' | 'void' | null>(null);
  if (error) return <DetailPanel title="凭证" close={close}><ErrorLine text={error} /></DetailPanel>;
  if (!data) return null;
  const h = data.header;
  const linked = !!(h.module_source || h.event_id);
  const go = (step: 'submit' | 'approve' | 'post') =>
    action.run(() => finSend('POST', '/vouchers/' + id + '/' + step, { version: h.version }));
  return (
    <DetailPanel
      title={h.period + ' 第 ' + h.number + ' 号'}
      status={<Status value={h.status} />}
      close={close}
      actions={
        <div className="fin-actions">
          {h.status === 'draft' && perms.edit && (
            <button className="primary" disabled={action.busy} onClick={() => go('submit')}>
              提交审核
            </button>
          )}
          {h.status === 'pending' && perms.approve && (
            <button className="primary" disabled={action.busy} onClick={() => go('approve')}>
              审核
            </button>
          )}
          {h.status === 'approved' && perms.approve && (
            <button className="primary" disabled={action.busy} onClick={() => go('post')}>
              记账
            </button>
          )}
          {h.status === 'draft' && perms.edit && !linked && (
            <button onClick={() => setDialog('edit')}>修改</button>
          )}
          {!['posted', 'void'].includes(h.status) && perms.edit && !h.module_source && (
            <button onClick={() => setDialog('void')}>作废</button>
          )}
          {h.status === 'posted' && !h.reversal_of && perms.edit && !linked && (
            <button onClick={() => setDialog('reverse')}>红字冲销</button>
          )}
        </div>
      }
    >
      <ErrorLine text={action.error} close={action.clear} />
      {h.status === 'posted' && (
        <p className="fin-note">
          已记账的凭证不能改、不能删，错了只能红字冲销。
          {linked && ' 这张来自业务单据，要到来源模块处理。'}
        </p>
      )}
      <Facts
        items={[
          ['日期', h.date],
          ['摘要', h.description],
          ['附件', h.attachment_count + ' 张'],
          ['制单', h.maker_name],
          ['审核', h.approver_name],
          ['记账', h.poster_name],
          ['冲销的是', h.reversal_of ? '凭证 ' + h.reversal_of : null],
          ['来源', data.source?.source_kind ? data.source.source_kind + ' ' + data.source.source_id : data.source?.module],
        ]}
      />
      <h3>分录</h3>
      <FinTable
        label="凭证分录"
        rows={data.entries}
        rowKey={(e) => e.position}
        cols={[
          col('account_code', '科目', { render: (e) => e.account_code + (e.account_name ? ' ' + e.account_name : '') }),
          col('description', '摘要', { wrap: true }),
          col('auxiliary_name', '辅助', { render: (e) => e.auxiliary_name || '—' }),
          mon('debit', '借方'),
          mon('credit', '贷方'),
        ]}
      />
      {dialog === 'edit' && (
        <VoucherEditor voucher={data} close={() => setDialog(null)} saved={() => {}} />
      )}
      {dialog === 'void' && (
        <FormDialog
          title="作废凭证"
          intro="凭证号保留，只把状态改成已作废。"
          danger
          submitLabel="确认作废"
          fields={[]}
          close={() => setDialog(null)}
          submit={() => finSend('POST', '/vouchers/' + id + '/void', { version: h.version })}
        />
      )}
      {dialog === 'reverse' && (
        <FormDialog
          title="红字冲销"
          intro="生成一张金额相反的新凭证，原凭证保留。"
          fields={[
            { name: 'date', label: '冲销日期', type: 'date', required: true },
            { name: 'description', label: '摘要', required: true, wide: true },
          ]}
          initial={{ date: todayText(), description: '冲销：' + h.description }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/vouchers/' + id + '/reverse', { ...v, version: h.version })}
        />
      )}
    </DetailPanel>
  );
}

function VouchersTab() {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<number | null>(() => {
    const v = new URLSearchParams(location.hash.split('?')[1] || '').get('voucher');
    return v ? Number(v) : null;
  });
  const [creating, setCreating] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const action = useAction();
  /** 批量走完“提交→审核→记账”。审核分离开启时，自己制的单会被后端拒绝并显示原因。 */
  const advanceAll = (from: string) =>
    action.run(async () => {
      const step = { draft: 'submit', pending: 'approve', approved: 'post' }[from]!;
      for (const row of rows.filter((r) => r.status === from))
        await finSend('POST', '/vouchers/' + row.id + '/' + step, { version: row.version });
    });
  const counts = (s: string) => rows.filter((r) => r.status === s).length;
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <select aria-label="凭证状态" value={status} onChange={(e) => setStatus(e.target.value)}>
          {voucherStates.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="fin-grow" />
        {perms.edit && counts('draft') > 0 && (
          <button disabled={action.busy} onClick={() => advanceAll('draft')}>
            提交本页 {counts('draft')} 张草稿
          </button>
        )}
        {perms.approve && counts('pending') > 0 && (
          <button disabled={action.busy} onClick={() => advanceAll('pending')}>
            审核本页 {counts('pending')} 张
          </button>
        )}
        {perms.approve && counts('approved') > 0 && (
          <button disabled={action.busy} onClick={() => advanceAll('approved')}>
            记账本页 {counts('approved')} 张
          </button>
        )}
        {perms.edit && (
          <button className="primary" onClick={() => setCreating(true)}>
            新建凭证
          </button>
        )}
      </div>
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        path="/vouchers"
        label="凭证"
        query={{ period, status: status || undefined }}
        onData={(d) => setRows(d.rows)}
        onRow={(r) => setSelected(r.id)}
        selected={selected}
        empty="这个月还没有凭证"
        cols={[
          col('number', '凭证号', { num: true }),
          col('date', '日期'),
          col('description', '摘要', { wrap: true }),
          col('maker_name', '制单'),
          col('status', '状态', { render: (r) => <Status value={r.status} /> }),
        ]}
      />
      {selected && <VoucherPanel id={selected} close={() => setSelected(null)} />}
      {creating && (
        <VoucherEditor close={() => setCreating(false)} saved={(id) => setSelected(id)} />
      )}
    </>
  );
}

const sourceNames: Record<string, string> = {
  delivery: '送货',
  arrival: '到货',
  legacy_arrival: '旧到货',
  production: '完工',
  stock: '盘点',
  arrival_data_edit: '到货统计更正',
};
function EventsTab() {
  const perms = useFinPerms();
  const [status, setStatus] = useState('ready');
  const [row, setRow] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [dialog, setDialog] = useState<'correct' | 'ack' | null>(null);
  const action = useAction();
  useEffect(() => {
    void syncEvents().catch(() => {});
  }, []);
  const generate = (r: any) => finSend('POST', '/events/' + r.id + '/generate', { version: r.version });
  return (
    <>
      <div className="fin-toolbar">
        <select aria-label="事件状态" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部</option>
          <option value="ready">待制单</option>
          <option value="info_pending">待补资料</option>
          <option value="difference">有差异</option>
          <option value="awaiting_allocation_reversal">待撤销核销</option>
          <option value="cost_pending">待算成本</option>
          <option value="waiting_invoice">等发票</option>
          <option value="source_deleted">来源已删</option>
        </select>
        <span className="fin-note">送货、到货确认后自动进来。缺税率的单子已进台账，这里是记账前的处理。</span>
        <span className="fin-grow" />
        {perms.edit && status === 'ready' && rows.length > 0 && (
          <button
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                for (const r of rows) await generate(r);
              })
            }
          >
            本页 {rows.length} 条全部生成凭证
          </button>
        )}
      </div>
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        path="/events"
        label="财务事件"
        query={{ status: status || undefined }}
        onData={(d) => setRows(d.rows)}
        onRow={setRow}
        selected={row?.id}
        empty="没有需要处理的事件"
        cols={[
          col('date', '日期'),
          col('source_kind', '来源', { render: (r) => sourceNames[r.source_kind] || r.source_kind }),
          col('number', '单号', { render: (r) => r.number || r.source_id }),
          col('status', '状态', { render: (r) => <Status value={r.status} /> }),
          col('problem', '说明', { wrap: true, render: (r) => r.problem || '—' }),
          mon('amount_cents', '金额 / 元'),
        ]}
      />
      {row && (
        <DetailPanel
          title={(sourceNames[row.source_kind] || row.source_kind) + ' ' + (row.number || row.source_id)}
          status={<Status value={row.status} />}
          close={() => setRow(null)}
          actions={
            perms.edit ? (
              <div className="fin-actions">
                {row.status === 'ready' && !row.voucher_id && (
                  <button
                    className="primary"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await generate(row);
                        setRow(null);
                      })
                    }
                  >
                    生成凭证
                  </button>
                )}
                {row.status === 'info_pending' && <a href="#finance-flow?missing=1">去台账补资料</a>}
                {row.status === 'difference' && row.source_kind === 'arrival_data_edit' && (
                  <button onClick={() => setDialog('ack')}>核对无误</button>
                )}
                {row.status === 'difference' && row.source_kind !== 'arrival_data_edit' && (
                  <button onClick={() => setDialog('correct')}>红冲重做</button>
                )}
              </div>
            ) : undefined
          }
        >
          <ErrorLine text={action.error} close={action.clear} />
          <Facts
            items={[
              ['日期', row.date],
              ['金额 / 元', yuan(row.amount_cents)],
              ['说明', row.problem],
              ['凭证', row.voucher_id ? <a href={'#finance-ledger?voucher=' + row.voucher_id}>查看</a> : '未生成'],
            ]}
          />
          {dialog === 'correct' && (
            <FormDialog
              title="红冲重做"
              intro="原凭证红冲，按单据最新内容重新登记。已核销的要先撤销核销。"
              fields={[
                { name: 'date', label: '更正日期', type: 'date', required: true },
                { name: 'reason', label: '原因', required: true, wide: true },
              ]}
              initial={{ date: todayText() }}
              close={() => setDialog(null)}
              submit={async (v) => {
                await finSend('POST', '/events/' + row.id + '/correct', { ...v, version: row.version });
                setRow(null);
              }}
            />
          )}
          {dialog === 'ack' && (
            <FormDialog
              title="核对统计更正"
              intro="管理员改了到货统计，库存流水没动。确认后这条不再提示。"
              fields={[{ name: 'reason', label: '说明', required: true, wide: true }]}
              close={() => setDialog(null)}
              submit={async (v) => {
                await finSend('POST', '/events/' + row.id + '/acknowledge', { ...v, version: row.version });
                setRow(null);
              }}
            />
          )}
        </DetailPanel>
      )}
    </>
  );
}

const bookTypes = [
  ['balance', '余额表'],
  ['general', '总账'],
  ['detail', '明细账'],
  ['journal', '序时账'],
  ['auxiliary', '辅助账'],
  ['cash', '现金日记账'],
  ['bank', '银行日记账'],
] as const;
function BooksTab() {
  const [period, setPeriod] = usePeriod();
  const [kind, setKind] = useState('balance');
  const [account, setAccount] = useState('');
  const [voucher, setVoucher] = useState<number | null>(null);
  const summary = ['balance', 'general', 'auxiliary'].includes(kind);
  const query = { period, account: account.trim() || undefined };
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <select aria-label="账簿类型" value={kind} onChange={(e) => setKind(e.target.value)}>
          {bookTypes.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="科目编码"
          placeholder="科目编码，如 1122"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        />
        <span className="fin-grow" />
        <ExportLink path={'/books/' + kind + '/export'} query={query} />
      </div>
      <FinList
        key={kind}
        path={'/books/' + kind}
        label="账簿"
        query={query}
        rowKey={(r, i) => (r.voucher_id ?? r.account_code) + ':' + (r.position ?? r.auxiliary_id ?? '') + ':' + i}
        onRow={summary ? undefined : (r) => setVoucher(r.voucher_id)}
        empty="这个月没有数据。只统计已记账的凭证。"
        cols={
          summary
            ? [
                col('account_code', '科目编码'),
                col('account_name', '科目'),
                ...(kind === 'auxiliary' ? [col('auxiliary_name', '辅助项')] : []),
                mon('opening', '期初'),
                mon('debit', '本期借方'),
                mon('credit', '本期贷方'),
                mon('year_debit', '本年借方'),
                mon('year_credit', '本年贷方'),
                mon('ending', '期末'),
              ]
            : [
                col('date', '日期'),
                col('number', '凭证号', { num: true }),
                col('account_code', '科目编码'),
                col('account_name', '科目'),
                col('description', '摘要', { wrap: true }),
                col('auxiliary_name', '辅助项', { render: (r) => r.auxiliary_name || '—' }),
                mon('debit', '借方'),
                mon('credit', '贷方'),
              ]
        }
      />
      {voucher && <VoucherPanel id={voucher} close={() => setVoucher(null)} />}
    </>
  );
}

function TemplatesTab() {
  const perms = useFinPerms();
  const { data, error } = useFin<any>('/templates');
  const [row, setRow] = useState<any>(null);
  const rows = Array.isArray(data) ? data : data?.rows || [];
  return (
    <>
      <p className="fin-note">业务单据记账时用哪些科目。改之前先问懂账的人。</p>
      <ErrorLine text={error} />
      <section className="panel business-records">
        <FinTable
          label="记账模板"
          rows={rows}
          rowKey={(r) => r.name}
          onRow={perms.close ? setRow : undefined}
          cols={[
            col('name', '模板'),
            col('mapping', '科目映射', { wrap: true }),
            col('version', '版本', { num: true }),
          ]}
        />
      </section>
      {row && (
        <FormDialog
          title={'修改模板 ' + row.name}
          fields={[{ name: 'mapping', label: '映射（JSON）', type: 'textarea', required: true }]}
          initial={{ mapping: typeof row.mapping === 'string' ? row.mapping : JSON.stringify(row.mapping) }}
          close={() => setRow(null)}
          submit={(v) => {
            let mapping: unknown;
            try {
              mapping = JSON.parse(v.mapping);
            } catch {
              throw new Error('映射不是有效 JSON。');
            }
            return finSend('PUT', '/templates', { name: row.name, mapping, version: row.version });
          }}
        />
      )}
    </>
  );
}

function AuditTab() {
  const perms = useFinPerms();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  if (!perms.close) return <p className="fin-note">查看修改记录需要财务负责人权限。</p>;
  return (
    <>
      <div className="fin-toolbar">
        <input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} />
        至
        <input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <FinList
        path="/audit"
        label="修改记录"
        query={{ from: from || undefined, to: to || undefined }}
        empty="没有记录"
        cols={[
          col('at', '时间', { render: (r) => String(r.at || '').slice(0, 19).replace('T', ' ') }),
          col('actor_name', '操作人'),
          col('action', '动作'),
          col('entity', '对象'),
          col('record_id', '编号', { render: (r) => r.record_id ?? '—' }),
        ]}
      />
    </>
  );
}

export default function LedgerPage() {
  const [tab, setTab] = useTab('vouchers');
  const enabled = useFinanceEnabled();
  if (!enabled)
    return (
      <div className="fin-page">
        <PageHeading title="凭证账簿" />
        <NeedEnable what="凭证和账簿" />
      </div>
    );
  return (
    <div className="fin-page">
      <PageHeading title="凭证账簿" />
      <Tabs label="凭证账簿分类" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'vouchers' && <VouchersTab />}
      {tab === 'events' && <EventsTab />}
      {tab === 'books' && <BooksTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}
