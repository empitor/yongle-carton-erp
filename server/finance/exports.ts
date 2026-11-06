import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { FinanceMonthly } from './monthly.js';
import type { FinanceSettlements } from './settlements.js';
import type { FinanceBank } from './bank.js';
import type { FinanceInvoices } from './invoices.js';
import { metricLabel, partyLabel, sourceMonthLabel, statusLabel } from './export-labels.js';
import {
  cents,
  column,
  ExportSheet,
  moneyColumn,
  singleSheet,
  textCell,
  totalCents,
  workbookBytes,
  type ExportRow,
} from './export-workbook.js';

export const periodScope = (period: string) => '期间：' + period;
const rangeScope = (from: string, to: string) => '期间：' + from + ' 至 ' + to;
const date = column('日期', 14);
const amount = moneyColumn('金额');
const item = column('项目', 34);

function detailAmount(row: ExportRow) {
  const value = cents(row.amount);
  if (value !== null) return value;
  const detail = row.detail;
  return detail &&
    typeof detail === 'object' &&
    'missing' in detail &&
    Array.isArray(detail.missing) &&
    detail.missing.includes('quantity')
    ? '缺数量或单位'
    : '缺价格';
}

/** 收付款单和手工凭证没有业务单号，只有内部编号，要说明是什么。 */
function documentLabel(row: ExportRow) {
  const number = row.number,
    detail = row.detail;
  if (typeof number === 'string' && /^\d+$/.test(number) && detail && typeof detail === 'object') {
    if ('voucherId' in detail) return '凭证 ' + number;
    if ('cashId' in detail) return '收付款单 ' + number;
  }
  return textCell(number);
}

export function flowWorkbook(period: string, rows: ExportRow[], ledger: boolean) {
  const columns = [
    date,
    column('类型'),
    column('单号', 26),
    column('往来单位', 34),
    column('单据月份'),
    column('状态'),
  ];
  if (ledger) columns.push(column('到期日', 14));
  columns.push(amount);
  if (ledger) columns.push(moneyColumn('已收付'), column('是否缺税率'));
  const metrics = [...new Set(rows.map((row) => row.metric))];
  return singleSheet(ledger ? '月度台账' : '经营明细', periodScope(period), (sheet) => {
    // 接单、送货、到货、收付不是同一口径，加在一起没有意义，只按类型分别合计。
    if (metrics.length > 1) {
      sheet.table(
        columns,
        rows.map((row) => [
          textCell(row.date),
          metricLabel(row.metric),
          documentLabel(row),
          textCell(row.party),
          sourceMonthLabel(row.source_month),
          statusLabel(row.status),
          ...(ledger ? [textCell(row.due_date)] : []),
          detailAmount(row),
          ...(ledger ? [cents(row.paid), row.missing_tax === 1 ? '是' : '否'] : []),
        ]),
      );
      sheet.table(
        [column('类型'), column('笔数'), amount],
        metrics.map((metric) => {
          const group = rows.filter((row) => row.metric === metric);
          return [metricLabel(metric), group.length, totalCents(group, (row) => row.amount)];
        }),
        undefined,
        '按类型合计',
      );
      return;
    }
    sheet.table(
      columns,
      rows.map((row) => [
        textCell(row.date),
        metricLabel(row.metric),
        documentLabel(row),
        textCell(row.party),
        sourceMonthLabel(row.source_month),
        statusLabel(row.status),
        ...(ledger ? [textCell(row.due_date)] : []),
        detailAmount(row),
        ...(ledger ? [cents(row.paid), row.missing_tax === 1 ? '是' : '否'] : []),
      ]),
      [
        rows.some((row) => row.amount == null) ? '合计（已知）' : '合计',
        null,
        null,
        null,
        null,
        null,
        ...(ledger ? [null] : []),
        totalCents(rows, (row) => row.amount),
        ...(ledger ? [totalCents(rows, (row) => row.paid)] : []),
      ],
    );
  });
}

