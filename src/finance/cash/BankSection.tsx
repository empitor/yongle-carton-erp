import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { FormMessage, ListSummary, yuan, notify, stepper, useAction, col, mon, type Col } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { FinSection } from '../layout';
import { FinList } from '../table';
import { FormDialog } from '../FormDialog';
import type { FinData } from '../fin-api';
import type { SubmitValues } from '../form-values';
import { filled, optionOf } from '../submit-pick';
import BankRowPanel from './BankRowPanel';
import { listBankRows, readBankReconcile, uploadBankStatement } from './cash-api';

export type BankDialog = 'upload' | 'reconcile' | null;
/** 一笔银行流水 */
type BankRow = FinData<'GET /finance/bank/rows'>['rows'][number];
/** 生成的余额调节表，带上调节的起止日期 */
type Recon = FinData<'GET /finance/bank/reconcile'> & { from: string; to: string };
/** 按匹配状态筛：不选是全部 */
const matchStates = [
  ['unmatched', '未匹配'],
  ['matched', '已匹配'],
] as const;

/** 导入银行流水：选文件、填各项在第几列。 */
function BankUploadDialog({
  account,
  accountLabel,
  close,
}: {
  account: string;
  accountLabel?: string;
  close: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <FormDialog
      title="导入银行流水"
      subtitle={accountLabel}
      size="md"
      columns={3}
      note="重复的流水自动跳过。"
      submitLabel="导入流水"
      sections={[
        { title: '选文件', columns: 1 },
        {
          title: '各项在第几列',
          hint: '按银行导出文件的列号填，从 1 开始数。金额单位是元，收入为正、支出为负。',
        },
      ]}
      fields={[
        {
          name: 'file',
          label: '文件',
          required: true,
          hint: 'CSV（UTF-8）或 Excel',
          section: '选文件',
          render: () => <input ref={fileRef} type="file" accept=".csv,.xlsx" />,
        },
        { name: 'date', label: '日期在第几列', type: 'int', required: true, section: '各项在第几列' },
        { name: 'amount', label: '金额在第几列', type: 'int', required: true, section: '各项在第几列' },
        { name: 'party', label: '对方在第几列', type: 'int', section: '各项在第几列' },
        { name: 'description', label: '摘要在第几列', type: 'int', section: '各项在第几列' },
        { name: 'reference', label: '流水号在第几列', type: 'int', section: '各项在第几列' },
        { name: 'skipHeader', label: '第一行是表头', type: 'check', section: '各项在第几列' },
      ]}
      initial={{ date: 1, amount: 2, skipHeader: true }}
      close={close}
      submit={async (v) => {
        const file = fileRef.current?.files?.[0];
        if (!file) throw new Error('请选择文件。');
        const { skipHeader, ...mapping } = v;
        const result = await uploadBankStatement(
          {
            accountId: account,
            format: /\.csv$/i.test(file.name) ? 'csv' : 'xlsx',
            mapping: JSON.stringify(mapping),
            skipHeader: skipHeader ? 1 : 0,
          },
          file,
        );
        notify(
          '已导入 ' + result.imported + ' 笔流水' + (result.duplicates ? '，跳过重复 ' + result.duplicates + ' 笔。' : '。'),
        );
      }}
    />
  );
}

/** 余额调节表：生成后显示在列表上方，可以收起。 */
function ReconTable({ recon, close }: { recon: Recon; close: () => void }) {
  return (
    <section className="fin-recon" aria-label="余额调节表">
      <header>
        <h2>余额调节表</h2>
        <span className="fin-note">
          {recon.from} 至 {recon.to}
        </span>
        <button type="button" className="icon-button" aria-label="收起余额调节表" onClick={close}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <ListSummary
        items={[
          { label: '账面余额', value: yuan(recon.bookBalance) },
          { label: '银行余额', value: yuan(recon.bankBalance) },
          { label: '调节后账面', value: yuan(recon.adjustedBook) },
          { label: '调节后银行', value: yuan(recon.adjustedBank) },
          {
            label: '差额',
            value: <span className={recon.difference ? 'fin-negative' : undefined}>{yuan(recon.difference)}</span>,
          },
        ]}
      />
      <p className="fin-note">
        银行有账上没有 {recon.bankUnmatched.length} 笔，账上有银行没有 {recon.bookUnmatched.length} 笔。
      </p>
    </section>
  );
}

