import { z } from 'zod';
import { accountCodeSchema, auxiliaryKinds, periodSchema } from '../../shared/finance/index.js';
import { allPages } from './query.js';
import { clampPage, count, many, one, parsePaging, rows } from '../core/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { financeActor, financeError } from './core.js';
import { cents, column, moneyColumn, singleSheet, textCell, totalCents, widths, type ExportRow } from './export-workbook.js';
import { yearOf } from './days.js';

const bookKinds = ['general', 'detail', 'journal', 'balance', 'auxiliary', 'cash', 'bank'] as const;
type BookKind = (typeof bookKinds)[number];
const filters = z.object({
  period: periodSchema,
  account: accountCodeSchema.optional(),
  auxiliaryKind: z.enum(auxiliaryKinds).optional(),
  auxiliaryId: z.string().trim().min(1).max(100).optional(),
});
type Filters = z.infer<typeof filters>;

type BookColumn = [key: string, title: string, money?: true];
const detailColumns: BookColumn[] = [
  ['date', '日期'],
  ['number', '凭证号'],
  ['account_code', '科目编码'],
  ['account_name', '科目'],
  ['description', '摘要'],
  ['auxiliary_name', '辅助项'],
  ['debit', '借方（元）', true],
  ['credit', '贷方（元）', true],
];
const balanceColumns: BookColumn[] = [
  ['account_code', '科目编码'],
  ['account_name', '科目'],
  ['auxiliary_name', '辅助项'],
  ['opening', '期初借方净额（元）', true],
  ['debit', '本期借方（元）', true],
  ['credit', '本期贷方（元）', true],
  ['year_debit', '本年借方（元）', true],
  ['year_credit', '本年贷方（元）', true],
  ['ending', '期末借方净额（元）', true],
];
const bookNames: Record<BookKind, string> = {
  general: '总账', detail: '明细账', journal: '序时账', balance: '科目余额表',
  auxiliary: '辅助明细账', cash: '现金日记账', bank: '银行存款日记账',
};
const entry = rows.fin_entries.shape;
const voucher = rows.fin_vouchers.shape;
/** 明细账、序时账、日记账一行：一条分录，红字凭证的金额取负 */
const detailRow = z.object({
  voucher_id: entry.voucher_id,
  date: voucher.date,
  period: voucher.period,
  number: voucher.number,
  reversal_of: voucher.reversal_of,
  position: entry.position,
  account_code: entry.account_code,
  account_name: rows.fin_accounts.shape.name,
  description: entry.description,
  auxiliary_kind: entry.auxiliary_kind,
  auxiliary_id: entry.auxiliary_id,
  auxiliary_name: entry.auxiliary_name,
  cash_flow: entry.cash_flow,
  debit: z.number(),
  credit: z.number(),
});
/** 总账、科目余额表、辅助明细账一行：一个科目（按辅助项分开时一个辅助项）期初、本期、本年和期末 */
const balanceRow = z.object({
  account_code: entry.account_code,
  account_name: rows.fin_accounts.shape.name,
  auxiliary_kind: z.string().nullable(),
  auxiliary_id: z.string().nullable(),
  auxiliary_name: z.string().nullable(),
  opening: z.number(),
  debit: z.number(),
  credit: z.number(),
  year_debit: z.number(),
  year_credit: z.number(),
  ending: z.number(),
});
type DetailRow = z.output<typeof detailRow>;
type BalanceRow = z.output<typeof balanceRow>;
/** 按科目汇总的几种账簿 */
const groupedBooks = ['general', 'balance', 'auxiliary'] as const;
type GroupedBook = (typeof groupedBooks)[number];
/** 一页账簿：行、分页、期间、谁在看 */
type BookPage<Row> = { rows: Row[]; page: number; pageSize: number; filteredRecords: number; period: string; viewer: string };
const startPeriod = rows.fin_settings.pick({ start_period: true });
const openingYearRow = z.object({ year: z.string().nullable() });

/** 明细账、序时账、日记账：这个期间已记账凭证的分录，extra、args 是科目、现金银行、辅助项的筛选 */
function detailQuery(period: string, extra: string, args: (string | null)[]) {
  return {
    sql: `SELECT v.id AS voucher_id,v.date,v.period,v.number,v.reversal_of,e.position,
        e.account_code,a.name AS account_name,e.description,e.auxiliary_kind,e.auxiliary_id,e.auxiliary_name,
        e.cash_flow,CASE WHEN v.reversal_of IS NULL THEN e.debit ELSE -e.debit END AS debit,
        CASE WHEN v.reversal_of IS NULL THEN e.credit ELSE -e.credit END AS credit
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
        JOIN fin_accounts a ON a.code=e.account_code WHERE v.status='posted' AND v.period=? ${extra}`,
    args: [period, ...args],
    order: 'date,number,position',
    columns: detailColumns,
    schema: detailRow,
  };
}

export class FinanceBooks {
  constructor(private readonly store: Store) {}

