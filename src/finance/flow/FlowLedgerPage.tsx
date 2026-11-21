import { useEffect, useState } from 'react';
import { FormMessage, SelectionBar, yuan, hashParams, col, type Col } from '../../ui/index';
import { missingAmountName } from '../../../shared/finance/index';
import { useEnable } from '../enable';
import TaxBatchDialog from './TaxBatchDialog';
import { financePageTitles } from '../page-titles';
import { FinHead, PeriodInput } from '../layout';
import { FinList } from '../table';
import { FlowStatus } from '../status';
import { documentName, metricNames, sourceMonthName } from '../labels';
import { exportHref, useFinPerms, useFinRead, useSyncOnOpen } from '../fin-api';
import { usePeriod } from '../page-state';
import type { SourceRow } from '../source-detail-view';
import { listMonthlyLedger } from './tax-api';
import {
  LedgerFilters,
  LedgerRowPanel,
  LedgerSummary,
  MissingTaxHint,
  isTaxable,
  ledgerQuery,
  pickColumn,
  type LedgerFilter,
} from './FlowLedgerParts';

/** 地址带 missing=1（从别处点“补税率”进来）时只看待补税率的 */
const missingInHash = () => hashParams().get('missing') === '1';

const ledgerColumns: Col<SourceRow>[] = [
  col('date', '日期'),
  // 右侧详情打开时：1440 宽收单据月份、到期日，1280 宽再收类型和往来单位（详情标题下写着）；
  // 1280 宽区域约 600px，带勾选列时日期、单号、往来单位、状态、金额估算约 620px 放不下。日期、单号、状态、金额一直显示
  col('metric', '类型', { render: (r) => metricNames[r.metric] || r.metric, priority: 'mid' }),
  col('number', '单号', { render: documentName }),
  col('party', '往来单位', { wrap: true, priority: 'mid' }),
  col('source_month', '单据月份', { render: (r) => sourceMonthName(r.source_month), priority: 'low' }),
  col('status', '状态', { render: (r) => <FlowStatus row={r} /> }),
  col('due_date', '到期日', { render: (r) => r.due_date || '—', priority: 'low' }),
  // 没算进理论金额的照明细写缺的是什么：缺数量或单位、缺价格
  col('amount', '金额 / 元', {
    money: true,
    render: (r) => (r.amount === null ? missingAmountName(r.detail) : yuan(r.amount)),
  }),
];
/** 一行的键：类型、编号和在这一页的位置（不同来源的编号会重） */
const rowKey = (r: SourceRow, index: number) => r.metric + ':' + String(r.id) + ':' + index;

/** 地址里的 missing=1 跟着变：已经在台账时再点“补税率”链接，也切到待补税率 */
function useLedgerFilter() {
  const [filter, setFilter] = useState<LedgerFilter>(() => ({
    missing: missingInHash(),
    metric: '',
    sourceMonth: '',
  }));
  useEffect(() => {
    const listener = () => {
      if (missingInHash()) setFilter((f) => ({ ...f, missing: true }));
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  return [filter, setFilter] as const;
}

/**
 * 月度台账：当月每一笔接单、送货、到货、收付。缺税率不卡业务，理论金额先进账，
 * 这里一个“补税率”主按钮：勾了几张就补这几张，没勾就按单位补整月。
 */
export default function FlowLedgerPage() {
  const [period, setPeriod] = usePeriod();
  const perms = useFinPerms();
  const enable = useEnable();
  const [filter, setFilter] = useLedgerFilter();
  const [row, setRow] = useState<SourceRow | null>(null);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [dialog, setDialog] = useState<'picked' | 'party' | null>(null);
  // 换月份、刚启用时再补扫；补扫到新单据时会让财务页面重读，台账跟着刷新
  const sync = useSyncOnOpen(period + ':' + String(enable.enabled));
  const query = ledgerQuery(period, filter);
  const flow = useFinRead(['GET /finance/monthly-ledger', { query: { period, pageSize: 1 } }]);
  const s = flow.data?.summary;
  const missingCount = s?.missingTax ?? 0;
  // 能补的：财务启用后登记进来的单据（有编号），而且这个账号能改财务
  const canFill = perms.edit && enable.enabled;
  const taxable = canFill ? rows.filter(isTaxable) : [];
  const clear = () => setPicked([]);
  // 改了月份、看哪些、单据类型都清掉勾选；单据月份照原样不清
  const change = (patch: Partial<LedgerFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    if (!('sourceMonth' in patch)) clear();
  };
  const primary =
    enable.action ??
    (canFill && missingCount > 0 && !picked.length
      ? { label: '补税率（' + missingCount + '）', onClick: () => setDialog('party') }
      : null);
  return (
    <div className="fin-page">
      <FinHead
        title={financePageTitles['finance-flow']}
        primary={primary}
        more={[{ label: '导出台账', href: exportHref('/monthly-ledger/export', query), download: true }]}
      >
        <PeriodInput
          value={period}
          onChange={(v) => {
            setPeriod(v);
            clear();
          }}
        />
      </FinHead>
      <FormMessage close={sync.clear}>{sync.error}</FormMessage>
      <LedgerSummary s={s} missingCount={missingCount} />
      <MissingTaxHint missingCount={missingCount} enable={enable} canEdit={perms.edit} />
      <LedgerFilters filter={filter} change={change} missingCount={missingCount} />
      <FinList
        list={listMonthlyLedger}
        label="月度台账"
        query={query}
        onData={(d) => setRows(d.rows)}
        rowKey={rowKey}
        selected={row ? rowKey(row, rows.indexOf(row)) : null}
        onRow={setRow}
        empty={filter.missing ? '这个月没有待补税率的单据' : '这个月没有符合条件的单据'}
        cols={[...(taxable.length ? [pickColumn(taxable, picked, setPicked)] : []), ...ledgerColumns]}
      />
      <SelectionBar
        count={picked.length}
        unit="张"
        note="只改财务记录，单据原件不变"
        primary={{ label: '补税率', onClick: () => setDialog('picked') }}
        onClear={clear}
      />
      {row && <LedgerRowPanel row={row} rows={rows} setRow={setRow} enable={enable} />}
      {dialog === 'picked' && (
        <TaxBatchDialog picked={picked} period={period} close={() => setDialog(null)} done={clear} />
      )}
      {dialog === 'party' && <TaxBatchDialog period={period} close={() => setDialog(null)} />}
      {enable.dialog}
    </div>
  );
}
