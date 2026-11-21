import { useState } from 'react';
import { FormMessage, DetailPanel, ActionBar, Facts, Hint, Section, yuan, stepper, loadingText } from '../../ui/index';
import BankSection, { type BankDialog } from './BankSection';
import { MAX_PAGE_SIZE, today } from '../../../shared/core/index';
import { FinSection, type HeadAction, type HeadFn } from '../layout';
import { FinTable, col, mon, type Col } from '../table';
import { FormDialog } from '../FormDialog';
import { ALL_CASH_ACCOUNTS, useFinPerms, useFinRead, type FinData } from '../fin-api';
import { saveCashAccount } from './cash-api';

/** 资金账户档案一行（带截至今天的余额） */
type CashAccountRow = FinData<'GET /finance/cash/accounts'>['rows'][number];
/** 资金日报一行：期初、当天收入、支出、期末 */
type DailyRow = FinData<'GET /finance/cash/daily'>['rows'][number];

/** 新建（不给 account）或编辑资金账户。收付款、账户和流水两处都从这里开。 */
export function AccountDialog({ account, close }: { account?: CashAccountRow; close: () => void }) {
  return (
    <FormDialog
      title={account ? '编辑资金账户' : '新建资金账户'}
      subtitle={account ? account.name : undefined}
      size="md"
      fields={[
        { name: 'name', label: '名称', required: true, placeholder: '例如：基本户、现金' },
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
        {
          name: 'enabled',
          label: '启用',
          type: 'check',
          hint: '停用后新建收付款时不再列出这个账户',
          // 新账户总是启用的，只有编辑时才能停用
          show: () => !!account,
        },
      ]}
      initial={
        account
          ? {
              name: account.name,
              kind: account.kind,
              accountCode: account.account_code,
              lastFour: account.last_four,
              enabled: account.enabled,
            }
          : { kind: 'bank', enabled: true, accountCode: '1002' }
      }
      submitLabel="保存账户"
      notice={account ? '资金账户已保存。' : '资金账户已新建。'}
      close={close}
      submit={(v) => saveCashAccount(v, account?.id)}
    />
  );
}

