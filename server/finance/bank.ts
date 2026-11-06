import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { dateSchema } from '../../shared/domain.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { edit, id, label, pageSql, range, request, row, safeCents } from './query.js';

const columns = z.strictObject({
  date: id.max(200),
  amount: id.max(200),
  reference: id.max(200).optional(),
  party: id.max(200).optional(),
  description: id.max(200).optional(),
});
const signed = z
  .number()
  .int()
  .refine((n) => n !== 0);
const bankLine = z.strictObject({
  date: dateSchema,
  amount: signed,
  reference: z.string().trim().max(200).default(''),
  party: z.string().trim().max(200).default(''),
  description: z.string().trim().max(500).default(''),
});
export const bankSheet = z.strictObject({
  accountId: id,
  requestId: request.shape.requestId,
  format: z.enum(['csv', 'xlsx']),
  mapping: columns.optional(),
  profileId: id.optional(),
  skipHeader: z.coerce.number().int().min(0).max(100).default(1),
});
export function yuan(value: string) {
  const match = /^([+-]?)(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value.trim().replaceAll(',', ''));
  if (!match) financeError('金额须明确填写，最多两位小数。');
  return safeCents(
    (match[1] === '-' ? -1n : 1n) *
      (BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'))),
  );
}
export async function sheetRows(bytes: Buffer, format: 'csv' | 'xlsx', skip: number) {
  if (bytes.length > 10 * 1024 * 1024) financeError('表格超过 10 MB。');
  const w = new ExcelJS.Workbook();
  if (format === 'csv') {
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      financeError('CSV 须为 UTF-8 编码。');
    }
    if (source.includes('\0')) financeError('CSV 包含非文本内容。');
    await w.csv.read(Readable.from([source]), { map: (value) => value });
  } else {
    const { validateOffice } = await import('../assistant/attachment-validation.js');
    await validateOffice(bytes, 'xlsx');
    await w.xlsx.load(bytes as unknown as Parameters<typeof w.xlsx.load>[0]);
  }
  const sheet = w.worksheets[0];
  if (!sheet || sheet.rowCount > 10000 || sheet.columnCount > 200)
    financeError('文件为空或超过 10000 行、200 列限制。');
  const rows: string[][] = [];
  sheet.eachRow((row, i) => {
    if (i <= skip) return;
    rows.push(
      Array.from({ length: sheet.columnCount }, (_, j) => {
        const value = row.getCell(j + 1).value;
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        if (typeof value === 'object' && value !== null)
          financeError('导入只接受普通文本、日期和数值单元格。');
        return value == null ? '' : String(value);
      }),
    );
  });
  return rows;
}

const cashEntries = `SELECT v.id AS voucher_id,e.position,v.date,e.description,e.auxiliary_name,
  (e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount,
  a.id AS account_id,c.id AS cash_id,coalesce(c.party_name,e.auxiliary_name,'') AS party_name
  FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
  JOIN fin_cash_accounts a ON a.account_code=e.account_code
  LEFT JOIN fin_cash_documents c ON v.module_source='cash' AND v.module_id=c.id WHERE v.status='posted'`;

