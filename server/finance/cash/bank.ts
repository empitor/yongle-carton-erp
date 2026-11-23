import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dateSchema } from '../../../shared/core/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, many, one, parseStoredJson, rows } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { edit, id, pageSql, range, request, row } from '../base/query.js';
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, sheetRows, yuan } from '../base/sheet-import.js';
import { sumOf } from '../base/finance-rows.js';

/** 流水号、对方户名最多几个字，摘要最多几个字 */
const REFERENCE_MAX = 200;
const DESCRIPTION_MAX = 500;
/** 对账建议最多给几条；一条流水最多匹配几行分录 */
const SUGGESTION_LIMIT = 20;
const MATCH_MAX_ENTRIES = 200;

/** 表格里第几列是什么（从 1 数） */
const column = id.max(SHEET_MAX_COLUMNS);
const columns = z.strictObject({
  date: column,
  amount: column,
  reference: column.optional(),
  party: column.optional(),
  description: column.optional(),
});
const signed = z
  .number()
  .int()
  .refine((n) => n !== 0);
const bankLine = z.strictObject({
  date: dateSchema,
  amount: signed,
  reference: z.string().trim().max(REFERENCE_MAX).default(''),
  party: z.string().trim().max(REFERENCE_MAX).default(''),
  description: z.string().trim().max(DESCRIPTION_MAX).default(''),
});
const bankSheet = z.strictObject({
  accountId: id,
  requestId: request.shape.requestId,
  format: z.enum(['csv', 'xlsx']),
  mapping: columns,
  skipHeader: z.coerce.number().int().min(0).max(100).default(1),
});
const cashEntries = `SELECT v.id AS voucher_id,e.position,v.date,e.description,e.auxiliary_name,
  (e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount,
  a.id AS account_id,c.id AS cash_id,coalesce(c.party_name,e.auxiliary_name,'') AS party_name
  FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
  JOIN fin_cash_accounts a ON a.account_code=e.account_code
  LEFT JOIN fin_cash_documents c ON v.module_source='cash' AND v.module_id=c.id WHERE v.status='posted'`;
const entry = rows.fin_entries.shape;
/** cashEntries 一行：资金科目的一行已记账分录（红字按负数），哪个资金账户、哪张资金单、对方是谁 */
const cashEntryRow = z.object({
  voucher_id: z.number(),
  position: entry.position,
  date: z.string(),
  description: entry.description,
  auxiliary_name: entry.auxiliary_name,
  amount: z.number(),
  account_id: z.number(),
  cash_id: z.number().nullable(),
  party_name: z.string(),
});
/** 一组分录合起来对一笔流水：同一张资金单同一天的几行，entries 是 JSON 文字 */
const groupedRow = z.object({
  cash_id: z.number(),
  date: z.string(),
  party_name: z.string(),
  amount: z.number(),
  entries: z.string(),
});
const matchedEntries = z.array(z.strictObject({ voucherId: id, position: id }));
const matched = rows.fin_bank_rows.extend({ entries: matchedEntries });
const imported = z.object({ imported: z.number(), duplicates: z.number() });