/** 余额调节：填起止日期和银行对账单余额，生成后交给页面显示在列表上方 */
function ReconcileDialog({
  account,
  accountLabel,
  done,
  close,
}: {
  account: string;
  accountLabel?: string;
  done: (recon: Recon) => void;
  close: () => void;
}) {
  const reconcile = async (v: SubmitValues) => {
    const bankBalance = v.bankBalance;
    if (typeof bankBalance !== 'number') throw new Error('请填写银行对账单余额。');
    const query = {
      accountId: Number(account),
      from: filled(v.from, '开始日期'),
      to: filled(v.to, '结束日期'),
      bankBalance,
    };
    done({ ...(await readBankReconcile(query)), from: query.from, to: query.to });
  };
  return (
    <FormDialog
      title="余额调节"
      subtitle={accountLabel}
      size="md"
      columns={3}
      note="生成后显示在列表上方。"
      submitLabel="生成调节表"
      fields={[
        { name: 'from', label: '开始日期', type: 'date', required: true },
        { name: 'to', label: '结束日期', type: 'date', required: true },
        { name: 'bankBalance', label: '银行对账单余额 / 元', type: 'money', required: true },
      ]}
      initial={{ from: today().slice(0, 8) + '01', to: today() }}
      close={close}
      submit={reconcile}
    />
  );
}

/** 银行流水的列 */
const bankColumns: Col<BankRow>[] = [
  col('date', '日期'),
  col('party_name', '对方', { wrap: true }),
  // 右侧详情打开时：1440 宽收流水号，1280 宽再收摘要；对方、金额、匹配一直显示
  col('description', '摘要', { wrap: true, priority: 'mid' }),
  col('reference', '流水号', { priority: 'low' }),
  mon('amount_cents', '金额 / 元'),
  col('voucher_id', '匹配', { render: (r) => (r.voucher_id ? '已匹配' : '未匹配') }),
];

/** 没有银行账户时：说明原因，能建账户的人去页头新建 */
function NoBankAccount({ canCreateAccount }: { canCreateAccount: boolean }) {
  return (
    <FinSection id="bank" title="银行流水">
      <div className="fin-empty">
        <p>
          银行流水按银行账户导入、对账。现在还没有银行类型的资金账户，
          {canCreateAccount
            ? '先点页面上方的“新建资金账户”建一个（类型选“银行”），再导入银行导出的流水文件。'
            : '请财务负责人先新建一个银行账户。'}
        </p>
      </div>
    </FinSection>
  );
}

/**
 * 银行流水：按银行账户导入、匹配凭证分录、余额调节。导入和余额调节的按钮在页头，这里只放窗口。
 * 没有银行账户时说明原因，给能建账户的人一个“新建资金账户”。
 */
export default function BankSection({
  banks,
  account,
  setAccount,
  dialog,
  setDialog,
  canCreateAccount,
}: {
  banks: readonly { id: number; name: string }[];
  account: string;
  setAccount: (id: string) => void;
  dialog: BankDialog;
  setDialog: (d: BankDialog) => void;
  canCreateAccount: boolean;
}) {
  const [status, setStatus] = useState<(typeof matchStates)[number][0] | undefined>();
  const [row, setRow] = useState<BankRow | null>(null);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [recon, setRecon] = useState<Recon | null>(null);
  const action = useAction();
  const accountLabel = banks.find((a) => String(a.id) === account)?.name;
  if (!banks.length) return <NoBankAccount canCreateAccount={canCreateAccount} />;
  return (
    <FinSection
      id="bank"
      title="银行流水"
      note="导入后逐笔匹配凭证，没匹配的不影响结账"
      extra={
        <>
          {banks.length > 1 && (
            <select aria-label="银行账户" value={account} onChange={(e) => setAccount(e.currentTarget.value)}>
              {banks.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="匹配状态"
            value={status ?? ''}
            onChange={(e) => setStatus(optionOf(e.currentTarget.value, matchStates))}
          >
            <option value="">全部</option>
            {matchStates.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </>
      }
    >
      <FormMessage close={action.clear}>{action.error}</FormMessage>
      {recon && <ReconTable recon={recon} close={() => setRecon(null)} />}
      {account && (
        <FinList
          list={listBankRows}
          label="银行流水"
          query={{ accountId: Number(account), status }}
          onRow={setRow}
          onData={(d) => setRows(d.rows)}
          selected={row?.id}
          empty={'还没有导入 ' + (accountLabel || '这个账户') + ' 的流水，点页面上方的“导入银行流水”'}
          cols={bankColumns}
        />
      )}
      {row && (
        <BankRowPanel
          row={row}
          accountName={accountLabel}
          action={action}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {dialog === 'upload' && (
        <BankUploadDialog account={account} accountLabel={accountLabel} close={() => setDialog(null)} />
      )}
      {dialog === 'reconcile' && (
        <ReconcileDialog account={account} accountLabel={accountLabel} done={setRecon} close={() => setDialog(null)} />
      )}
    </FinSection>
  );
}
