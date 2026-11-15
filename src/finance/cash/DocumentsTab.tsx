import { useState } from 'react';
import { Hint, yuan, notify, hashParams, stepper, useAction } from '../../ui/index';
import { AccountDialog } from './AccountsTab';
import CashPanel, { type CashDialog, type CashListRow, type RevokeRow } from './CashPanel';
import { CashDocDialogs, RevokeAllocationDialog } from './CashDialogs';
import { cashKinds, isPartyKind, kindName, monthEnd } from './shared';
import { confirmCashDocument, listCashDocuments } from './cash-api';
import { PeriodInput, type HeadFn } from '../layout';
import { FinList, col, mon, type Col } from '../table';
import { Status } from '../status';
import { ALL_CASH_ACCOUNTS, useCashAccounts, useFinPerms, useFinRead } from '../fin-api';
import { usePeriod } from '../page-state';

/** 页头主按钮：还没有资金账户时先建账户（只有财务负责人能建），有了就新建收付款 */
function headPrimary(
  perms: ReturnType<typeof useFinPerms>,
  noAccount: boolean,
  open: { account: () => void; cash: () => void },
) {
  if (!perms.cash) return null;
  if (noAccount) return perms.close ? { label: '新建资金账户', onClick: open.account } : null;
  return { label: '新建收付款', onClick: open.cash };
}

/** 收付款列表的列 */
const cashColumns: Col<CashListRow>[] = [
  col('date', '日期'),
  // 类型在这一页只有一个叫法：列表、筛选、详情头部、编辑窗、提示都用 kindName
  col('kind', '类型', { render: (r) => kindName(r.kind) }),
  col('party_name', '往来单位', { wrap: true, render: (r) => r.party_name || '—' }),
  // 右侧详情打开时：1440 宽收说明，1280 宽再收未核销
  col('description', '说明', { wrap: true, priority: 'low' }),
  col('status', '状态', { render: (r) => <Status value={r.status} /> }),
  mon('amount_cents', '金额 / 元'),
  // 未核销标 mid：1280 宽打开详情时表格区域约 600px，日期、类型、往来单位、状态、金额、未核销估算约 610px 放不下；
  // 详情里“已核销”进度条写着核销了多少、一共多少
  col('unallocated', '未核销', {
    money: true,
    priority: 'mid',
    render: (r) => (isPartyKind(r.kind) ? yuan(r.unallocated) : '—'),
  }),
];

/**
 * 收付款：列表、右侧详情，以及新建、确认、核销、撤销几个窗口。
 * 页头主按钮“新建收付款”；还没有资金账户时换成“新建资金账户”（没权限建账户的只给一句说明）。
 */
export default function DocumentsTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<number | null>(() => {
    const id = hashParams().get('cash');
    return id ? Number(id) : null;
  });
  const [creatingAccount, setCreatingAccount] = useState(false);
  const allAccounts = useFinRead(ALL_CASH_ACCOUNTS);
  const noAccount = !!allAccounts.data && !allAccounts.data.rows.some((a) => a.enabled);
  const [rows, setRows] = useState<CashListRow[]>([]);
  const [dialog, setDialog] = useState<CashDialog | null>(null);
  const [revokeRow, setRevokeRow] = useState<RevokeRow | null>(null);
  const confirmAction = useAction();
  const accounts = useCashAccounts();
  const detail = useFinRead(selected ? ['GET /finance/cash/documents/:id', { params: { id: selected } }] : null);
  const doc = selected ? detail.data : null;
  const accountName = (id: unknown) => accounts.find((a) => a.id === id)?.name ?? String(id ?? '—');
  const closeDialog = () => setDialog(null);
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        primary: headPrimary(perms, noAccount, {
          account: () => setCreatingAccount(true),
          cash: () => setDialog('new'),
        }),
      })}
      {perms.cash && noAccount && (
        <Hint>
          还没有资金账户，收付款要记在某个账户上。
          {perms.close ? '先点页面上方的“新建资金账户”建一个（例如基本户、现金）。' : '请财务负责人先新建一个资金账户。'}
        </Hint>
      )}
      <div className="fin-toolbar">
        <select aria-label="收付类型" value={kind} onChange={(e) => setKind(e.currentTarget.value)}>
          <option value="">全部类型</option>
          {cashKinds.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <FinList
        list={listCashDocuments}
        label="收付款单"
        query={{ kind: kind || undefined, from: period + '-01', to: monthEnd(period) }}
        onRow={(r) => setSelected(r.id)}
        onData={(d) => setRows(d.rows)}
        selected={selected}
        empty={perms.cash && !noAccount ? '这个月还没有收付款，点页面上方的“新建收付款”' : '这个月还没有收付款'}
        cols={cashColumns}
      />
      {selected && doc && (
        <CashPanel
          doc={doc}
          listRow={rows.find((r) => r.id === doc.id)}
          accountName={accountName}
          busy={confirmAction.busy}
          error={confirmAction.error}
          clearError={confirmAction.clear}
          close={() => setSelected(null)}
          {...stepper(rows, (r) => r.id, selected, (r) => setSelected(r.id))}
          open={(d) => {
            if (d === 'confirm' && !isPartyKind(doc.kind))
              void confirmAction.run(async () => {
                await confirmCashDocument(doc);
                notify(kindName(doc.kind) + '已确认。');
              });
            else setDialog(d);
          }}
          revoke={setRevokeRow}
        />
      )}
      {dialog && (
        <CashDocDialogs
          dialog={dialog}
          doc={doc}
          defaultAccount={accounts.at(0)?.id}
          close={closeDialog}
          saved={setSelected}
        />
      )}
      {creatingAccount && <AccountDialog close={() => setCreatingAccount(false)} />}
      {revokeRow && <RevokeAllocationDialog row={revokeRow} close={() => setRevokeRow(null)} />}
    </>
  );
}
