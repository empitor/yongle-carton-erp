import { DetailPanel, FilterPopover, ListSummary, Hint, yuan, Segmented, stepper } from '../../ui/index';
import type { financeMetricNames } from '../../../shared/finance/index';
import { NeedEnable, useEnable } from '../enable';
import { SourceActions, SourceDetail, sourceHeader } from '../SourceDetail';
import { col, type Col } from '../table';
import { useFinPerms, type FinData } from '../fin-api';
import type { SourceRow } from '../source-detail-view';
import ResolveTax from './ResolveTax';

/* 月度台账的几块：当月合计、筛选、勾选列、一行的详情（缺税率的在详情里补）。页面在 FlowLedgerPage.tsx。 */

/** 单据类型筛选：空的是全部 */
type MetricFilter = '' | keyof typeof financeMetricNames;
const types: readonly (readonly [MetricFilter, string])[] = [
  ['', '全部类型'],
  ['theoreticalIncome', '送货'],
  ['theoreticalExpense', '到货'],
  ['actualIncome', '实收'],
  ['actualExpense', '实付'],
  ['ordered', '接单'],
];
/** 下拉选出来的类型（只会是上面几种之一） */
const metricOf = (value: string): MetricFilter => types.find(([key]) => key === value)?.[0] ?? '';

/** 这个月的合计和应收应付（还没读到时是 undefined） */
type LedgerSums = FinData<'GET /finance/monthly-ledger'>['summary'] | undefined;

export function LedgerSummary({ s, missingCount }: { s: LedgerSums; missingCount: number }) {
  return (
    <ListSummary
      items={[
        { label: '接单', value: yuan(s?.ordered) },
        { label: '送货（理论收入）', value: yuan(s?.theoreticalIncome) },
        { label: '到货（理论支出）', value: yuan(s?.theoreticalExpense) },
        {
          label: '应收余额（本月单）',
          value: yuan(s?.receivableRemaining),
          hint: '已收 ' + yuan(s?.receivablePaid),
        },
        {
          label: '应付余额（本月单）',
          value: yuan(s?.payableRemaining),
          hint: '已付 ' + yuan(s?.payablePaid),
        },
        { label: '待补税率', value: s ? missingCount + ' 张' : '—' },
      ]}
    />
  );
}

export type LedgerFilter = { missing: boolean; metric: MetricFilter; sourceMonth: string };

/** 列表和导出用同一份条件 */
export const ledgerQuery = (period: string, f: LedgerFilter) => ({
  period,
  metric: f.metric || undefined,
  missingTax: f.missing ? ('1' as const) : undefined,
  sourceMonth: f.sourceMonth || undefined,
});

/** 有待补税率的单据却补不了时说为什么：财务还没启用，或者这个账号不能改财务 */
export function MissingTaxHint({
  missingCount,
  enable,
  canEdit,
}: {
  missingCount: number;
  enable: ReturnType<typeof useEnable>;
  canEdit: boolean;
}) {
  if (!missingCount) return null;
  if (enable.known && !enable.enabled) return <NeedEnable what="补税率" canEnable={enable.canEnable} />;
  if (enable.enabled && !canEdit)
    return <Hint>有 {missingCount} 张单据待补税率，需要有财务编辑权限的人来补。不影响业务和收付款。</Hint>;
  return null;
}

/** 看全部还是只看待补税率、单据类型、单据月份；改了筛选清掉勾选 */
export function LedgerFilters({
  filter,
  change,
  missingCount,
}: {
  filter: LedgerFilter;
  change: (patch: Partial<LedgerFilter>) => void;
  missingCount: number;
}) {
  const { missing, metric, sourceMonth } = filter;
  return (
    <section className="list-filters fin-filters" aria-label="台账筛选">
      <Segmented
        className="fin-segmented"
        label="看哪些"
        value={missing ? 'missing' : ''}
        onChange={(v) => change({ missing: v === 'missing' })}
        options={[
          ['', '全部'],
          ['missing', '待补税率' + (missingCount ? ' ' + missingCount : '')],
        ]}
      />
      <select aria-label="单据类型" value={metric} onChange={(e) => change({ metric: metricOf(e.target.value) })}>
        {types.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <FilterPopover active={sourceMonth ? 1 : 0} onClear={() => change({ sourceMonth: '' })}>
        <label className="list-filter-field">
          <span>单据月份</span>
          <input
            type="month"
            aria-label="按单据月份筛选"
            value={/^\d{4}-\d{2}$/.test(sourceMonth) ? sourceMonth : ''}
            onChange={(e) => change({ sourceMonth: e.target.value })}
          />
        </label>
        <small className="fin-note">收付款按当初那张单子的月份算，例如这个月收的是上个月的货款。</small>
      </FilterPopover>
    </section>
  );
}

/** 能勾选的一行：待补税率、财务启用后登记进来（有编号） */
export type TaxableRow = SourceRow & { id: number };
export const isTaxable = (r: SourceRow): r is TaxableRow => r.missing_tax !== 0 && r.id !== null;

/** 勾选列：只有待补税率、财务启用后登记进来（有编号）的单据能勾；表头勾选本页全部 */
export function pickColumn(
  taxable: TaxableRow[],
  picked: number[],
  setPicked: (fn: (p: number[]) => number[]) => void,
): Col<SourceRow> {
  const allPicked = taxable.length > 0 && taxable.every((r) => picked.includes(r.id));
  return col(
    'pick',
    <input
      type="checkbox"
      aria-label="全选本页待补税率的单据"
      title="全选本页待补税率的单据"
      checked={allPicked}
      onChange={() => setPicked(() => (allPicked ? [] : taxable.map((r) => r.id)))}
    />,
    {
      render: (r: SourceRow) =>
        isTaxable(r) ? (
          <input
            type="checkbox"
            aria-label={'选择 ' + String(r.number)}
            checked={picked.includes(r.id)}
            onChange={(e) =>
              setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))
            }
          />
        ) : null,
    },
  );
}

/** 台账一行的详情；缺税率的：没启用先说要启用，没权限说找谁，能补的在最后一节补 */
export function LedgerRowPanel({
  row,
  rows,
  setRow,
  enable,
}: {
  row: SourceRow;
  rows: SourceRow[];
  setRow: (row: SourceRow | null) => void;
  enable: ReturnType<typeof useEnable>;
}) {
  const perms = useFinPerms();
  const missingTax = row.missing_tax > 0;
  return (
    <DetailPanel
      {...sourceHeader(row)}
      actions={<SourceActions row={row} primary={missingTax && !enable.enabled ? enable.action : null} />}
      close={() => setRow(null)}
      {...stepper(rows, (r) => r, row, setRow)}
    >
      {missingTax && !enable.enabled && <NeedEnable what="补这张单据的税率" canEnable={enable.canEnable} />}
      {missingTax && enable.enabled && !perms.edit && (
        <Hint>这张单据待补税率，需要有财务编辑权限的人来补。</Hint>
      )}
      <SourceDetail row={row} />
      {row.status === 'info_pending' && enable.enabled && (
        <ResolveTax key={row.id} row={row} done={() => setRow(null)} />
      )}
    </DetailPanel>
  );
}