/** 资金账户详情：当天的收支、账户资料；财务负责人能编辑 */
function AccountPanel({
  row,
  full,
  date,
  edit,
  close,
  previous,
  next,
}: {
  row: DailyRow;
  /** 账户档案（列表是日报，没有账号后四位、启停） */
  full?: CashAccountRow;
  date: string;
  edit?: () => void;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  return (
    <DetailPanel
      kicker={row.kind === 'cash' ? '现金账户' : '银行账户'}
      title={row.name}
      subtitle={date + ' · 期末 ' + yuan(row.closing) + ' 元'}
      close={close}
      previous={previous}
      next={next}
      actions={
        <ActionBar
          primary={[{ label: '编辑账户', hidden: !edit, onClick: edit }]}
        />
      }
    >
      {!!row.insufficient && <Hint tone="warning">账面余额不够，可能有收付款还没确认或记账。</Hint>}
      <Section title="当天">
        <Facts
          items={[
            { label: '期初', value: yuan(row.opening) + ' 元' },
            { label: '收入', value: yuan(row.income) + ' 元' },
            { label: '支出', value: yuan(row.expense) + ' 元' },
            { label: '期末', value: yuan(row.closing) + ' 元' },
          ]}
        />
      </Section>
      <Section title="账户">
        <Facts
          items={[
            { label: '类型', value: row.kind === 'cash' ? '现金' : '银行' },
            { label: '对应科目', value: row.account_code },
            { label: '账号后四位', value: full?.last_four },
            { label: '状态', value: full ? (full.enabled ? '启用' : '停用') : '' },
          ]}
        />
      </Section>
    </DetailPanel>
  );
}

/** 资金日报的列 */
const dailyColumns: Col<DailyRow>[] = [
  col('name', '账户'),
  col('kind', '类型', { render: (r) => (r.kind === 'cash' ? '现金' : '银行') }),
  // 科目是编码，详情里有；右侧详情打开时先收
  col('account_code', '科目', { priority: 'low' }),
  mon('opening', '期初'),
  mon('income', '收入'),
  mon('expense', '支出'),
  col('closing', '期末', {
    money: true,
    render: (r) => <span className={r.insufficient ? 'fin-negative' : undefined}>{yuan(r.closing)}</span>,
  }),
];

/** 页头：没有账户时主按钮是“新建资金账户”；有银行账户、能收付款时是“导入银行流水”，新建账户进“更多” */
function accountsHead(a: {
  none: boolean;
  bank: boolean;
  cash: boolean;
  create: HeadAction | null;
  open: (d: BankDialog) => void;
}) {
  const upload = a.bank && a.cash;
  return {
    primary: !a.none && upload ? { label: '导入银行流水', onClick: () => a.open('upload') } : a.create,
    secondary: a.bank ? { label: '余额调节', onClick: () => a.open('reconcile') } : null,
    more: !a.none && upload ? [a.create] : [],
  };
}

/**
 * 账户和流水：上面是资金账户（当天日报，点一行看详情、在详情里编辑），下面是银行流水。
 * 页头主按钮按状态：没有账户时“新建资金账户”，有银行账户时“导入银行流水”。
 */
export default function AccountsTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [date, setDate] = useState(today());
  // 开着的账户窗口：account 没有是新建
  const [editing, setEditing] = useState<{ account?: CashAccountRow } | null>(null);
  const [row, setRow] = useState<DailyRow | null>(null);
  const [bankAccount, setBankAccount] = useState('');
  const [bankDialog, setBankDialog] = useState<BankDialog>(null);
  // 日期框清空时不带日期，服务端按今天算（空字符串会被当成填错的日期）
  const daily = useFinRead(['GET /finance/cash/daily', { query: { date: date || undefined, pageSize: MAX_PAGE_SIZE } }]);
  const all = useFinRead(ALL_CASH_ACCOUNTS);
  const rows = daily.data?.rows ?? [];
  const accounts = all.data?.rows ?? [];
  const banks = accounts.filter((a) => a.enabled && a.kind === 'bank');
  const firstBank = banks.at(0);
  const account = bankAccount || (firstBank ? String(firstBank.id) : '');
  const none = !!all.data && !accounts.length;
  const create = perms.close ? { label: '新建资金账户', onClick: () => setEditing({}) } : null;
  const full = row ? accounts.find((a) => a.id === row.id) : undefined;
  return (
    <>
      {head(accountsHead({ none, bank: !!account, cash: perms.cash, create, open: setBankDialog }))}
      <FinSection
        id="accounts"
        title="资金账户"
        note="当天的收支和余额"
        extra={
          <label className="fin-period">
            <span>日期</span>
            <input type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
          </label>
        }
      >
        <FormMessage>{daily.error}</FormMessage>
        {none && (
          <Hint>
            还没有资金账户。收付款、银行流水都要记在某个账户上，
            {perms.close ? '先点页面上方的“新建资金账户”建一个（例如基本户、现金）。' : '请财务负责人先新建一个。'}
          </Hint>
        )}
        <FinTable
          label="资金日报"
          rows={rows}
          empty={none ? '还没有资金账户' : loadingText()}
          onRow={setRow}
          selected={row?.id}
          cols={dailyColumns}
        />
      </FinSection>
      <BankSection
        banks={banks}
        account={account}
        setAccount={setBankAccount}
        dialog={bankDialog}
        setDialog={setBankDialog}
        canCreateAccount={perms.close}
      />
      {row && (
        <AccountPanel
          row={row}
          full={full}
          date={date}
          edit={perms.close && full ? () => setEditing({ account: full }) : undefined}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {editing && (
        <AccountDialog
          account={editing.account}
          close={() => {
            setEditing(null);
            setRow(null);
          }}
        />
      )}
    </>
  );
}