export class FinanceBank {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }

  profiles(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ kind: z.enum(['bank', 'invoice']).optional() }).parse(raw);
    return pageSql(
      this.db,
      'SELECT * FROM fin_mapping_profiles WHERE (? IS NULL OR kind=?)',
      [q.kind ?? null, q.kind ?? null],
      raw,
      'id',
    );
  }

  saveProfile(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        id: id.optional(),
        version: z.number().int().positive().optional(),
        kind: z.enum(['bank', 'invoice']),
        name: label,
        mapping: z.record(z.string().max(50), id.max(200)),
      })
      .parse(raw);
    if (v.kind === 'bank') columns.parse(v.mapping);
    return financeWrite(this.store, user, 'profile.save', v, () => {
      const before = v.id ? row(this.db, 'fin_mapping_profiles', v.id) : null;
      if (before) {
        checkVersion(before, v.version ?? 0);
        if (before.kind !== v.kind) financeError('映射用途不可修改。');
      }
      if (
        this.db
          .prepare('SELECT 1 FROM fin_mapping_profiles WHERE kind=? AND name=? AND id<>?')
          .get(v.kind, v.name, v.id ?? 0)
      )
        financeError('映射名称已使用。', 409);
      const key =
        v.id ??
        Number(
          this.db
            .prepare('INSERT INTO fin_mapping_profiles(kind,name,mapping) VALUES(?,?,?)')
            .run(v.kind, v.name, JSON.stringify(v.mapping)).lastInsertRowid,
        );
      if (before)
        this.db
          .prepare('UPDATE fin_mapping_profiles SET name=?,mapping=?,version=version+1 WHERE id=?')
          .run(v.name, JSON.stringify(v.mapping), key);
      const after = row(this.db, 'fin_mapping_profiles', key);
      financeAudit(this.store, user, 'save', 'fin_mapping_profiles', key, before, after);
      return after;
    });
  }

  async upload(actor: Actor | null, raw: unknown, bytes: Buffer) {
    financeActor(actor, 'finance:cash');
    const v = bankSheet.parse(raw);
    const profile = v.profileId ? row(this.db, 'fin_mapping_profiles', v.profileId) : null;
    if (profile && profile.kind !== 'bank') financeError('请选择银行流水映射。');
    const mapping = columns.parse(
      v.mapping ?? (profile ? JSON.parse(String(profile.mapping)) : null),
    );
    const rows = (await sheetRows(bytes, v.format, v.skipHeader)).map((c) => ({
      date: c[mapping.date - 1],
      amount: yuan(c[mapping.amount - 1] ?? ''),
      reference: mapping.reference ? c[mapping.reference - 1] : '',
      party: mapping.party ? c[mapping.party - 1] : '',
      description: mapping.description ? c[mapping.description - 1] : '',
    }));
    return this.import(actor, { accountId: v.accountId, requestId: v.requestId, rows });
  }

  import(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash');
    const v = request
      .extend({ accountId: id, rows: z.array(bankLine).min(1).max(10000) })
      .parse(raw);
    return financeWrite(this.store, user, 'bank.import', v, () => {
      const account = row(this.db, 'fin_cash_accounts', v.accountId);
      if (account.kind !== 'bank') financeError('流水只能导入银行账户。');
      const insert = this.db
        .prepare(`INSERT OR IGNORE INTO fin_bank_rows(account_id,date,amount_cents,reference,party_name,description,fingerprint)
        VALUES(?,?,?,?,?,?,?)`);
      let imported = 0;
      for (const line of v.rows) {
        if (!line.reference && !line.description) financeError('流水号和摘要至少填写一项。');
        const identity =
          line.reference || createHash('sha256').update(line.description).digest('hex');
        const key = createHash('sha256')
          .update(JSON.stringify([v.accountId, line.date, line.amount, identity]))
          .digest('hex');
        const result = insert.run(
          v.accountId,
          line.date,
          line.amount,
          line.reference || null,
          line.party,
          line.description,
          key,
        );
        if (result.changes) {
          imported++;
          financeAudit(
            this.store,
            user,
            'import',
            'fin_bank_rows',
            Number(result.lastInsertRowid),
            null,
            line,
          );
        }
      }
      return { imported, duplicates: v.rows.length - imported };
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
      `SELECT * FROM fin_bank_rows WHERE (? IS NULL OR account_id=?)
      AND date BETWEEN ? AND ? AND (? IS NULL OR (voucher_id IS NOT NULL)=?)`,
      [
        q.accountId ?? null,
        q.accountId ?? null,
        q.from ?? '0000-01-01',
        q.to ?? '9999-12-31',
        q.status ?? null,
        Number(q.status === 'matched'),
      ],
      raw,
      'date',
    );
  }

  suggestions(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const line = row(this.db, 'fin_bank_rows', id.parse(rawId));
    const eligible = `SELECT * FROM (${cashEntries}) e WHERE e.account_id=? AND abs(julianday(e.date)-julianday(?))<=3
      AND NOT EXISTS(SELECT 1 FROM fin_bank_matches m WHERE m.voucher_id=e.voucher_id AND m.position=e.position)`;
    const single = this.db
      .prepare(
        `SELECT * FROM (${eligible}) e WHERE e.amount=?
      ORDER BY (e.party_name=? AND e.party_name<>'') DESC,abs(julianday(e.date)-julianday(?)),e.voucher_id LIMIT 20`,
      )
      .all(line.account_id, line.date, line.amount_cents, line.party_name, line.date)
      .map((r) => ({
        ...r,
        voucher_id: r.voucher_id,
        position: r.position,
        cash_id: r.cash_id,
        entries: null,
      }));
    const grouped = this.db
      .prepare(
        `SELECT cash_id,date,party_name,sum(amount) AS amount,
      json_group_array(json_object('voucherId',voucher_id,'position',position)) AS entries
      FROM (${eligible}) WHERE cash_id IS NOT NULL GROUP BY cash_id,date,party_name
      HAVING count(*)>1 AND sum(amount)=?
      ORDER BY (party_name=? AND party_name<>'') DESC,abs(julianday(date)-julianday(?)),cash_id LIMIT 20`,
      )
      .all(line.account_id, line.date, line.amount_cents, line.party_name, line.date)
      .map((g) => ({
        ...g,
        voucher_id: null,
        position: null,
        cash_id: g.cash_id,
        entries: JSON.parse(String(g.entries)) as { voucherId: number; position: number }[],
      }));
    return [...single, ...grouped].slice(0, 20);
  }

  match(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        voucherId: id.nullable().optional(),
        position: id.optional(),
        entries: z
          .array(z.strictObject({ voucherId: id, position: id }))
          .min(1)
          .max(200)
          .optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'bank.match', { ...v, key }, () => {
      const before = row(this.db, 'fin_bank_rows', key);
      checkVersion(before, v.version);
      if (v.entries && v.voucherId !== undefined) financeError('请选择单笔或一组分录。');
      if (!v.entries && v.voucherId === undefined) financeError('请指定对账分录或明确取消匹配。');
      const entries =
        v.entries ??
        (v.voucherId ? [{ voucherId: v.voucherId, position: id.parse(v.position) }] : []);
      const previous = this.db.prepare('SELECT * FROM fin_bank_matches WHERE bank_id=?').all(key);
      if (new Set(entries.map((e) => e.voucherId + ':' + e.position)).size !== entries.length)
        financeError('分录不能重复匹配。');
      let total = 0n;
      const find = this.db.prepare(
        `SELECT * FROM (${cashEntries}) WHERE voucher_id=? AND position=?`,
      );
      for (const ref of entries) {
        const e = find.get(ref.voucherId, ref.position);
        if (!e || e.account_id !== before.account_id)
          financeError('只可匹配同一账户的已记账分录。');
        total += BigInt(Number(e.amount));
        if (
          this.db
            .prepare(
              'SELECT 1 FROM fin_bank_matches WHERE voucher_id=? AND position=? AND bank_id<>?',
            )
            .get(ref.voucherId, ref.position, key)
        )
          financeError('该分录已对账。', 409);
      }
      if (entries.length && total !== BigInt(Number(before.amount_cents)))
        financeError('分录合计须等于流水金额。');
      this.db.prepare('DELETE FROM fin_bank_matches WHERE bank_id=?').run(key);
      const insert = this.db.prepare('INSERT INTO fin_bank_matches VALUES(?,?,?)');
      for (const ref of entries) insert.run(key, ref.voucherId, ref.position);
      this.db
        .prepare(
          'UPDATE fin_bank_rows SET voucher_id=?,entry_position=?,version=version+1 WHERE id=?',
        )
        .run(entries[0]?.voucherId ?? null, entries[0]?.position ?? null, key);
      const after = { ...row(this.db, 'fin_bank_rows', key), entries };
      financeAudit(
        this.store,
        user,
        'match',
        'fin_bank_rows',
        key,
        { ...before, entries: previous },
        after,
      );
      return after;
    });
  }

  reconcile(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = range.extend({ accountId: id, bankBalance: z.coerce.number().int() }).parse(raw);
    const account = row(this.db, 'fin_cash_accounts', q.accountId);
    const book = this.db
      .prepare(
        `SELECT coalesce((SELECT sum(debit-credit) FROM fin_opening WHERE account_code=? AND auxiliary_id IS NULL),0)
      +coalesce((SELECT sum(amount) FROM (${cashEntries}) WHERE account_id=? AND date<=?),0) AS amount`,
      )
      .get(account.account_code, q.accountId, q.to);
    const bankUnmatched = this.db
      .prepare(
        `SELECT * FROM (SELECT b.*,b.amount_cents-coalesce((SELECT sum(e.amount) FROM fin_bank_matches m
          JOIN (${cashEntries}) e ON e.voucher_id=m.voucher_id AND e.position=m.position
          WHERE m.bank_id=b.id AND e.date<=?),0) AS unmatched_amount
          FROM fin_bank_rows b WHERE b.account_id=? AND b.date<=?)
          WHERE unmatched_amount<>0 ORDER BY date,id`,
      )
      .all(q.to, q.accountId, q.to);
    const bookUnmatched = this.db
      .prepare(
        `SELECT * FROM (${cashEntries}) e WHERE account_id=? AND date<=?
      AND NOT EXISTS (SELECT 1 FROM fin_bank_matches m JOIN fin_bank_rows b ON b.id=m.bank_id
        WHERE m.voucher_id=e.voucher_id AND m.position=e.position AND b.date<=?)`,
      )
      .all(q.accountId, q.to, q.to);
    const bookBalance = Number(book?.amount),
      adjustedBook =
        bookBalance + bankUnmatched.reduce((n, r) => n + Number(r.unmatched_amount), 0);
    const adjustedBank = q.bankBalance + bookUnmatched.reduce((n, r) => n + Number(r.amount), 0);
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