  private query(kind: BookKind, query: Filters) {
    const group = groupedBooks.some((k) => k === kind);
    const auxiliary =
      kind === 'auxiliary' || query.auxiliaryKind !== undefined || query.auxiliaryId !== undefined;
    const account = query.account ? query.account + '%' : null;
    const cashKind = kind === 'cash' || kind === 'bank' ? kind : null;
    const extra = `AND (? IS NULL OR a.code LIKE ?)
      AND (? IS NULL OR a.cash_kind=?)
      AND (? IS NULL OR e.auxiliary_kind=?)
      AND (? IS NULL OR e.auxiliary_id=?)`;
    const args = [
      account,
      account,
      cashKind,
      cashKind,
      query.auxiliaryKind ?? null,
      query.auxiliaryKind ?? null,
      query.auxiliaryId ?? null,
      query.auxiliaryId ?? null,
    ];
    if (!group) return detailQuery(query.period, extra, args);
    const year = yearOf(query.period);
    const openingYear = one(
      this.store.db,
      openingYearRow,
      'SELECT substr(start_period,1,4) AS year FROM fin_settings WHERE id=1',
    )?.year;
    const dimension = auxiliary ? 'auxiliary_kind,auxiliary_id' : 'NULL,NULL';
    return {
      sql: `WITH activity AS (
        SELECT e.account_code,a.name AS account_name,e.auxiliary_kind,e.auxiliary_id,e.auxiliary_name,
          e.debit-e.credit AS opening,0 AS debit,0 AS credit,
          CASE WHEN ? THEN e.year_debit ELSE 0 END AS year_debit,
          CASE WHEN ? THEN e.year_credit ELSE 0 END AS year_credit
        FROM fin_opening e JOIN fin_accounts a ON a.code=e.account_code
        WHERE (? = (e.auxiliary_id IS NOT NULL)) ${extra}
        UNION ALL
        SELECT e.account_code,a.name,e.auxiliary_kind,e.auxiliary_id,e.auxiliary_name,
          CASE WHEN v.period<? THEN sign*(e.debit-e.credit) ELSE 0 END,
          CASE WHEN v.period=? THEN sign*e.debit ELSE 0 END,
          CASE WHEN v.period=? THEN sign*e.credit ELSE 0 END,
          CASE WHEN substr(v.period,1,4)=? THEN sign*e.debit ELSE 0 END,
          CASE WHEN substr(v.period,1,4)=? THEN sign*e.credit ELSE 0 END
        FROM fin_entries e JOIN (SELECT *,CASE WHEN reversal_of IS NULL THEN 1 ELSE -1 END AS sign
          FROM fin_vouchers WHERE status='posted' AND period<=?) v ON v.id=e.voucher_id
        JOIN fin_accounts a ON a.code=e.account_code WHERE (?=0 OR e.auxiliary_id IS NOT NULL) ${extra}
      )
      SELECT account_code,account_name,${auxiliary ? 'auxiliary_kind,auxiliary_id,max(auxiliary_name)' : 'NULL AS auxiliary_kind,NULL AS auxiliary_id,NULL'}
        AS auxiliary_name,sum(opening) AS opening,sum(debit) AS debit,sum(credit) AS credit,
        sum(year_debit) AS year_debit,sum(year_credit) AS year_credit,
        sum(opening+debit-credit) AS ending
      FROM activity GROUP BY account_code, ${dimension}`,
      args: [
        Number(year === openingYear),
        Number(year === openingYear),
        Number(auxiliary),
        ...args,
        query.period,
        query.period,
        query.period,
        year,
        year,
        query.period,
        Number(auxiliary),
        ...args,
      ],
      order: 'account_code,auxiliary_kind,auxiliary_id',
      columns: balanceColumns,
      schema: balanceRow,
    };
  }

  /** 读一页账簿：总账、科目余额表、辅助明细账按科目汇总（BalanceRow），明细账、序时账、日记账逐条分录（DetailRow） */
  read(actor: Actor | null, rawKind: GroupedBook, rawQuery: unknown): BookPage<BalanceRow>;
  read(actor: Actor | null, rawKind: Exclude<BookKind, GroupedBook>, rawQuery: unknown): BookPage<DetailRow>;
  read(actor: Actor | null, rawKind: unknown, rawQuery: unknown): BookPage<BalanceRow> | BookPage<DetailRow>;
  read(actor: Actor | null, rawKind: unknown, rawQuery: unknown) {
    const user = financeActor(actor),
      kind = z.enum(bookKinds).parse(rawKind),
      query = filters.parse(rawQuery);
    const paging = parsePaging(rawQuery);
    const db = this.store.db;
    const start = one(db, startPeriod, 'SELECT start_period FROM fin_settings WHERE id=1')?.start_period;
    if (!start || query.period < start) financeError('账簿期间必须在财务启用之后。');
    const { sql, args, order, schema } = this.query(kind, query);
    const total = count(db, `SELECT count(*) FROM (${sql})`, ...args);
    const page = clampPage(paging.page ?? 1, paging.pageSize, total);
    const found = many(
      db,
      schema,
      `SELECT * FROM (${sql}) ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...args,
      paging.pageSize,
      (page - 1) * paging.pageSize,
    );
    return {
      rows: found,
      page,
      pageSize: paging.pageSize,
      filteredRecords: total,
      period: query.period,
      viewer: user.id,
    };
  }

  export(actor: Actor | null, rawKind: unknown, rawQuery: unknown) {
    financeActor(actor);
    const kind = z.enum(bookKinds).parse(rawKind),
      query = filters.parse(rawQuery);
    const { columns } = this.query(kind, query);
    const rows = allPages<ExportRow>((paging) => this.read(actor, kind, { ...query, ...paging }));
    const title = bookNames[kind];
    const bytes = singleSheet(title, '期间：' + query.period, (sheet) => {
      sheet.table(
        // 导出时摘要列宽一些，别的文字列一样宽
        columns.map(([, label, monetary]) =>
          monetary ? moneyColumn(label) : column(label, label === '摘要' ? widths.note : widths.medium),
        ),
        rows.map((row) => columns.map(([key, , monetary]) => monetary ? cents(row[key]) : textCell(row[key]))),
        columns.map(([key, , monetary], index) => monetary ? totalCents(rows, (row) => row[key]) : index === 0 ? '合计' : null),
      );
    });
    return { title, period: query.period, bytes };
  }
}
