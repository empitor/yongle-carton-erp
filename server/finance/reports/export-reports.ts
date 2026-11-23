/** 财务报表导出：资产负债表、利润表、现金流量表、试算平衡表，一张或几张放进一个工作簿 */
import ExcelJS from 'exceljs';
import { z } from 'zod';
import {
  cents,
  column,
  ExportSheet,
  moneyColumn,
  textCell,
  totalCents,
  workbookBytes,
  amountColumn,
  itemColumn,
  periodScope,
  widths,
} from '../base/export-workbook.js';
import { reportKinds } from '../../../shared/finance/index.js';
import type { BalanceReport, CashflowReport, ProfitReport } from './report-shapes.js';
import type { Report, TrialReport } from './report-sheets.js';

export const reportKind = z.enum(reportKinds);
type ReportKind = z.infer<typeof reportKind>;
export const reportNames: Record<ReportKind, string> = {
  balance: '资产负债表',
  profit: '利润表',
  cashflow: '现金流量表',
  trial: '试算平衡表',
};
const balanceLabel = (balanced: boolean) => (balanced ? '平衡' : '不平衡');

function addBalance(sheet: ExportSheet, data: BalanceReport) {
  const columns = [itemColumn, moneyColumn('期初'), moneyColumn('期末')];
  const totals = (['assets', 'liabilities', 'equity'] as const).map((field) => {
    const label = { assets: '资产', liabilities: '负债', equity: '所有者权益' }[field];
    const rows = data[field];
    const opening = totalCents(rows, (row) => row.opening),
      ending = totalCents(rows, (row) => row.amount);
    sheet.table(
      columns,
      rows.map((row) => [textCell(row.name), cents(row.opening), cents(row.amount)]),
      [label + '小计', opening, ending],
      label,
    );
    return { opening, ending };
  });
  const [assets, liabilities, equity] = totals;
  sheet.table(
    columns,
    [
      ['资产总计', assets.opening, assets.ending],
      [
        '负债和所有者权益总计',
        totalCents([liabilities, equity], (row) => row.opening),
        totalCents([liabilities, equity], (row) => row.ending),
      ],
    ],
    ['总计差额（' + balanceLabel(data.balanced) + '）', null, cents(data.difference)],
    '总计核对',
  );
}

function addProfit(sheet: ExportSheet, data: ProfitReport) {
  sheet.table(
    [itemColumn, moneyColumn('本月'), moneyColumn('本年累计')],
    data.lines.map((row) => [textCell(row.name), cents(row.amount), cents(row.ytd)]),
    ['净利润', cents(data.netProfit), cents(data.yearProfit)],
  );
}

/** 现金流量表按活动分组列，内部转账没有就不列 */
const cashflowGroups = [
  ['operating', '经营活动'],
  ['investing', '投资活动'],
  ['financing', '筹资活动'],
  ['unclassified', '未归类'],
  ['transfer', '内部转账'],
] as const;

function addCashflow(sheet: ExportSheet, data: CashflowReport) {
  const columns = [itemColumn, column('科目编码'), amountColumn];
  for (const [key, title] of cashflowGroups) {
    const rows = data.lines.filter((row) => row.group === key);
    if (key === 'transfer' && !rows.length) continue;
    sheet.table(
      columns,
      rows.map((row) => [textCell(row.item) || '未填写现金流量项目', textCell(row.account_code), cents(row.amount)]),
      [title + '小计', null, totalCents(rows, (row) => row.amount)],
      title,
    );
  }
  sheet.table(
    [itemColumn, amountColumn],
    [
      ['期初现金余额', cents(data.opening)],
      ['现金净增加额', cents(data.total)],
    ],
    ['期末现金余额', cents(data.ending)],
    '现金余额',
  );
}

function addTrial(sheet: ExportSheet, data: TrialReport) {
  const keys = ['opening', 'debit', 'credit', 'ending'] as const;
  sheet.table(
    [column('科目编码'), column('科目', widths.name), ...['期初', '借方', '贷方', '期末'].map(moneyColumn)],
    data.rows.map((row) => [textCell(row.account_code), textCell(row.account_name), ...keys.map((key) => cents(row[key]))]),
    ['合计（' + balanceLabel(data.balanced) + '）', null, ...keys.map((key) => totalCents(data.rows, (row) => row[key]))],
  );
}

function addReport(book: ExcelJS.Workbook, report: Report, period: string) {
  const name = reportNames[report.kind];
  const sheet = new ExportSheet(book.addWorksheet(name), name, periodScope(period), report.data.needsReview);
  switch (report.kind) {
    case 'balance':
      return addBalance(sheet, report.data);
    case 'profit':
      return addProfit(sheet, report.data);
    case 'cashflow':
      return addCashflow(sheet, report.data);
    case 'trial':
      return addTrial(sheet, report.data);
  }
}

export function reportWorkbook(period: string, reports: readonly Report[]) {
  const book = new ExcelJS.Workbook();
  for (const report of reports) addReport(book, report, period);
  return workbookBytes(book);
}
