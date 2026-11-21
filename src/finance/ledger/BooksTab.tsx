import { useState } from 'react';
import VoucherPanel from './VoucherPanel';
import { hashParams, col, mon, type Col } from '../../ui/index';
import { FinList } from '../table';
import { PeriodInput, type HeadFn } from '../layout';
import { exportHref } from '../fin-api';
import { usePeriod } from '../page-state';
import { listBook } from './ledger-api';

/** 账簿的一行：总账、余额表、辅助账是汇总行，明细账、序时账、日记账是分录行 */
type BookRow = Awaited<ReturnType<typeof listBook>>['rows'][number];

const bookTypes = [
  ['balance', '余额表'],
  ['general', '总账'],
  ['detail', '明细账'],
  ['journal', '序时账'],
  ['auxiliary', '辅助账'],
  ['cash', '现金日记账'],
  ['bank', '银行日记账'],
] as const;
/** 汇总的几种账簿：一个科目（辅助账按辅助项）期初、本期、本年、期末 */
const balanceColumns = (auxiliary: boolean): Col<BookRow>[] => [
  col('account_code', '科目编码'),
  col('account_name', '科目'),
  ...(auxiliary ? [col<BookRow>('auxiliary_name', '辅助项')] : []),
  mon('opening', '期初'),
  mon('debit', '本期借方'),
  mon('credit', '本期贷方'),
  mon('year_debit', '本年借方'),
  mon('year_credit', '本年贷方'),
  mon('ending', '期末'),
];
/** 逐条分录的几种账簿 */
const entryColumns: Col<BookRow>[] = [
  col('date', '日期'),
  col('number', '凭证号', { num: true }),
  // 明细账点一行打开凭证详情：科目编码有科目名代替，辅助项详情里有，都先收
  col('account_code', '科目编码', { priority: 'low' }),
  col('account_name', '科目'),
  col('description', '摘要', { wrap: true }),
  col('auxiliary_name', '辅助项', {
    render: (r) => r.auxiliary_name || '—',
    priority: 'low',
  }),
  mon('debit', '借方'),
  mon('credit', '贷方'),
];
/** 一行的键：分录行按凭证和分录序号，汇总行按科目和辅助项 */
const bookRowKey = (r: BookRow, i: number) =>
  ('voucher_id' in r ? r.voucher_id : r.account_code) +
  ':' +
  ('position' in r ? r.position : (r.auxiliary_id ?? '')) +
  ':' +
  i;

export default function BooksTab({ head }: { head: HeadFn }) {
  const [period, setPeriod] = usePeriod();
  const [kind, setKind] = useState('balance');
  const [account, setAccount] = useState(
    () => hashParams().get('account') || '',
  );
  const [voucher, setVoucher] = useState<number | null>(null);
  const summary = ['balance', 'general', 'auxiliary'].includes(kind);
  const query = { period, account: account.trim() || undefined };
  const open = (r: BookRow) => {
    if ('voucher_id' in r) setVoucher(r.voucher_id);
  };
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        more: [
          {
            label: '导出' + (bookTypes.find(([k]) => k === kind)?.[1] ?? '账簿'),
            href: exportHref('/books/' + kind + '/export', query),
            download: true,
          },
        ],
      })}
      <div className="fin-toolbar">
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
      </div>
      <FinList
        key={kind}
        list={listBook}
        label="账簿"
        query={{ ...query, kind }}
        rowKey={bookRowKey}
        onRow={summary ? undefined : open}
        empty="这个月没有数据。只统计已记账的凭证。"
        cols={summary ? balanceColumns(kind === 'auxiliary') : entryColumns}
      />
      {voucher && <VoucherPanel id={voucher} close={() => setVoucher(null)} />}
    </>
  );
}
