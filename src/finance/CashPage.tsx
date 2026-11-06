import { useEffect, useRef, useState } from 'react';
import ManagementDialog from '../ManagementDialog';
import DetailPanel from '../ui/DetailPanel';
import { ListSummary, PageHeading } from '../ui/ListLayout';
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
  centsText,
  col,
  finGet,
  finSend,
  finUpload,
  mon,
  toCents,
  todayText,
  useAction,
  useCashAccounts,
  useFin,
  useFinPerms,
  usePeriod,
  useTab,
  yuan,
  type Field,
} from './kit';

const tabs = [
  ['documents', '收付款'],
  ['accounts', '资金账户'],
  ['bank', '银行流水'],
  ['notes', '承兑票据'],
  ['invoices', '发票'],
  ['matching', '开票对比'],
  ['tax', '税务底稿'],
] as const;
const cashKinds = [
  ['receipt', '收客户款'],
  ['payment', '付供应商款'],
  ['income', '其他收入'],
  ['outlay', '其他支出（房租、水电等）'],
  ['transfer', '内部转账'],
] as const;
const kindName = (k: unknown) => cashKinds.find(([v]) => v === k)?.[1] ?? String(k);
const methods = ['银行', '现金', '承兑汇票', '微信', '支付宝', '其他'].map((m) => [m, m] as const);
const cashFields: Field[] = [
  { name: 'kind', label: '类型', type: 'select', required: true, options: cashKinds },
  { name: 'date', label: '日期', type: 'date', required: true },
  { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
  {
    name: 'targetAccountId',
    label: '转入账户',
    type: 'cash-account',
    required: true,
    show: (v) => v.kind === 'transfer',
  },
  {
    name: 'partyId',
    label: '往来单位',
    type: 'party',
    required: true,
    partyKind: (v) => (v.kind === 'receipt' ? 'customer' : 'supplier'),
    show: (v) => v.kind === 'receipt' || v.kind === 'payment',
  },
  { name: 'amount', label: '金额 / 元', type: 'money', required: true },
  { name: 'method', label: '方式', type: 'select', required: true, options: methods },
  {
    name: 'counterAccount',
    label: '对方科目',
    type: 'account',
    required: true,
    show: (v) => v.kind === 'income' || v.kind === 'outlay',
  },
  {
    name: 'cashFlow',
    label: '现金流量项目',
    type: 'cash-flow',
    required: true,
    show: (v) => v.kind === 'income' || v.kind === 'outlay',
  },
  { name: 'description', label: '说明', required: true, wide: true },
];

/** 核销窗口：系统按到期先后给建议，金额和优惠都可以改。 */
function AllocateDialog({
  doc,
  mode,
  close,
}: {
  doc: any;
  mode: 'confirm' | 'allocate';
  close: () => void;
}) {
  const [lines, setLines] = useState<any[] | null>(null);
  const [available, setAvailable] = useState(0);
  const [loadError, setLoadError] = useState('');
  const action = useAction();
  useEffect(() => {
    let active = true;
    finGet('/cash/documents/' + doc.id + '/suggestions')
      .then((s) => {
        if (!active) return;
        setAvailable(s.available);
        setLines(
          s.allocations.map((a: any) => ({
            ...a,
            use: true,
            amountText: centsText(a.amount),
            discountText: '',
          })),
        );
      })
      .catch((e) => {
        if (!active) return;
        setLines([]);
        setLoadError(e.message);
      });
    return () => {
      active = false;
    };
    // 只在打开窗口时取一次建议
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);
  const update = (i: number, patch: object) =>
    setLines((all) => all!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const submit = () =>
    action.run(async () => {
      const allocations = (lines || [])
        .filter((l) => l.use && l.amountText.trim())
        .map((l) => {
          const discount = l.discountText.trim() ? toCents(l.discountText) : 0;
          return {
            obligationId: l.obligationId,
            version: l.version,
            amount: toCents(l.amountText),
            discount,
            ...(discount ? { reason: '现结优惠' } : {}),
          };
        });
      if (mode === 'confirm')
        await finSend('POST', '/cash/documents/' + doc.id + '/confirm', {
          version: doc.version,
          allocations,
        });
      else {
        if (!allocations.length) throw new Error('请至少核销一张单子。');
        await finSend('POST', '/cash/documents/' + doc.id + '/allocate', {
          version: doc.version,
          date: todayText() < doc.date ? doc.date : todayText(),
          allocations,
        });
      }
      close();
    });
  return (
    <ManagementDialog
      title={mode === 'confirm' ? '确认' + kindName(doc.kind) : '核销'}
      busy={action.busy}
      close={close}
    >
      <div className="fin-form fin-wide">
        <p className="form-intro">
          {doc.party_name || ''} · {yuan(doc.amount_cents)} 元，可核销 {yuan(available)} 元。
          核销金额含优惠：比如 339 元的单子优惠 6.78 元，核销填 339，优惠填 6.78。
          {mode === 'confirm' && ' 也可以先不核销，以后再做。'}
        </p>
        {lines === null ? (
          <p className="fin-note">正在读取…</p>
        ) : lines.length === 0 ? (
          <p className="fin-note">这个单位没有未结清的单子。</p>
        ) : (
          <div className="table-wrap">
            <table className="fin-lines">
              <thead>
                <tr>
                  <th />
                  <th>单据</th>
                  <th>单据日期</th>
                  <th>到期日</th>
                  <th className="num">未结 / 元</th>
                  <th>核销 / 元</th>
                  <th>优惠 / 元</th>
                  <th>可用优惠</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.obligationId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'核销 ' + (l.sourceNumber || l.description)}
                        checked={l.use}
                        onChange={(e) => update(i, { use: e.target.checked })}
                      />
                    </td>
                    <td>{l.sourceNumber || l.description}</td>
                    <td>{l.date}</td>
                    <td>{l.dueDate || '没有账期'}</td>
                    <td className="num">{yuan(l.balance)}</td>
                    <td>
                      <input
                        aria-label="核销金额"
                        value={l.amountText}
                        onChange={(e) => update(i, { amountText: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label="优惠金额"
                        value={l.discountText}
                        onChange={(e) => update(i, { discountText: e.target.value })}
                      />
                    </td>
                    <td>
                      {l.offer ? (
                        <button
                          type="button"
                          onClick={() =>
                            update(i, {
                              discountText: centsText(l.offer.amount),
                              amountText: centsText(l.amount + l.offer.amount),
                            })
                          }
                        >
                          用 {l.offer.rate}%，省 {yuan(l.offer.amount)}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorLine text={loadError} />
        <ErrorLine text={action.error} close={action.clear} />
        <div className="management-dialog-actions">
          <button type="button" onClick={close} disabled={action.busy}>
            取消
          </button>
          <button className="primary" disabled={action.busy || lines === null} onClick={submit}>
            {mode === 'confirm' ? '确认' : '核销'}
          </button>
        </div>
      </div>
    </ManagementDialog>
  );
}

function DocumentsTab() {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [revokeRow, setRevokeRow] = useState<any>(null);
  const confirmAction = useAction();
  const [end] = useState(() => (y: string) => {
    const [a, b] = y.split('-').map(Number);
    return y + '-' + String(new Date(a, b, 0).getDate()).padStart(2, '0');
  });
  const accounts = useCashAccounts();
  const detail = useFin(selected ? '/cash/documents/' + selected : null);
  const doc = selected ? detail.data : null;
  const isParty = doc && (doc.kind === 'receipt' || doc.kind === 'payment');
  const accountName = (id: unknown) => accounts.find((a) => a.id === id)?.name ?? String(id ?? '—');
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <select aria-label="收付类型" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部类型</option>
          {cashKinds.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="fin-grow" />
        {perms.cash && (
          <button className="primary" onClick={() => setDialog('new')}>
            新建收付款
          </button>
        )}
      </div>
      {perms.cash && !accounts.length && (
        <div className="fin-banner" data-tone="info">
          <span className="fin-grow">还没有资金账户，先建一个才能录收付款。</span>
        </div>
      )}
      <FinList
        path="/cash/documents"
        label="收付款单"
        query={{ kind: kind || undefined, from: period + '-01', to: end(period) }}
        onRow={(r) => setSelected(r.id)}
        selected={selected}
        empty="这个月还没有收付款"
        cols={[
          col('date', '日期'),
          col('kind', '类型', { render: (r) => kindName(r.kind) }),
          col('party_name', '往来单位', { wrap: true, render: (r) => r.party_name || '—' }),
          col('description', '说明', { wrap: true }),
          col('status', '状态', { render: (r) => <Status value={r.status} /> }),
          mon('amount_cents', '金额 / 元'),
          col('unallocated', '未核销', {
            money: true,
            render: (r) =>
              r.kind === 'receipt' || r.kind === 'payment' ? yuan(r.unallocated) : '—',
          }),
        ]}
      />
      {selected && doc && (
        <DetailPanel
          title={kindName(doc.kind) + ' · ' + doc.date}
          status={<Status value={doc.status} />}
          close={() => setSelected(null)}
          actions={
            <div className="fin-actions">
              {doc.status === 'draft' && perms.cash && (
                <>
                  <button
                    className="primary"
                    onClick={() =>
                      isParty
                        ? setDialog('confirm')
                        : void confirmAction.run(() =>
                            finSend('POST', '/cash/documents/' + doc.id + '/confirm', {
                              version: doc.version,
                            }),
                          )
                    }
                  >
                    确认
                  </button>
                  <button onClick={() => setDialog('edit')}>修改</button>
                </>
              )}
              {doc.status === 'confirmed' && isParty && perms.edit && (
                <button onClick={() => setDialog('allocate')}>核销</button>
              )}
              {doc.status === 'confirmed' && perms.cash && (
                <button onClick={() => setDialog('cancel')}>撤销</button>
              )}
            </div>
          }
        >
          <ErrorLine text={confirmAction.error} close={confirmAction.clear} />
          <Facts
            items={[
              ['往来单位', doc.party_name],
              ['金额 / 元', yuan(doc.amount_cents)],
              ['资金账户', accountName(doc.account_id)],
              ['转入账户', doc.target_account_id ? accountName(doc.target_account_id) : null],
              ['方式', doc.method],
              ['说明', doc.description],
              ['对方科目', doc.counter_account],
              ['现金流量项目', doc.cash_flow],
            ]}
          />
          {doc.vouchers?.length > 0 && (
            <>
              <h3>凭证</h3>
              <FinTable
                label="相关凭证"
                rows={doc.vouchers}
                cols={[
                  col('number', '凭证号', {
                    render: (v) => <a href={'#finance-ledger?voucher=' + v.id}>{v.period + ' 第 ' + v.number + ' 号'}</a>,
                  }),
                  col('status', '状态', { render: (v) => <Status value={v.status} /> }),
                ]}
              />
            </>
          )}
          {doc.allocations?.length > 0 && (
            <>
              <h3>核销</h3>
              <FinTable
                label="核销记录"
                rows={doc.allocations}
                cols={[
                  col('date', '日期'),
                  mon('amount_cents', '金额'),
                  mon('discount_cents', '优惠'),
                  col('status', '状态', { render: (a) => <Status value={a.status} /> }),
                  col('ops', '', {
                    render: (a) =>
                      a.status === 'active' && !a.reversal_of && perms.edit ? (
                        <button onClick={() => setRevokeRow(a)}>撤销</button>
                      ) : null,
                  }),
                ]}
              />
            </>
          )}
        </DetailPanel>
      )}
      {(dialog === 'new' || dialog === 'edit') && (
        <FormDialog
          title={dialog === 'new' ? '新建收付款' : '修改收付款'}
          intro="保存后是草稿，确认才入账。"
          fields={cashFields}
          initial={
            dialog === 'edit' && doc
              ? {
                  kind: doc.kind,
                  date: doc.date,
                  accountId: doc.account_id,
                  targetAccountId: doc.target_account_id,
                  partyId: doc.party_id,
                  amount: doc.amount_cents,
                  method: doc.method,
                  counterAccount: doc.counter_account,
                  cashFlow: doc.cash_flow,
                  description: doc.description,
                }
              : { kind: 'receipt', date: todayText(), method: '银行', accountId: accounts[0]?.id }
          }
          close={() => setDialog(null)}
          submit={async (v) => {
            const saved = await finSend('PUT', '/cash/documents', {
              ...v,
              ...(dialog === 'edit' ? { id: doc.id, version: doc.version } : {}),
            });
            setSelected(saved.id);
          }}
        />
      )}
      {dialog === 'confirm' && doc && (
        <AllocateDialog doc={doc} mode="confirm" close={() => setDialog(null)} />
      )}
      {dialog === 'allocate' && doc && (
        <AllocateDialog doc={doc} mode="allocate" close={() => setDialog(null)} />
      )}
      {dialog === 'cancel' && doc && (
        <FormDialog
          title="撤销这笔收付款"
          intro="录错了就撤销。已记账的凭证会红冲，实际收入支出里同步去掉。有核销的要先撤销核销。"
          danger
          submitLabel="确认撤销"
          fields={[
            { name: 'date', label: '撤销日期', type: 'date', required: true },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ date: todayText() }}
          close={() => setDialog(null)}
          submit={(v) =>
            finSend('POST', '/cash/documents/' + doc.id + '/cancel', { ...v, version: doc.version })
          }
        />
      )}
      {revokeRow && (
        <FormDialog
          title="撤销核销"
          intro="往来单余额会恢复。已结账月份保留原记录，生成反向核销。"
          fields={[
            { name: 'date', label: '撤销日期', type: 'date', required: true },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ date: todayText() }}
          close={() => setRevokeRow(null)}
          submit={(v) =>
            finSend('POST', '/allocations/' + revokeRow.id + '/revoke', {
              ...v,
              version: revokeRow.version,
            })
          }
        />
      )}
    </>
  );
}

function AccountsTab() {
  const perms = useFinPerms();
  const [date, setDate] = useState(todayText());
  const [editing, setEditing] = useState<any>(null);
  const daily = useFin('/cash/daily', { date, pageSize: 200 });
  return (
    <>
      <div className="fin-toolbar">
        <label className="fin-period">
          <span>日期</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <span className="fin-grow" />
        {perms.close && (
          <button className="primary" onClick={() => setEditing({})}>
            新建资金账户
          </button>
        )}
      </div>
      <ErrorLine text={daily.error} />
      <section className="panel business-records">
        <FinTable
          label="资金日报"
          rows={daily.data?.rows || []}
          empty="还没有资金账户"
          onRow={perms.close ? (r) => setEditing(r) : undefined}
          cols={[
            col('name', '账户'),
            col('kind', '类型', { render: (r) => (r.kind === 'cash' ? '现金' : '银行') }),
            col('account_code', '科目'),
            mon('opening', '期初'),
            mon('income', '收入'),
            mon('expense', '支出'),
            col('closing', '期末', {
              money: true,
              render: (r) => (
                <span className={r.insufficient ? 'fin-negative' : undefined}>{yuan(r.closing)}</span>
              ),
            }),
          ]}
        />
      </section>
      {editing && (
        <FormDialog
          title={editing.id ? '修改资金账户' : '新建资金账户'}
          fields={[
            { name: 'name', label: '名称', required: true },
            {
              name: 'kind',
              label: '类型',
              type: 'select',
              required: true,
              options: [
                ['bank', '银行'],
                ['cash', '现金'],
              ],
            },
            { name: 'accountCode', label: '对应科目', type: 'account', required: true },
            { name: 'lastFour', label: '账号后四位', hint: '只存后四位' },
            { name: 'enabled', label: '启用', type: 'check' },
          ]}
          initial={
            editing.id
              ? {
                  name: editing.name,
                  kind: editing.kind,
                  accountCode: editing.account_code,
                  lastFour: editing.last_four,
                  enabled: editing.enabled ?? true,
                }
              : { kind: 'bank', enabled: true, accountCode: '1002' }
          }
          close={() => setEditing(null)}
          submit={async (v) => {
            if (!editing.id) {
              const { enabled: _enabled, ...rest } = v;
              return finSend('PUT', '/cash/accounts', rest);
            }
            const full = await finGet('/cash/accounts', { pageSize: 200 });
            const current = full.rows.find((a: any) => a.id === editing.id);
            return finSend('PUT', '/cash/accounts', { ...v, id: editing.id, version: current.version });
          }}
        />
      )}
    </>
  );
}

function BankTab() {
  const perms = useFinPerms();
  const accounts = useCashAccounts().filter((a) => a.kind === 'bank');
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<'upload' | 'reconcile' | null>(null);
  const [row, setRow] = useState<any>(null);
  const [recon, setRecon] = useState<any>(null);
  const action = useAction();
  const suggestions = useFin<any[]>(row ? '/bank/rows/' + row.id + '/suggestions' : null);
  const fileRef = useRef<HTMLInputElement>(null);
  const account = accountId || (accounts[0] ? String(accounts[0].id) : '');
  return (
    <>
      <div className="fin-toolbar">
        <select aria-label="银行账户" value={account} onChange={(e) => setAccountId(e.target.value)}>
          {!accounts.length && <option value="">没有银行账户</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select aria-label="匹配状态" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部</option>
          <option value="unmatched">未匹配</option>
          <option value="matched">已匹配</option>
        </select>
        <span className="fin-grow" />
        <button disabled={!account} onClick={() => setDialog('reconcile')}>
          余额调节
        </button>
        {perms.cash && (
          <button className="primary" disabled={!account} onClick={() => setDialog('upload')}>
            导入流水
          </button>
        )}
      </div>
      <ErrorLine text={action.error} close={action.clear} />
      {recon && (
        <section className="panel fin-card business-records">
          <h2>余额调节表</h2>
          <ListSummary
            items={[
              { label: '账面余额', value: yuan(recon.bookBalance) },
              { label: '银行余额', value: yuan(recon.bankBalance) },
              { label: '调节后账面', value: yuan(recon.adjustedBook) },
              { label: '调节后银行', value: yuan(recon.adjustedBank) },
              { label: '差额', value: yuan(recon.difference) },
            ]}
          />
          <p className="fin-note">
            银行有账上没有 {recon.bankUnmatched.length} 笔，账上有银行没有 {recon.bookUnmatched.length} 笔。
          </p>
        </section>
      )}
      {account && (
        <FinList
          path="/bank/rows"
          label="银行流水"
          query={{ accountId: account, status: status || undefined }}
          onRow={setRow}
          selected={row?.id}
          empty="还没有导入流水"
          cols={[
            col('date', '日期'),
            col('party_name', '对方', { wrap: true }),
            col('description', '摘要', { wrap: true }),
            col('reference', '流水号'),
            mon('amount_cents', '金额 / 元'),
            col('voucher_id', '匹配', { render: (r) => (r.voucher_id ? '已匹配' : '未匹配') }),
          ]}
        />
      )}
      {row && (
        <DetailPanel title={row.date + ' · ' + yuan(row.amount_cents)} close={() => setRow(null)}>
          <Facts
            items={[
              ['对方', row.party_name],
              ['摘要', row.description],
              ['流水号', row.reference],
            ]}
          />
          {row.voucher_id && perms.cash ? (
            <button
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await finSend('PUT', '/bank/rows/' + row.id + '/match', {
                    version: row.version,
                    voucherId: null,
                  });
                  setRow(null);
                })
              }
            >
              解除匹配
            </button>
          ) : (
            <>
              <h3>建议匹配</h3>
              <p className="fin-note">只给建议，点了才算。</p>
              <FinTable
                label="匹配建议"
                empty="没有金额相同的分录"
                rows={suggestions.data || []}
                rowKey={(_, i) => i}
                cols={[
                  col('date', '日期'),
                  col('party_name', '对方', { wrap: true }),
                  mon('amount', '金额'),
                  col('ops', '', {
                    render: (s) =>
                      perms.cash ? (
                        <button
                          disabled={action.busy}
                          onClick={() =>
                            action.run(async () => {
                              await finSend('PUT', '/bank/rows/' + row.id + '/match', {
                                version: row.version,
                                ...(s.entries
                                  ? { entries: s.entries }
                                  : { voucherId: s.voucher_id, position: s.position }),
                              });
                              setRow(null);
                            })
                          }
                        >
                          匹配
                        </button>
                      ) : null,
                  }),
                ]}
              />
            </>
          )}
        </DetailPanel>
      )}
      {dialog === 'upload' && (
        <FormDialog
          title="导入银行流水"
          intro="支持 CSV（UTF-8）和 Excel。按银行导出文件的列号填，从 1 开始数。金额列的单位是元，收入为正、支出为负。重复的流水自动跳过。"
          submitLabel="导入"
          fields={[
            { name: 'date', label: '日期在第几列', type: 'int', required: true },
            { name: 'amount', label: '金额在第几列', type: 'int', required: true },
            { name: 'party', label: '对方在第几列', type: 'int' },
            { name: 'description', label: '摘要在第几列', type: 'int' },
            { name: 'reference', label: '流水号在第几列', type: 'int' },
            { name: 'skipHeader', label: '第一行是表头', type: 'check' },
          ]}
          initial={{ date: 1, amount: 2, skipHeader: true }}
          close={() => setDialog(null)}
          submit={async (v) => {
            const file = fileRef.current?.files?.[0];
            if (!file) throw new Error('请选择文件。');
            const { skipHeader, ...mapping } = v;
            await finUpload(
              '/bank/upload',
              {
                accountId: account,
                format: /\.csv$/i.test(file.name) ? 'csv' : 'xlsx',
                mapping: JSON.stringify(mapping),
                skipHeader: skipHeader ? 1 : 0,
              },
              file,
            );
          }}
        >
          <label className="field fin-subform">
            <span>文件 *</span>
            <input ref={fileRef} type="file" accept=".csv,.xlsx" />
          </label>
        </FormDialog>
      )}
      {dialog === 'reconcile' && (
        <FormDialog
          title="余额调节"
          submitLabel="生成"
          fields={[
            { name: 'from', label: '开始日期', type: 'date', required: true },
            { name: 'to', label: '结束日期', type: 'date', required: true },
            { name: 'bankBalance', label: '银行对账单余额 / 元', type: 'money', required: true },
          ]}
          initial={{ from: todayText().slice(0, 8) + '01', to: todayText() }}
          close={() => setDialog(null)}
          submit={async (v) => setRecon(await finGet('/bank/reconcile', { accountId: account, ...v }))}
        />
      )}
    </>
  );
}

const noteStates = [
  ['endorsed', '背书转让'],
  ['discounted', '贴现'],
  ['matured', '到期承兑'],
  ['returned', '退票'],
] as const;
function NotesTab() {
  const perms = useFinPerms();
  const [dialog, setDialog] = useState(false);
  const [row, setRow] = useState<any>(null);
  return (
    <>
      <div className="fin-toolbar">
        <span className="fin-grow" />
        {perms.cash && (
          <button className="primary" onClick={() => setDialog(true)}>
            新增票据
          </button>
        )}
      </div>
      <FinList
        path="/notes"
        label="承兑票据"
        empty="还没有票据"
        cols={[
          col('number', '票号'),
          col('kind', '类型', { render: (r) => (r.kind === 'receivable' ? '应收票据' : '应付票据') }),
          col('party_name', '往来单位', { wrap: true }),
          col('bank', '承兑行'),
          col('date', '出票日'),
          col('due_date', '到期日'),
          col('status', '状态', {
            render: (r) =>
              r.status === 'held' ? '持有中' : (noteStates.find(([k]) => k === r.status)?.[1] ?? r.status),
          }),
          mon('amount_cents', '金额 / 元'),
          col('ops', '', {
            render: (r) =>
              r.status === 'held' && perms.cash ? <button onClick={() => setRow(r)}>变更</button> : null,
          }),
        ]}
      />
      {dialog && (
        <FormDialog
          title="新增票据"
          fields={[
            {
              name: 'kind',
              label: '类型',
              type: 'select',
              required: true,
              options: [
                ['receivable', '应收票据'],
                ['payable', '应付票据'],
              ],
            },
            {
              name: 'partyId',
              label: '往来单位',
              type: 'party',
              required: true,
              partyKind: (v) => (v.kind === 'receivable' ? 'customer' : 'supplier'),
            },
            { name: 'number', label: '票号', required: true },
            { name: 'bank', label: '承兑行', required: true },
            { name: 'date', label: '出票日', type: 'date', required: true },
            { name: 'dueDate', label: '到期日', type: 'date', required: true },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
          ]}
          initial={{ kind: 'receivable', date: todayText() }}
          close={() => setDialog(false)}
          submit={(v) => finSend('POST', '/notes', v)}
        />
      )}
      {row && (
        <FormDialog
          title={'票据 ' + row.number}
          fields={[
            { name: 'status', label: '变更为', type: 'select', required: true, options: noteStates },
            { name: 'date', label: '日期', type: 'date', required: true },
            {
              name: 'accountId',
              label: '资金账户',
              type: 'cash-account',
              show: (v) => v.status === 'discounted' || v.status === 'matured',
            },
            {
              name: 'proceeds',
              label: '实收 / 元',
              type: 'money',
              show: (v) => v.status === 'discounted',
            },
            {
              name: 'counterPartyId',
              label: '背书给',
              type: 'party',
              partyKind: 'supplier',
              show: (v) => v.status === 'endorsed',
            },
            { name: 'counterAccount', label: '对方科目', type: 'account' },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ status: 'matured', date: todayText() }}
          close={() => setRow(null)}
          submit={(v) => finSend('POST', '/notes/' + row.id + '/status', { ...v, version: row.version })}
        />
      )}
    </>
  );
}

const invoiceStates: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  certified: '已认证',
  nondeductible: '不可抵扣',
  void: '已作废',
};
function InvoiceDetail({ id, close }: { id: number; close: () => void }) {
  const perms = useFinPerms();
  const { data } = useFin('/invoices/' + id);
  const action = useAction();
  const [dialog, setDialog] = useState<'link' | 'status' | null>(null);
  if (!data) return null;
  const inv = data.invoice;
  const draft = inv.status === 'draft';
  return (
    <DetailPanel
      title={'发票 ' + inv.number}
      status={<span className="business-status" data-tone="muted">{invoiceStates[inv.status] || inv.status}</span>}
      close={close}
      actions={
        perms.edit ? (
          <div className="fin-actions">
            {draft && <button onClick={() => setDialog('link')}>关联往来单</button>}
            {draft && (
              <button
                className="primary"
                disabled={action.busy || !data.links.length}
                onClick={() =>
                  action.run(() =>
                    finSend('POST', '/invoices/' + inv.id + '/confirm', { version: inv.version }),
                  )
                }
              >
                确认
              </button>
            )}
            {inv.status !== 'void' && <button onClick={() => setDialog('status')}>变更状态</button>}
          </div>
        ) : undefined
      }
    >
      <ErrorLine text={action.error} close={action.clear} />
      <Facts
        items={[
          ['方向', inv.direction === 'sale' ? '销项' : '进项'],
          ['类型', inv.type],
          ['日期', inv.date],
          ['往来单位', inv.party_name],
          ['税号', inv.tax_id],
          ['不含税 / 元', yuan(inv.net)],
          ['税率', inv.rate + '%'],
          ['税额 / 元', yuan(inv.tax)],
          ['价税合计 / 元', yuan(inv.gross)],
          ['原件', inv.attachment_id ? <a href={'/api/finance/attachments/' + inv.attachment_id} target="_blank" rel="noreferrer">打开</a> : null],
        ]}
      />
      <h3>关联往来</h3>
      <FinTable
        label="发票关联"
        rowKey={(l) => l.obligation_id}
        rows={data.links}
        empty="还没有关联。确认前要先关联往来单。"
        cols={[
          col('source_number', '单据', { render: (l) => l.source_number || '手工往来' }),
          col('date', '单据日'),
          mon('obligation_amount', '往来金额'),
          mon('amount_cents', '本票金额'),
        ]}
      />
      {dialog === 'link' && (
        <FormDialog
          title="关联往来单"
          intro="到票对应哪张往来单。部分到票时填写对应的暂估金额，数量和单位可选。"
          fields={[
            {
              name: 'obligationId',
              label: '对应的单据',
              type: 'obligation',
              required: true,
              wide: true,
              obligation: {
                kind: inv.direction === 'sale' ? 'receivable' : 'payable',
                partyId: inv.party_id,
              },
            },
            { name: 'amount', label: '本票金额 / 元', type: 'money', required: true },
            { name: 'estimateAmount', label: '对应暂估 / 元', type: 'money' },
            { name: 'quantity', label: '数量' },
            { name: 'unit', label: '单位' },
          ]}
          initial={{ amount: inv.gross }}
          close={() => setDialog(null)}
          submit={(v) =>
            finSend('PUT', '/invoices/' + inv.id + '/links', {
              version: inv.version,
              links: [
                ...data.links.map((l: any) => ({
                  obligationId: l.obligation_id,
                  amount: l.amount_cents,
                })),
                v,
              ],
            })
          }
        />
      )}
      {dialog === 'status' && (
        <FormDialog
          title="变更发票状态"
          fields={[
            {
              name: 'status',
              label: '状态',
              type: 'select',
              required: true,
              options: [
                ['certified', '已认证'],
                ['nondeductible', '不可抵扣（进项转出）'],
                ['void', '作废'],
              ],
            },
            { name: 'date', label: '日期', type: 'date', required: true },
            {
              name: 'counterAccount',
              label: '转出科目',
              type: 'account',
              show: (v) => v.status === 'nondeductible',
            },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ status: 'certified', date: todayText() }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/invoices/' + inv.id + '/status', { ...v, version: inv.version })}
        />
      )}
    </DetailPanel>
  );
}
function InvoicesTab() {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [direction, setDirection] = useState('sale');
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <div className="record-view-tabs" aria-label="发票方向">
          <button className={direction === 'sale' ? 'selected' : ''} onClick={() => setDirection('sale')}>
            销项
          </button>
          <button className={direction === 'purchase' ? 'selected' : ''} onClick={() => setDirection('purchase')}>
            进项
          </button>
        </div>
        <span className="fin-grow" />
        {perms.edit && (
          <button className="primary" onClick={() => setDialog(true)}>
            录入发票
          </button>
        )}
      </div>
      <FinList
        path="/invoices"
        label="发票"
        query={{ direction, period }}
        onRow={(r) => setSelected(r.id)}
        selected={selected}
        empty="这个月没有发票"
        cols={[
          col('date', '日期'),
          col('number', '票号'),
          col('type', '类型'),
          col('party_name', '往来单位', { wrap: true }),
          col('status', '状态', { render: (r) => invoiceStates[r.status] || r.status }),
          mon('net', '不含税'),
          col('rate', '税率', { num: true, render: (r) => r.rate + '%' }),
          mon('tax', '税额'),
          mon('gross', '价税合计'),
        ]}
      />
      {selected && <InvoiceDetail id={selected} close={() => setSelected(null)} />}
      {dialog && (
        <FormDialog
          title={direction === 'sale' ? '录入销项发票' : '录入进项发票'}
          intro="金额按票面填，系统不替你算。"
          fields={[
            { name: 'type', label: '发票类型', required: true },
            { name: 'number', label: '票号', required: true },
            { name: 'date', label: '开票日期', type: 'date', required: true },
            {
              name: 'partyId',
              label: '往来单位',
              type: 'party',
              required: true,
              partyKind: direction === 'sale' ? 'customer' : 'supplier',
            },
            { name: 'taxId', label: '税号' },
            { name: 'net', label: '不含税 / 元', type: 'money', required: true },
            { name: 'rate', label: '税率 %', required: true },
            { name: 'tax', label: '税额 / 元', type: 'money', required: true },
            { name: 'gross', label: '价税合计 / 元', type: 'money', required: true },
            { name: 'originalId', label: '红票对应的蓝票编号', type: 'int' },
          ]}
          initial={{ type: '数电票', date: todayText() }}
          close={() => setDialog(false)}
          submit={async (v) => {
            const file = fileRef.current?.files?.[0];
            const attachment = file
              ? await finUpload('/attachments/upload', { filename: file.name }, file)
              : null;
            const saved = await finSend('POST', '/invoices', {
              ...v,
              direction,
              ...(attachment ? { attachmentId: attachment.id } : {}),
            });
            setSelected(saved.id);
          }}
        >
          <label className="field fin-subform">
            <span>发票原件（选填）</span>
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.ofd,.xml" />
          </label>
        </FormDialog>
      )}
    </>
  );
}

function MatchingTab() {
  const [kind, setKind] = useState('receivable');
  return (
    <>
      <div className="fin-toolbar">
        <div className="record-view-tabs" aria-label="应收或应付">
          <button className={kind === 'receivable' ? 'selected' : ''} onClick={() => setKind('receivable')}>
            销项对应收
          </button>
          <button className={kind === 'payable' ? 'selected' : ''} onClick={() => setKind('payable')}>
            进项对应付
          </button>
        </div>
      </div>
      <FinList
        path="/invoice-matching"
        label="开票对比"
        query={{ kind }}
        empty="没有往来单"
        cols={[
          col('number', '单据', {
            render: (r) => {
              try {
                const doc = JSON.parse(r.source || 'null')?.doc;
                return doc?.number || doc?.reference || r.description;
              } catch {
                return r.description;
              }
            },
          }),
          col('date', '单据日期'),
          col('party_name', '往来单位', { wrap: true }),
          mon('amount_cents', '往来金额'),
          col('invoiced', '已开票', { money: true, render: (r) => yuan(r.invoiced ?? 0) }),
          col('rest', '未开票', {
            money: true,
            render: (r) => yuan(Number(r.amount_cents) - Number(r.invoiced ?? 0)),
          }),
          mon('outstanding', '未收付'),
        ]}
      />
    </>
  );
}

function TaxTab() {
  const [period, setPeriod] = usePeriod();
  const { data, error } = useFin('/tax', { period });
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <span className="fin-grow" />
        <ExportLink path="/tax/export" query={{ period }} />
      </div>
      <ErrorLine text={error} />
      <div className="fin-banner" data-tone="info">
        只是内部底稿，申报请以税局系统为准。
      </div>
      {data && (
        <section className="panel fin-card business-records">
          <Facts
            items={[
              ['纳税人', data.taxpayer === 'small' ? '小规模' : data.taxpayer === 'general' ? '一般纳税人' : '未设置'],
              ['销项税额', yuan(data.output)],
              ['进项税额', yuan(data.input)],
              ['进项转出', yuan(data.transfer)],
              ['上期留抵', yuan(data.carryIn)],
              ['本期留抵', yuan(data.carryOut)],
              ['应纳增值税', data.payable == null ? '缺征收率' : yuan(data.payable)],
              ['城建税', data.urban == null ? '缺税率' : yuan(data.urban)],
              ['教育费附加', data.education == null ? '缺税率' : yuan(data.education)],
              ['地方教育附加', data.localEducation == null ? '缺税率' : yuan(data.localEducation)],
            ]}
          />
        </section>
      )}
    </>
  );
}

export default function CashPage() {
  const [tab, setTab] = useTab('documents');
  return (
    <div className="fin-page">
      <PageHeading title="资金发票" />
      <Tabs label="资金发票分类" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'documents' && <DocumentsTab />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'bank' && <BankTab />}
      {tab === 'notes' && <NotesTab />}
      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'matching' && <MatchingTab />}
      {tab === 'tax' && <TaxTab />}
    </div>
  );
}