export function monthlyWorkbook(data: ReturnType<FinanceMonthly['get']>) {
  return singleSheet('月度经营报表', periodScope(data.period), (sheet) => {
    sheet.table(
      [item, moneyColumn('理论'), moneyColumn('实际')],
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
        [column('单据月份'), amount],
        rows.map((row) => [sourceMonthLabel(row.source_month), cents(row.amount)]),
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
        [item, moneyColumn('收入'), moneyColumn('支出')],
        [],
        ['合计', income, expense],
        title,
      );
    }
    const due = data.due;
    const columns = [
      column('类型'),
      column('往来单位', 34),
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

export const reportKind = z.enum(['balance', 'profit', 'cashflow', 'trial']);
type ReportKind = z.infer<typeof reportKind>;
export const reportNames: Record<ReportKind, string> = {
  balance: '资产负债表',
  profit: '利润表',
  cashflow: '现金流量表',
  trial: '试算平衡表',
};
const reportRows = (data: ExportRow, field: string) => data[field] as ExportRow[];
const balanceLabel = (balanced: unknown) => (balanced === true ? '平衡' : '不平衡');

function addReport(book: ExcelJS.Workbook, kind: ReportKind, period: string, data: ExportRow) {
  const name = reportNames[kind];
  const sheet = new ExportSheet(
    book.addWorksheet(name),
    name,
    periodScope(period),
    data.needsReview === true,
  );
  if (kind === 'balance') {
    const columns = [item, moneyColumn('期初'), moneyColumn('期末')];
    const totals = (['assets', 'liabilities', 'equity'] as const).map((field) => {
      const label = { assets: '资产', liabilities: '负债', equity: '所有者权益' }[field];
      const rows = reportRows(data, field);
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
  } else if (kind === 'profit') {
    sheet.table(
      [item, moneyColumn('本月'), moneyColumn('本年累计')],
      reportRows(data, 'lines').map((row) => [
        textCell(row.name),
        cents(row.amount),
        cents(row.ytd),
      ]),
      ['净利润', cents(data.netProfit), cents(data.yearProfit)],
    );
  } else if (kind === 'cashflow') {
    const lines = reportRows(data, 'lines');
    const columns = [item, column('科目编码'), amount];
    for (const [key, title] of [
      ['operating', '经营活动'],
      ['investing', '投资活动'],
      ['financing', '筹资活动'],
      ['unclassified', '未归类'],
      ['transfer', '内部转账'],
    ]) {
      const rows = lines.filter((row) => row.group === key);
      if (key === 'transfer' && !rows.length) continue;
      sheet.table(
        columns,
        rows.map((row) => [
          textCell(row.item) || '未填写现金流量项目',
          textCell(row.account_code),
          cents(row.amount),
        ]),
        [title + '小计', null, totalCents(rows, (row) => row.amount)],
        title,
      );
    }
    sheet.table(
      [item, amount],
      [
        ['期初现金余额', cents(data.opening)],
        ['现金净增加额', cents(data.total)],
      ],
      ['期末现金余额', cents(data.ending)],
      '现金余额',
    );
  } else {
    const rows = reportRows(data, 'rows');
    const keys = ['opening', 'debit', 'credit', 'ending'] as const;
    sheet.table(
      [
        column('科目编码'),
        column('科目', 28),
        ...['期初', '借方', '贷方', '期末'].map(moneyColumn),
      ],
      rows.map((row) => [
        textCell(row.account_code),
        textCell(row.account_name),
        ...keys.map((key) => cents(row[key])),
      ]),
      [
        '合计（' + balanceLabel(data.balanced) + '）',
        null,
        ...keys.map((key) => totalCents(rows, (row) => row[key])),
      ],
    );
  }
}

export function reportWorkbook(
  period: string,
  reports: readonly { kind: ReportKind; data: ExportRow }[],
) {
  const book = new ExcelJS.Workbook();
  for (const { kind, data } of reports) addReport(book, kind, period, data);
  return workbookBytes(book);
}

export function statementWorkbook(
  from: string,
  to: string,
  party: string,
  kind: string,
  data: ReturnType<FinanceSettlements['statement']>,
) {
  return singleSheet(
    '往来对账单',
    `${rangeScope(from, to)}　${partyLabel(kind)}单位：${party}`,
    (sheet) => {
      sheet.table(
        [date, column('凭证号'), column('摘要', 42), column('到期日', 14), moneyColumn('发生额')],
        [
          ['', '', '期初余额', '', data.opening],
          ...data.items.map((row) => [
            textCell(row.date),
            textCell(row.number),
            textCell(row.description),
            textCell(row.due_date),
            cents(row.delta),
          ]),
          ['', '', '发生额合计', '', totalCents(data.items, (row) => row.delta)],
        ],
        ['', '', '期末余额', '', data.closing],
      );
    },
  );
}

export function bankWorkbook(from: string, to: string, data: ReturnType<FinanceBank['reconcile']>) {
  return singleSheet('银行余额调节表', rangeScope(from, to), (sheet) => {
    sheet.table(
      [item, amount],
      [
        ['账面余额', data.bookBalance],
        ['银行余额', data.bankBalance],
        ['调节后账面余额', data.adjustedBook],
        ['调节后银行余额', data.adjustedBank],
      ],
      ['调节后差额', data.difference],
    );
    sheet.note('未达账明细按截至 ' + to + ' 的余额列示。');
    sheet.table(
      [
        date,
        column('银行参考号', 26),
        column('往来单位', 28),
        column('摘要', 38),
        moneyColumn('未达金额'),
      ],
      data.bankUnmatched.map((row) => [
        textCell(row.date),
        textCell(row.reference),
        textCell(row.party),
        textCell(row.description),
        cents(row.unmatched_amount),
      ]),
      ['合计', null, null, null, totalCents(data.bankUnmatched, (row) => row.unmatched_amount)],
      '银行未达账',
    );
    sheet.table(
      [date, column('往来单位', 28), column('摘要', 38), moneyColumn('未达金额')],
      data.bookUnmatched.map((row) => [
        textCell(row.date),
        textCell(row.party_name),
        textCell(row.description),
        cents(row.amount),
      ]),
      ['合计', null, null, totalCents(data.bookUnmatched, (row) => row.amount)],
      '账面未达账',
    );
  });
}

export function taxWorkbook(data: ReturnType<FinanceInvoices['tax']>) {
  return singleSheet('税务底稿', periodScope(data.period), (sheet) => {
    const taxes = [data.payable, data.urban, data.education, data.localEducation];
    sheet.table(
      [item, amount],
      [
        ['销项税额', data.output],
        ['进项税额', data.input],
        ['进项税额转出', data.transfer],
        ['上期留抵税额', data.carryIn],
        ['期末留抵税额', data.carryOut],
        ['本期应纳增值税', data.payable],
        ['城市维护建设税', data.urban],
        ['教育费附加', data.education],
        ['地方教育附加', data.localEducation],
      ],
      ['应纳税费合计', taxes.some((tax) => tax == null) ? null : totalCents(taxes, (tax) => tax)],
    );
    if (taxes.some((tax) => tax == null)) sheet.note('空白金额表示尚未配置对应税率。');
    sheet.note('内部底稿，请以税局系统为准');
  });
}

export function depreciationWorkbook(period: string, rows: ExportRow[]) {
  return singleSheet('折旧明细', periodScope(period), (sheet) => {
    sheet.table(
      [column('编号'), column('名称', 32), column('部门', 24), moneyColumn('折旧额')],
      rows.map((row) => [
        textCell(row.number),
        textCell(row.name),
        textCell(row.department),
        cents(row.amount_cents),
      ]),
      ['合计', null, null, totalCents(rows, (row) => row.amount_cents)],
    );
  });
}

export function voucherWorkbook(period: string, rows: ExportRow[]) {
  return singleSheet('已记账凭证清单', periodScope(period), (sheet) => {
    sheet.table(
      [
        date,
        column('凭证号'),
        column('摘要', 42),
        column('状态'),
        column('制单人'),
        column('审核人'),
        column('记账人'),
        moneyColumn('借方'),
        moneyColumn('贷方'),
      ],
      rows.map((row) => [
        textCell(row.date),
        textCell(row.number),
        textCell(row.description),
        row.reversal_of == null ? statusLabel(row.status) : '已记账红冲',
        textCell(row.maker_name),
        textCell(row.approver_name),
        textCell(row.poster_name),
        cents(row.debit),
        cents(row.credit),
      ]),
      [
        '合计',
        null,
        null,
        null,
        null,
        null,
        null,
        totalCents(rows, (row) => row.debit),
        totalCents(rows, (row) => row.credit),
      ],
    );
  });
}
