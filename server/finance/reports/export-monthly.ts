/** 月度台账的两张导出表：台账明细（台账页、概览下钻）和月度汇总 */
import type { FinanceMonthly } from './monthly.js';
import {
  cents,
  column,
  moneyColumn,
  singleSheet,
  textCell,
  totalCents,
  type ExportRow,
  amountColumn,
  dateColumn,
  itemColumn,
  partyLabel,
  periodScope,
  widths,
} from '../base/export-workbook.js';
import {
  documentName,
  financeMetricNames,
  missingAmountName,
  monthlyRowStatus,
  sourceMonthName,
} from '../../../shared/finance/index.js';

const metrics: Record<string, string> = financeMetricNames;
const metricLabel = (value: unknown) =>
  Object.hasOwn(metrics, textCell(value)) ? metrics[textCell(value)] : '其他';
function detailAmount(row: ExportRow) {
  const value = cents(row.amount);
  return value !== null ? value : missingAmountName(row.detail);
}

/** 月度台账：台账页和概览下钻都导出这一张，条件由请求决定 */
export function monthlyLedgerWorkbook(period: string, rows: ExportRow[]) {
  const columns = [
    dateColumn,
    column('类型'),
    column('单号', widths.number),
    column('往来单位', widths.wide),
    column('单据月份'),
    column('状态'),
    column('到期日', widths.date),
    amountColumn,
    moneyColumn('已收付'),
    column('是否缺税率'),
  ];
  const line = (row: ExportRow) => [
    textCell(row.date),
    metricLabel(row.metric),
    documentName(row),
    textCell(row.party),
    sourceMonthName(row.source_month),
    monthlyRowStatus(row)[0],
    textCell(row.due_date),
    detailAmount(row),
    cents(row.paid),
    row.missing_tax === 1 ? '是' : '否',
  ];
  const metrics = [...new Set(rows.map((row) => row.metric))];
  return singleSheet('月度台账', periodScope(period), (sheet) => {
    // 接单、送货、到货、收付不是同一口径，加在一起没有意义，只按类型分别合计。
    if (metrics.length > 1) {
      sheet.table(columns, rows.map(line));
      sheet.table(
        [column('类型'), column('笔数'), amountColumn],
        metrics.map((metric) => {
          const group = rows.filter((row) => row.metric === metric);
          return [metricLabel(metric), group.length, totalCents(group, (row) => row.amount)];
        }),
        undefined,
        '按类型合计',
      );
      return;
    }
    sheet.table(columns, rows.map(line), [
      rows.some((row) => row.amount == null) ? '合计（已知）' : '合计',
      null,
      null,
      null,
      null,
      null,
      null,
      totalCents(rows, (row) => row.amount),
      totalCents(rows, (row) => row.paid),
    ]);
  });
}

export function monthlyWorkbook(data: ReturnType<FinanceMonthly['get']>) {
  return singleSheet('月度经营报表', periodScope(data.period), (sheet) => {
    sheet.table(
      [itemColumn, moneyColumn('理论'), moneyColumn('实际')],
      [
        ['收入', data.theoreticalIncome, data.actualIncome],
        ['支出', data.theoreticalExpense, data.actualExpense],
      ],
      ['盈亏', data.theoreticalProfit, data.actualProfit],
    );
    if (data.missingPrice || data.missingTax)
      sheet.note(
        `缺价格 ${data.missingPrice} 条，缺税率 ${data.missingTax} 条。理论汇总仅计入已有金额。`,
      );
    for (const metric of ['actualIncome', 'actualExpense'] as const) {
      const rows = data.sources.filter((row) => row.metric === metric);
      sheet.table(
        [column('单据月份'), amountColumn],
        rows.map((row) => [sourceMonthName(row.source_month), cents(row.amount)]),
        ['合计', totalCents(rows, (row) => row.amount)],
        metricLabel(metric) + '来源月份',
      );
    }
    for (const [title, income, expense] of [
      ['优惠', data.discountIncome, data.discountExpense],
      ['利息', data.interestIncome, data.interestExpense],
      ['保证金', data.depositIncome, data.depositExpense],
    ] as const) {
      sheet.table(
        [itemColumn, moneyColumn('收入'), moneyColumn('支出')],
        [],
        ['合计', income, expense],
        title,
      );
    }
    const due = data.due;
    const columns = [
      column('类型'),
      column('往来单位', widths.wide),
      moneyColumn('本期到期'),
      moneyColumn('已核销'),
      moneyColumn('未结余额'),
    ];
    for (const kind of ['receivable', 'payable'] as const) {
      const rows = due.filter((row) => row.kind === kind);
      sheet.table(
        columns,
        rows.map((row) => [
          partyLabel(row.kind),
          textCell(row.party_name),
          cents(row.due),
          cents(row.settled),
          cents(row.outstanding),
        ]),
        [
          '小计',
          null,
          totalCents(rows, (row) => row.due),
          totalCents(rows, (row) => row.settled),
          totalCents(rows, (row) => row.outstanding),
        ],
        '到期对照 · ' + partyLabel(kind),
      );
    }
  });
}
