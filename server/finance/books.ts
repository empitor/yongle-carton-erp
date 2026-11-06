import { z } from 'zod';
import { accountCodeSchema, auxiliaryKinds, periodSchema } from '../../shared/finance.js';
import { clampPage, parsePaging } from '../paging.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { financeActor, financeError } from './core.js';
import { cents, column, moneyColumn, singleSheet, textCell, totalCents, type ExportRow } from './export-workbook.js';

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

export class FinanceBooks {
  constructor(private readonly store: Store) {}

  private query(kind: BookKind, query: Filters) {
    const group = ['general', 'balance', 'auxiliary'].includes(kind);
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
    if (!group)
      return {
        sql: `SELECT v.id AS voucher_id,v.date,v.period,v.number,v.reversal_of,e.position,
        e.account_code,a.name AS account_name,e.description,e.auxiliary_kind,e.auxiliary_id,e.auxiliary_name,
        e.cash_flow,CASE WHEN v.reversal_of IS NULL THEN e.debit ELSE -e.debit END AS debit,
        CASE WHEN v.reversal_of IS NULL THEN e.credit ELSE -e.credit END AS credit
        FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
        JOIN fin_accounts a ON a.code=e.account_code WHERE v.status='posted' AND v.period=? ${extra}`,
        args: [query.period, ...args],
        order: 'date,number,position',
        columns: detailColumns,
      };
    const year = query.period.slice(0, 4);
    const openingYear = this.store.db
      .prepare('SELECT substr(start_period,1,4) AS year FROM fin_settings WHERE id=1')
      .get()?.year;
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
    };
  }

  read(actor: Actor | null, rawKind: unknown, rawQuery: unknown) {
    const user = financeActor(actor),
      kind = z.enum(bookKinds).parse(rawKind),
      query = filters.parse(rawQuery);
    const paging = parsePaging(rawQuery);
    const start = this.store.db
      .prepare('SELECT start_period FROM fin_settings WHERE id=1')
      .get()?.start_period;
    if (!start || query.period < String(start)) financeError('账簿期间必须在财务启用之后。');
    const { sql, args, order } = this.query(kind, query);
    const db = this.store.db;
    const total = Number(db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(...args)?.n);
    const page = clampPage(paging.page ?? 1, paging.pageSize, total);
    const rows = db
      .prepare(`SELECT * FROM (${sql}) ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, paging.pageSize, (page - 1) * paging.pageSize);
    return {
      rows,
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
    const rows: ExportRow[] = [];
    for (let page = 1; ; page++) {
      const data = this.read(actor, kind, { ...query, page, pageSize: 200 });
      rows.push(...data.rows);
      if (page * data.pageSize >= data.filteredRecords) break;
    }
    const title = bookNames[kind];
    const bytes = singleSheet(title, '期间：' + query.period, (sheet) => {
      sheet.table(
        columns.map(([, label, monetary]) => monetary ? moneyColumn(label) : column(label, label === '摘要' ? 42 : 24)),
        rows.map((row) => columns.map(([key, , monetary]) => monetary ? cents(row[key]) : textCell(row[key]))),
        columns.map(([key, , monetary], index) => monetary ? totalCents(rows, (row) => row[key]) : index === 0 ? '合计' : null),
      );
    });
    return { title, period: query.period, bytes };
  }

  audit(actor: Actor | null, rawQuery: unknown) {
    financeActor(actor, 'finance:close');
    const q = z
      .object({
        actorId: z.string().max(100).optional(),
        from: periodSchema.optional(),
        to: periodSchema.optional(),
        entity: z.string().max(80).optional(),
        recordId: z.coerce.number().int().positive().optional(),
      })
      .parse(rawQuery);
    const { page: requestedPage, pageSize } = parsePaging(rawQuery);
    const args = [
      q.actorId ?? null,
      q.actorId ?? null,
      q.from ?? null,
      q.from ?? null,
      q.to ?? null,
      q.to ?? null,
      q.entity ?? null,
      q.entity ?? null,
      q.recordId ?? null,
      q.recordId ?? null,
    ];
    const where = `FROM business_audit WHERE source='finance'
      AND (? IS NULL OR actor_id=?) AND (? IS NULL OR substr(at,1,7)>=?)
      AND (? IS NULL OR substr(at,1,7)<=?) AND (? IS NULL OR entity=?) AND (? IS NULL OR record_id=?)`;
    const total = Number(this.store.db.prepare('SELECT count(*) AS n ' + where).get(...args)?.n);
    const page = clampPage(requestedPage ?? 1, pageSize, total);
    const rows = this.store.db
      .prepare('SELECT * ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(...args, pageSize, (page - 1) * pageSize)
      .map((row) => ({ ...row, document: JSON.parse(String(row.document)) as unknown }));
    return { rows, page, pageSize, filteredRecords: total };
  }
}