export class FinanceBank {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }

  async upload(actor: Actor | null, raw: unknown, bytes: Buffer) {
    financeActor(actor, 'finance:cash');
    const v = bankSheet.parse(raw);
    const mapping = v.mapping;
    const lines = (await sheetRows(bytes, v.format, v.skipHeader)).map((c) => ({
      date: c[mapping.date - 1],
      amount: yuan(c[mapping.amount - 1] ?? ''),
      reference: mapping.reference ? c[mapping.reference - 1] : '',
      party: mapping.party ? c[mapping.party - 1] : '',
      description: mapping.description ? c[mapping.description - 1] : '',
    }));
    return this.import(actor, { accountId: v.accountId, requestId: v.requestId, rows: lines });
  }

  import(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash');
    const v = request
      .extend({ accountId: id, rows: z.array(bankLine).min(1).max(SHEET_MAX_ROWS) })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'bank.import', input: v, result: imported }, () => {
      const account = row(this.db, 'fin_cash_accounts', v.accountId);
      if (account.kind !== 'bank') financeError('流水只能导入银行账户。');
      const insert = this.db
        .prepare(`INSERT OR IGNORE INTO fin_bank_rows(account_id,date,amount_cents,reference,party_name,description,fingerprint)
        VALUES(?,?,?,?,?,?,?)`);
      let count = 0;
      for (const line of v.rows) {
        if (!line.reference && !line.description) financeError('流水号和摘要至少填写一项。');
        const identity = line.reference || createHash('sha256').update(line.description).digest('hex');
        const key = createHash('sha256')
          .update(JSON.stringify([v.accountId, line.date, line.amount, identity]))
          .digest('hex');
        const result = insert.run(v.accountId, line.date, line.amount, line.reference || null, line.party, line.description, key);
        if (result.changes) {
          count++;
          financeAudit(this.store, user, {
            action: 'import',
            entity: 'fin_bank_rows',
            id: Number(result.lastInsertRowid),
            before: null,
            after: line,
          });
        }
      }
      return { imported: count, duplicates: v.rows.length - count };
    });
  }

  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        accountId: id.optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        status: z.enum(['matched', 'unmatched']).optional(),
      })
      .parse(raw);
    return pageSql(
      this.db,
      {
        schema: rows.fin_bank_rows,
        sql: `SELECT * FROM fin_bank_rows WHERE (? IS NULL OR account_id=?)
      AND date BETWEEN ? AND ? AND (? IS NULL OR (voucher_id IS NOT NULL)=?)`,
        values: [
          q.accountId ?? null,
          q.accountId ?? null,
          q.from ?? '0000-01-01',
          q.to ?? '9999-12-31',
          q.status ?? null,
          Number(q.status === 'matched'),
        ],
        order: 'date',
      },
      raw,
    );
  }

  suggestions(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const line = row(this.db, 'fin_bank_rows', id.parse(rawId));
    const eligible = `SELECT * FROM (${cashEntries}) e WHERE e.account_id=? AND abs(julianday(e.date)-julianday(?))<=3
      AND NOT EXISTS(SELECT 1 FROM fin_bank_matches m WHERE m.voucher_id=e.voucher_id AND m.position=e.position)`;
    const args = [line.account_id, line.date, line.amount_cents, line.party_name, line.date];
    const single = many(
      this.db,
      cashEntryRow,
      `SELECT * FROM (${eligible}) e WHERE e.amount=?
      ORDER BY (e.party_name=? AND e.party_name<>'') DESC,abs(julianday(e.date)-julianday(?)),e.voucher_id LIMIT ${SUGGESTION_LIMIT}`,
      ...args,
    ).map((r) => ({ ...r, entries: null }));
    const grouped = many(
      this.db,
      groupedRow,
      `SELECT cash_id,date,party_name,sum(amount) AS amount,
      json_group_array(json_object('voucherId',voucher_id,'position',position)) AS entries
      FROM (${eligible}) WHERE cash_id IS NOT NULL GROUP BY cash_id,date,party_name
      HAVING count(*)>1 AND sum(amount)=?
      ORDER BY (party_name=? AND party_name<>'') DESC,abs(julianday(date)-julianday(?)),cash_id LIMIT ${SUGGESTION_LIMIT}`,
      ...args,
    ).map((g) => ({
      ...g,
      voucher_id: null,
      position: null,
      entries: parseStoredJson(matchedEntries, g.entries, '对账建议里一组分录（资金单 ' + g.cash_id + '）'),
    }));
    return [...single, ...grouped].slice(0, SUGGESTION_LIMIT);
  }

  match(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        voucherId: id.nullable().optional(),
        position: id.optional(),
        entries: matchedEntries.min(1).max(MATCH_MAX_ENTRIES).optional(),
      })
      .parse(raw);
    const input = { ...v, key };
    return financeWrite(this.store, user, { action: 'bank.match', input, result: matched }, () => {
      const before = row(this.db, 'fin_bank_rows', key);
      checkVersion(before, v.version);
      if (v.entries && v.voucherId !== undefined) financeError('请选择单笔或一组分录。');
      if (!v.entries && v.voucherId === undefined) financeError('请指定对账分录或明确取消匹配。');
      const entries = v.entries ?? (v.voucherId ? [{ voucherId: v.voucherId, position: id.parse(v.position) }] : []);
      const previous = many(this.db, rows.fin_bank_matches, 'SELECT * FROM fin_bank_matches WHERE bank_id=?', key);
      if (new Set(entries.map((e) => e.voucherId + ':' + e.position)).size !== entries.length)
        financeError('分录不能重复匹配。');
      this.checkEntries(key, before, entries);
      this.db.prepare('DELETE FROM fin_bank_matches WHERE bank_id=?').run(key);
      const insert = this.db.prepare('INSERT INTO fin_bank_matches(bank_id,voucher_id,position) VALUES(?,?,?)');
      for (const ref of entries) insert.run(key, ref.voucherId, ref.position);
      this.db
        .prepare('UPDATE fin_bank_rows SET voucher_id=?,entry_position=?,version=version+1 WHERE id=?')
        .run(entries.at(0)?.voucherId ?? null, entries.at(0)?.position ?? null, key);
      const after = { ...row(this.db, 'fin_bank_rows', key), entries };
      financeAudit(this.store, user, {
        action: 'match',
        entity: 'fin_bank_rows',
        id: key,
        before: { ...before, entries: previous },
        after,
      });
      return after;
    });
  }

  /** 匹配的分录：同一资金账户的已记账分录、没被别的流水对过，合计等于流水金额（取消匹配时没有分录） */
  private checkEntries(key: number, before: z.output<typeof rows.fin_bank_rows>, entries: z.output<typeof matchedEntries>) {
    let total = 0n;
    for (const ref of entries) {
      const e = one(this.db, cashEntryRow, `SELECT * FROM (${cashEntries}) WHERE voucher_id=? AND position=?`, ref.voucherId, ref.position);
      if (!e || e.account_id !== before.account_id) financeError('只可匹配同一账户的已记账分录。');
      total += BigInt(e.amount);
      if (exists(this.db, 'SELECT 1 FROM fin_bank_matches WHERE voucher_id=? AND position=? AND bank_id<>?', ref.voucherId, ref.position, key))
        financeError('该分录已对账。', 409);
    }
    if (entries.length && total !== BigInt(before.amount_cents)) financeError('分录合计须等于流水金额。');
  }

  reconcile(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = range.extend({ accountId: id, bankBalance: z.coerce.number().int() }).parse(raw);
    const account = row(this.db, 'fin_cash_accounts', q.accountId);
    const bookBalance = sumOf(
      this.db,
      `SELECT coalesce((SELECT sum(debit-credit) FROM fin_opening WHERE account_code=? AND auxiliary_id IS NULL),0)
      +coalesce((SELECT sum(amount) FROM (${cashEntries}) WHERE account_id=? AND date<=?),0) AS n`,
      account.account_code,
      q.accountId,
      q.to,
    );
    const bankUnmatched = many(
      this.db,
      rows.fin_bank_rows.extend({ unmatched_amount: z.number() }),
      `SELECT * FROM (SELECT b.*,b.amount_cents-coalesce((SELECT sum(e.amount) FROM fin_bank_matches m
          JOIN (${cashEntries}) e ON e.voucher_id=m.voucher_id AND e.position=m.position
          WHERE m.bank_id=b.id AND e.date<=?),0) AS unmatched_amount
          FROM fin_bank_rows b WHERE b.account_id=? AND b.date<=?)
          WHERE unmatched_amount<>0 ORDER BY date,id`,
      q.to,
      q.accountId,
      q.to,
    );
    const bookUnmatched = many(
      this.db,
      cashEntryRow,
      `SELECT * FROM (${cashEntries}) e WHERE account_id=? AND date<=?
      AND NOT EXISTS (SELECT 1 FROM fin_bank_matches m JOIN fin_bank_rows b ON b.id=m.bank_id
        WHERE m.voucher_id=e.voucher_id AND m.position=e.position AND b.date<=?)`,
      q.accountId,
      q.to,
      q.to,
    );
    const adjustedBook = bookBalance + bankUnmatched.reduce((n, r) => n + r.unmatched_amount, 0);
    const adjustedBank = q.bankBalance + bookUnmatched.reduce((n, r) => n + r.amount, 0);
    return {
      bookBalance,
      bankBalance: q.bankBalance,
      adjustedBook,
      adjustedBank,
      difference: adjustedBook - adjustedBank,
      bankUnmatched,
      bookUnmatched,
    };
  }
}
