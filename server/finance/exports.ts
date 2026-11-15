import type { FinanceBank } from './bank.js';
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
} from './export-workbook.js';
import { centsText } from '../../shared/core/index.js';
import { voucherStatusName } from '../../shared/finance/index.js';
import type { FinanceStatements } from './statements.js';
import type { FinanceTax } from './vat.js';

const rangeScope = (from: string, to: string) => '期间：' + from + ' 至 ' + to;
export function statementWorkbook(
  from: string,
  to: string,
  party: string,
  kind: string,
  data: ReturnType<FinanceStatements['statement']>,
) {
  return singleSheet(
    '往来对账单',
    `${rangeScope(from, to)}　${partyLabel(kind)}单位：${party}`,
    (sheet) => {
      sheet.table(
        [dateColumn, column('凭证号'), column('摘要', widths.note), column('到期日', widths.date), moneyColumn('发生额')],
        [
          ['', '', '期初余额', '', data.opening],
          ...data.items.map((row) => [
            textCell(row.date),
            textCell(row.number),
            // 红字那行的摘要已按冲的是哪张单据生成（“红字冲销 送货单 SH-…”）；被冲销的原来那行标“已冲销”，客户一看就知道不用再付
            textCell(row.reversed ? withNote(String(row.description ?? ''), '已冲销') : row.description),
            textCell(row.due_date),
            cents(row.delta),
          ]),
          ['', '', '发生额合计', '', totalCents(data.items, (row) => row.delta)],
        ],
        ['', '', '期末余额', '', data.closing],
      );
      if (data.advance > 0)
        sheet.note(
          '期末余额已扣掉还没抵货款的' +
            (kind === 'receivable' ? '预收款 ' : '预付款 ') +
            centsText(data.advance) +
            ' 元。',
        );
    },
  );
}
/** 摘要后面补一句说明：已经以括号结尾的并进同一个括号（“（更正后重记，已冲销）”），不写成两个括号 */
const withNote = (text: string, note: string) =>
  text.endsWith('）') ? text.slice(0, -1) + '，' + note + '）' : text + '（' + note + '）';

export function bankWorkbook(from: string, to: string, data: ReturnType<FinanceBank['reconcile']>) {
  return singleSheet('银行余额调节表', rangeScope(from, to), (sheet) => {
    sheet.table(
      [itemColumn, amountColumn],
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
        dateColumn,
        column('银行参考号', widths.number),
        column('往来单位', widths.name),
        column('摘要', widths.text),
        moneyColumn('未达金额'),
      ],
      data.bankUnmatched.map((row) => [
        textCell(row.date),
        textCell(row.reference),
        textCell(row.party_name),
        textCell(row.description),
        cents(row.unmatched_amount),
      ]),
      ['合计', null, null, null, totalCents(data.bankUnmatched, (row) => row.unmatched_amount)],
      '银行未达账',
    );
    sheet.table(
      [dateColumn, column('往来单位', widths.name), column('摘要', widths.text), moneyColumn('未达金额')],
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

export function taxWorkbook(data: ReturnType<FinanceTax['worksheet']>) {
  return singleSheet('税务底稿', periodScope(data.period), (sheet) => {
    const taxes = [data.payable, data.urban, data.education, data.localEducation];
    sheet.table(
      [itemColumn, amountColumn],
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
      [column('编号'), column('名称', widths.title), column('部门', widths.medium), moneyColumn('折旧额')],
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
        dateColumn,
        column('凭证号'),
        column('摘要', widths.note),
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
        row.reversal_of == null ? (voucherStatusName(row.status) ?? textCell(row.status)) : '已记账红冲',
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
