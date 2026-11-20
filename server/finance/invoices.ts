/** 发票：录入、列表、详情、关联往来、进项认证和转出、作废。确认发票见 invoice-confirm.ts。 */
import { z } from 'zod';
import { dateSchema } from '../../shared/core/index.js';
import { positiveQuantity, quantityUnits } from '../../shared/core/index.js';
import { accountCodeSchema, periodSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import { exists, rows } from '../core/index.js';
import type { Store } from '../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { partyName } from './business-source.js';
import { sumOf } from './finance-rows.js';
import { assertInvoiceableObligation, invoiceDetail, invoiceDetailSchema, reissueCapacity } from './invoice-rules.js';
import { FinanceLedger } from './ledger.js';
import { STATUS_FILTER_MAX, edit, entry, id, label, money, pageSql, request, row } from './query.js';
import { percentage } from './terms.js';
import { invoiceDirections } from './stored-values.js';

/** 纳税人识别号最多几个字 */
const TAX_ID_MAX = 40;
/** 一张发票最多关联几笔往来 */
const LINKS_MAX = 200;

const direction = z.enum(invoiceDirections);
const invoiceFields = z.strictObject({
  direction,
  type: label,
  number: label,
  date: dateSchema,
  partyId: id,
  taxId: z.string().trim().max(TAX_ID_MAX).default(''),
  net: z.number().int(),
  rate: percentage,
  tax: z.number().int(),
  gross: z.number().int(),
  originalId: id.optional(),
  attachmentId: id.optional(),
});
const link = z
  .strictObject({
    obligationId: id,
    amount: money,
    estimateAmount: money.optional(),
    quantity: positiveQuantity.optional(),
    unit: label.optional(),
  })
  .refine((v) => !!v.quantity === !!v.unit, '发票数量和单位须一起填写。');
type InvoiceFields = z.infer<typeof invoiceFields>;

/** 不含税金额 + 税额 = 价税合计，都不是 0，正负方向一致（税额是 0 的不看它的方向） */
function assertAmounts(v: InvoiceFields) {
  if (
    BigInt(v.net) + BigInt(v.tax) !== BigInt(v.gross) ||
    !v.net ||
    !v.gross ||
    Math.sign(v.gross) !== Math.sign(v.net) ||
    (v.tax && Math.sign(v.tax) !== Math.sign(v.gross))
  )
    financeError('不含税金额、税额、价税合计或正负方向不一致。');
}

export class FinanceInvoices {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  /** 红票要关联同方向、同单位、日期不早于它、还没作废的蓝票，累计红冲不超过原金额；蓝票不能关联原蓝票 */
  private assertOriginal(v: InvoiceFields) {
    if (v.gross >= 0) {
      if (v.originalId) financeError('蓝票不能关联原蓝票。');
      return;
    }
    if (!v.originalId) financeError('红票必须关联原蓝票。');
    const original = row(this.db, 'fin_invoices', v.originalId);
    const other = sumOf(
      this.db,
      "SELECT coalesce(sum(gross),0) AS n FROM fin_invoices WHERE original_id=? AND status<>'void'",
      v.originalId,
    );
    if (
      original.gross <= 0 ||
      original.status === 'void' ||
      original.direction !== v.direction ||
      original.party_id !== String(v.partyId) ||
      v.date < original.date ||
      original.gross + other + v.gross < 0
    )
      financeError('红票与蓝票不一致或累计红冲超过原金额。');
  }

  private add(user: Actor, v: InvoiceFields) {
    this.ledger.openPeriod(user, v.date);
    assertAmounts(v);
    this.assertOriginal(v);
    if (exists(this.db, 'SELECT 1 FROM fin_invoices WHERE type=? AND number=?', v.type, v.number))
      financeError('此类型的发票号码已存在。', 409);
    if (v.attachmentId) row(this.db, 'fin_attachments', v.attachmentId);
    const party = { name: partyName(this.db, v.direction === 'sale' ? 'customer' : 'supplier', v.partyId) };
    const key = Number(
      this.db
        .prepare(
          `INSERT INTO fin_invoices(direction,type,number,date,party_id,party_name,tax_id,
      net,rate,tax,gross,status,original_id,attachment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
        )
        .run(
          v.direction,
          v.type,
          v.number,
          v.date,
          String(v.partyId),
          party.name,
          v.taxId,
          v.net,
          v.rate,
          v.tax,
          v.gross,
          v.originalId ?? null,
          v.attachmentId ?? null,
        ).lastInsertRowid,
    );
    const after = row(this.db, 'fin_invoices', key);
    financeAudit(this.store, user, { action: 'create', entity: 'fin_invoices', id: key, before: null, after });
    return after;
  }

  create(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      v = invoiceFields.extend({ requestId: request.shape.requestId }).parse(raw);
    return financeWrite(this.store, user, { action: 'invoice.create', input: v, result: rows.fin_invoices }, () => this.add(user, v));
  }

  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        direction: direction.optional(),
        period: periodSchema.optional(),
        status: z.string().max(STATUS_FILTER_MAX).optional(),
      })
      .parse(raw);
    return pageSql(
      this.db,
      {
        schema: rows.fin_invoices.extend({ linked: z.number() }),
        sql: `SELECT i.*,coalesce((SELECT sum(amount_cents) FROM fin_invoice_links WHERE invoice_id=i.id),0) AS linked
      FROM fin_invoices i WHERE (? IS NULL OR direction=?) AND (? IS NULL OR substr(date,1,7)=?) AND (? IS NULL OR status=?)`,
        values: [
          q.direction ?? null,
          q.direction ?? null,
          q.period ?? null,
          q.period ?? null,
          q.status ?? null,
          q.status ?? null,
        ],
        order: 'date',
      },
      raw,
    );
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    return invoiceDetail(this.db, id.parse(rawId));
  }

  link(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ links: z.array(link).max(LINKS_MAX) }).parse(raw);
    return financeWrite(this.store, user, { action: 'invoice.link', input: { ...v, key }, result: invoiceDetailSchema }, () => {
      const before = this.get(user, key),
        invoice = before.invoice;
      checkVersion(invoice, v.version);
      if (invoice.status !== 'draft' || Number(invoice.gross) < 0)
        financeError('只有待确认的蓝票可修改关联。');
      if (
        v.links.reduce((s, r) => s + BigInt(r.amount), 0n) > BigInt(Number(invoice.gross)) ||
        new Set(v.links.map((l) => l.obligationId)).size !== v.links.length
      )
        financeError('发票关联重复或超过票面金额。');
      for (const l of v.links) {
        const o = row(this.db, 'fin_obligations', l.obligationId);
        assertInvoiceableObligation(this.db, l.obligationId, (arrival) => '到货 ' + arrival + ' 已撤销或被更正替代，不能再关联发票。');
        // 整张红冲后往来金额为 0，但还有整张红冲释放的额度时，可以关联重开的蓝票。
        const reopenable = reissueCapacity(this.db, l.obligationId, key) > 0;
        if (
          o.party_id !== invoice.party_id ||
          o.kind !== (invoice.direction === 'sale' ? 'receivable' : 'payable') ||
          (Number(o.amount_cents) <= 0 && !reopenable)
        )
          financeError('往来单方向或单位与发票不符。');
      }
      this.db.prepare('DELETE FROM fin_invoice_links WHERE invoice_id=?').run(key);
      const insert = this.db
        .prepare(`INSERT INTO fin_invoice_links(invoice_id,obligation_id,amount_cents,estimate_cents,quantity_units,unit)
        VALUES(?,?,?,?,?,?)`);
      for (const l of v.links)
        insert.run(
          key,
          l.obligationId,
          l.amount,
          l.estimateAmount ?? null,
          l.quantity ? quantityUnits(l.quantity) : null,
          l.unit ?? null,
        );
      this.db.prepare('UPDATE fin_invoices SET version=version+1 WHERE id=?').run(key);
      const after = this.get(user, key);
      financeAudit(this.store, user, { action: 'link', entity: 'fin_invoices', id: key, before, after });
      return after;
    });
  }

  status(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit
      .extend({
        status: z.enum(['certified', 'nondeductible', 'void']),
        date: dateSchema,
        counterAccount: accountCodeSchema.optional(),
        reason: label,
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'invoice.status', input: { ...v, key }, result: rows.fin_invoices }, () => {
      const before = row(this.db, 'fin_invoices', key);
      checkVersion(before, v.version);
      this.ledger.openPeriod(user, v.date);
      let transfer = null;
      if (v.status === 'void') {
        if (before.status !== 'draft') financeError('已确认发票须走红票。');
      } else {
        if (
          before.direction !== 'purchase' ||
          !['pending_certification', 'certified'].includes(String(before.status))
        )
          financeError('该发票不适用进项认证或转出。');
        if (
          before.voucher_id &&
          this.ledger.get(user, before.voucher_id).header.status !== 'posted'
        )
          financeError('请先记账发票凭证。');
        if (v.status === 'nondeductible' && Number(before.tax) > 0) {
          if (!v.counterAccount) financeError('请明确进项转出计入的科目。');
          const amount = Number(before.tax);
          transfer = this.ledger.createLinked(user, 'invoice', key, {
            date: v.date,
            description: v.reason,
            requestId: v.requestId,
            entries: [entry(v.counterAccount, amount, 0), entry('22210103', 0, amount)],
          }).header.id;
        }
      }
      this.db
        .prepare(
          'UPDATE fin_invoices SET status=?,transfer_voucher_id=?,version=version+1 WHERE id=?',
        )
        .run(v.status, transfer, key);
      const after = row(this.db, 'fin_invoices', key);
      financeAudit(this.store, user, { action: 'status', entity: 'fin_invoices', id: key, before, after: {
        ...after,
        reason: v.reason,
      } });
      return after;
    });
  }
}
