import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dateSchema } from '../../shared/domain.js';
import { positiveQuantity, quantityUnits, quantityString } from '../../shared/operations.js';
import { purchaseLineAmount } from '../../shared/physical-flow.js';
import { theoreticalMoney } from './amounts.js';
import { accountCodeSchema, periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { allocationSum } from './settlements.js';
import { sheetRows, yuan } from './bank.js';
import {
  edit,
  endOfMonth,
  entry,
  id,
  label,
  money,
  pageSql,
  proportion,
  request,
  row,
} from './query.js';
import { percentage, percentCents } from './terms.js';
import type { FinanceSourceSnapshot } from './source-snapshot.js';

export interface InvoiceGateway {
  available(): boolean;
}
export class OfflineInvoiceGateway implements InvoiceGateway {
  available() {
    return false;
  }
}

const direction = z.enum(['sale', 'purchase']);
const invoiceFields = z.strictObject({
  direction,
  type: label,
  number: label,
  date: dateSchema,
  partyId: id,
  taxId: z.string().trim().max(40).default(''),
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
export class FinanceInvoices {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  private add(user: Actor, v: z.infer<typeof invoiceFields>) {
    this.ledger.openPeriod(user, v.date);
    if (
      BigInt(v.net) + BigInt(v.tax) !== BigInt(v.gross) ||
      !v.net ||
      !v.gross ||
      Math.sign(v.gross) !== Math.sign(v.net) ||
      (v.tax && Math.sign(v.tax) !== Math.sign(v.gross))
    )
      financeError('不含税金额、税额、价税合计或正负方向不一致。');
    if (v.gross < 0) {
      if (!v.originalId) financeError('红票必须关联原蓝票。');
      const original = row(this.db, 'fin_invoices', v.originalId);
      const other = this.db
        .prepare(
          "SELECT coalesce(sum(gross),0) AS gross FROM fin_invoices WHERE original_id=? AND status<>'void'",
        )
        .get(v.originalId);
      if (
        Number(original.gross) <= 0 ||
        original.status === 'void' ||
        original.direction !== v.direction ||
        original.party_id !== String(v.partyId) ||
        v.date < String(original.date) ||
        Number(original.gross) + Number(other?.gross) + v.gross < 0
      )
        financeError('红票与蓝票不一致或累计红冲超过原金额。');
    } else if (v.originalId) financeError('蓝票不能关联原蓝票。');
    if (
      this.db.prepare('SELECT 1 FROM fin_invoices WHERE type=? AND number=?').get(v.type, v.number)
    )
      financeError('此类型的发票号码已存在。', 409);
    if (v.attachmentId) row(this.db, 'fin_attachments', v.attachmentId);
    const party = row(this.db, v.direction === 'sale' ? 'customers' : 'suppliers', v.partyId);
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
    financeAudit(this.store, user, 'create', 'fin_invoices', key, null, after);
    return after;
  }

  create(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      v = invoiceFields.extend({ requestId: request.shape.requestId }).parse(raw);
    return financeWrite(this.store, user, 'invoice.create', v, () => this.add(user, v));
  }

  async upload(actor: Actor | null, raw: unknown, bytes: Buffer) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        direction,
        profileId: id,
        skipHeader: z.coerce.number().int().min(0).max(100).default(1),
      })
      .parse(raw);
    const profile = row(this.db, 'fin_mapping_profiles', v.profileId);
    if (profile.kind !== 'invoice') financeError('请选择发票导入映射。');
    const mapping = z
      .strictObject({
        type: id,
        number: id,
        date: id,
        partyId: id,
        net: id,
        rate: id,
        tax: id,
        gross: id,
        taxId: id.optional(),
        originalId: id.optional(),
      })
      .parse(JSON.parse(String(profile.mapping)));
    const rows = (await sheetRows(bytes, 'xlsx', v.skipHeader)).map((c) => {
      const get = (index: number | undefined) => (index ? (c[index - 1] ?? '') : '');
      return invoiceFields.parse({
        direction: v.direction,
        type: get(mapping.type),
        number: get(mapping.number),
        date: get(mapping.date),
        partyId: get(mapping.partyId),
        taxId: get(mapping.taxId),
        net: yuan(get(mapping.net)),
        rate: get(mapping.rate).replace(/%$/, ''),
        tax: yuan(get(mapping.tax)),
        gross: yuan(get(mapping.gross)),
        originalId: get(mapping.originalId) || undefined,
      });
    });
    return financeWrite(this.store, user, 'invoice.import', { ...v, rows }, () => ({
      rows: rows.map((item) => this.add(user, item)),
    }));
  }

  list(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        direction: direction.optional(),
        period: periodSchema.optional(),
        status: z.string().max(30).optional(),
      })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT i.*,coalesce((SELECT sum(amount_cents) FROM fin_invoice_links WHERE invoice_id=i.id),0) AS linked
      FROM fin_invoices i WHERE (? IS NULL OR direction=?) AND (? IS NULL OR substr(date,1,7)=?) AND (? IS NULL OR status=?)`,
      [
        q.direction ?? null,
        q.direction ?? null,
        q.period ?? null,
        q.period ?? null,
        q.status ?? null,
        q.status ?? null,
      ],
      raw,
      'date',
    );
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const key = id.parse(rawId);
    const links = this.db
      .prepare(
        `SELECT l.*,o.date,o.amount_cents AS obligation_amount,o.event_id,coalesce(json_extract(e.snapshot,'$.doc.number'),json_extract(e.snapshot,'$.doc.reference')) AS source_number,
      json_extract(e.snapshot,'$.doc.lines') AS source_lines
      FROM fin_invoice_links l JOIN fin_obligations o ON o.id=l.obligation_id LEFT JOIN fin_events e ON e.id=o.event_id
      WHERE invoice_id=? ORDER BY obligation_id`,
      )
      .all(key)
      // 库里存千分位整数 quantity_units；页面回传关联时用的是 quantity 文字，两边要对得上。
      .map((l) =>
        Object.assign(l, {
          quantity: l.quantity_units == null ? null : quantityString(Number(l.quantity_units)),
        }),
      );
    return { invoice: row(this.db, 'fin_invoices', key), links };
  }

  link(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ links: z.array(link).max(200) }).parse(raw);
    return financeWrite(this.store, user, 'invoice.link', { ...v, key }, () => {
      const before = this.get(user, key),
        invoice = before.invoice;
      checkVersion(invoice, v.version);
      if (invoice.status !== 'draft' || Number(invoice.gross) < 0)
        financeError('只有蓝票草稿可修改关联。');
      if (
        v.links.reduce((s, r) => s + BigInt(r.amount), 0n) > BigInt(Number(invoice.gross)) ||
        new Set(v.links.map((l) => l.obligationId)).size !== v.links.length
      )
        financeError('发票关联重复或超过票面金额。');
      for (const l of v.links) {
        const o = row(this.db, 'fin_obligations', l.obligationId);
        if (
          o.party_id !== invoice.party_id ||
          o.kind !== (invoice.direction === 'sale' ? 'receivable' : 'payable') ||
          Number(o.amount_cents) <= 0 ||
          o.tax_status === 'superseded'
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
      financeAudit(this.store, user, 'link', 'fin_invoices', key, before, after);
      return after;
    });
  }

  confirm(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ counterAccount: accountCodeSchema.optional() }).parse(raw);
    return financeWrite(this.store, user, 'invoice.confirm', { ...v, key }, () => {
      const before = this.get(user, key),
        i = before.invoice;
      checkVersion(i, v.version);
      if (i.status !== 'draft') financeError('只有发票草稿可以确认。');
      const date = String(i.date),
        purchase = i.direction === 'purchase',
        description = '发票 ' + i.number;
      this.ledger.openPeriod(user, date);
      const auxiliary = {
        kind: purchase ? ('supplier' as const) : ('customer' as const),
        id: String(i.party_id),
        name: String(i.party_name),
      };
      const net = Number(i.net),
        tax = Number(i.tax),
        gross = Number(i.gross);
      const create = (entries: ReturnType<typeof entry>[]) =>
        this.ledger.createLinked(user, 'invoice', key, {
          date,
          description,
          entries,
          requestId: v.requestId,
        });
      let voucher: number | null = null;
      if (gross < 0) {
        const blue = row(this.db, 'fin_invoices', Number(i.original_id));
        if (blue.status === 'draft' || blue.status === 'void') financeError('请先确认蓝票。');
        if (
          blue.voucher_id &&
          gross === -Number(blue.gross) &&
          net === -Number(blue.net) &&
          tax === -Number(blue.tax)
        ) {
          const origin = this.ledger.get(user, blue.voucher_id).header;
          voucher = Number(
            this.ledger.reverse(
              user,
              origin.id,
              {
                version: Number(origin.version),
                requestId: 'invoice-red:' + key,
                date,
                description,
              },
              true,
            ).header.id,
          );
        } else if (blue.voucher_id || v.counterAccount) {
          if (!v.counterAccount) financeError('部分红票需明确原业务对方科目。');
          const counter = v.counterAccount;
          const entries = purchase
            ? [
                entry('2202', -gross, 0, auxiliary),
                entry(counter, 0, -net),
                ...(tax ? [entry('22210101', 0, -tax)] : []),
              ]
            : [
                entry(counter, -net, 0),
                ...(tax ? [entry('22210102', -tax, 0)] : []),
                entry('1122', 0, -gross, auxiliary),
              ];
          voucher = Number(create(entries).header.id);
        }
      } else if (
        purchase ||
        v.counterAccount ||
        before.links.some(
          (l) =>
            l.event_id &&
            this.db
              .prepare("SELECT 1 FROM fin_events WHERE id=? AND revenue_recognition='invoice'")
              .get(l.event_id),
        )
      ) {
        const counter = v.counterAccount ?? (purchase ? '1403' : '5001');
        const entries = purchase
          ? [
              entry(counter, net, 0),
              ...(tax ? [entry('22210101', tax, 0)] : []),
              entry('2202', 0, gross, auxiliary),
            ]
          : [
              entry('1122', gross, 0, auxiliary),
              entry(counter, 0, net),
              ...(tax ? [entry('22210102', 0, tax)] : []),
            ];
        if (
          before.links.length &&
          before.links.reduce((n, l) => n + Number(l.amount_cents), 0) !== gross
        )
          financeError('生成发票凭证前须明确关联全部价税金额。');
        let cumulative = 0,
          netUsed = 0;
        const adjustments = new Map<
          number,
          { cleared: number; remaining: number; estimateVoucher: number | null; invoiceNet: number }
        >();
        for (const l of before.links) {
          const o = row(this.db, 'fin_obligations', Number(l.obligation_id));
          const event = o.event_id
            ? this.db.prepare('SELECT * FROM fin_events WHERE id=?').get(o.event_id)
            : null;
          cumulative += Number(l.amount_cents);
          const apportioned = proportion(net, cumulative, gross),
            invoiceNet = apportioned - netUsed;
          netUsed = apportioned;
          if (
            !purchase &&
            (event?.revenue_recognition !== 'invoice' || event.status === 'info_pending')
          )
            financeError('开票确认收入只适用于已补齐资料、开票时确认收入的送货单。');
          if (!purchase) {
            const prior = Number(
              this.db
                .prepare(
                  `SELECT coalesce(sum(l.amount_cents),0) AS n FROM fin_invoice_links l
              JOIN fin_invoices i ON i.id=l.invoice_id WHERE l.obligation_id=? AND i.status='normal'`,
                )
                .get(o.id)?.n,
              // 被红冲掉的部分不再占开票额度，否则全额红冲后没法重新开票。
            ) - (this.redReleased([Number(o.id)], true).get(Number(o.id)) || 0);
            if (prior + Number(l.amount_cents) > Number(o.amount_cents))
              financeError('累计开票超过送货价税金额。');
            adjustments.set(Number(o.id), {
              cleared: 0,
              remaining: 0,
              estimateVoucher: null,
              invoiceNet,
            });
            continue;
          }
          if (
            !event ||
            !['arrival', 'legacy_arrival'].includes(String(event.source_kind)) ||
            event.status !== 'generated'
          )
            financeError('请先补齐到货资料并记账暂估凭证。');
          const estimate = Number(o.estimate_remaining ?? o.amount_cents);
          const estimateVoucher =
            o.estimate_remaining == null ? o.voucher_id : o.estimate_voucher_id;
          if (!estimate || !estimateVoucher) financeError('该到货单暂估已全部转回。');
          if (l.estimate_cents == null && Number(l.amount_cents) < estimate)
            financeError('部分到票须填写本次对应的原暂估金额。');
          const cleared = Number(l.estimate_cents ?? estimate);
          if (cleared > estimate) financeError('对应暂估金额超过未调差金额。');
          const original = this.ledger.get(user, estimateVoucher);
          this.ledger.reverse(
            user,
            original.header.id,
            {
              version: Number(original.header.version),
              requestId: 'invoice-estimate:' + key + ':' + o.id,
              date,
              description: '到票红冲暂估 ' + i.number,
            },
            true,
          );
          const remaining = estimate - cleared;
          let replacement: number | null = null;
          if (remaining) {
            const originalMaterial = original.entries.find((e) => Number(e.debit) > 0);
            const originalParty = original.entries.find((e) => e.auxiliary_kind === 'supplier');
            if (!originalMaterial || !originalParty) financeError('原暂估凭证科目不明确。');
            replacement = Number(
              create([
                entry(String(originalMaterial.account_code), remaining, 0),
                entry(String(originalParty.account_code), 0, remaining, auxiliary),
              ]).header.id,
            );
          }
          adjustments.set(Number(o.id), {
            cleared,
            remaining,
            estimateVoucher: replacement,
            invoiceNet,
          });
        }
        voucher = Number(create(entries).header.id);
        for (const l of before.links) {
          const o = row(this.db, 'fin_obligations', Number(l.obligation_id));
          const adjusted = adjustments.get(Number(o.id))!;
          const amount = purchase
            ? Number(o.amount_cents) - adjusted.cleared + Number(l.amount_cents)
            : Number(o.amount_cents);
          this.db
            .prepare(
              `UPDATE fin_obligations SET amount_cents=?,voucher_id=?,tax_status='known',
                estimate_voucher_id=?,estimate_remaining=?,version=version+1 WHERE id=?`,
            )
            .run(
              amount,
              voucher,
              adjusted.estimateVoucher,
              purchase ? adjusted.remaining : null,
              o.id,
            );
          this.db
            .prepare(
              'UPDATE fin_invoice_links SET estimate_cents=?,net_cents=? WHERE invoice_id=? AND obligation_id=?',
            )
            .run(purchase ? adjusted.cleared : null, adjusted.invoiceNet, key, o.id);
          if (o.event_id)
            this.db
              .prepare(
                "UPDATE fin_events SET status='generated',version=version+1 WHERE id=? AND status='waiting_invoice'",
              )
              .run(o.event_id);
          financeAudit(
            this.store,
            user,
            'invoice',
            'fin_obligations',
            Number(o.id),
            o,
            row(this.db, 'fin_obligations', Number(o.id)),
          );
        }
      }
      const status = gross < 0 ? 'red' : purchase ? 'pending_certification' : 'normal';
      this.db
        .prepare('UPDATE fin_invoices SET status=?,voucher_id=?,version=version+1 WHERE id=?')
        .run(status, voucher, key);
      const after = this.get(user, key);
      financeAudit(this.store, user, 'confirm', 'fin_invoices', key, before, after);
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
    return financeWrite(this.store, user, 'invoice.status', { ...v, key }, () => {
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
      financeAudit(this.store, user, 'status', 'fin_invoices', key, before, {
        ...after,
        reason: v.reason,
      });
      return after;
    });
  }

  /**
   * 红票冲掉的开票额度落到原蓝票关联的哪些往来上。按关联累计分摊，
   * 每笔都是整数分，合计正好等于红票额，不会逐笔截断丢掉尾差。
   */
  private redReleased(obligationIds: number[], onlyNormal = false) {
    const out = new Map<number, number>();
    if (!obligationIds.length) return out;
    const blues = this.db
      .prepare(
        `SELECT DISTINCT i.id,i.gross,coalesce((SELECT sum(-r.gross) FROM fin_invoices r
          WHERE r.original_id=i.id AND r.status NOT IN ('draft','void')),0) AS red
        FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id IN (SELECT value FROM json_each(?)) AND i.gross>0 AND ` +
          (onlyNormal ? "i.status='normal'" : "i.status NOT IN ('draft','void')"),
      )
      .all(JSON.stringify(obligationIds));
    const links = this.db.prepare(
      'SELECT obligation_id,amount_cents FROM fin_invoice_links WHERE invoice_id=? ORDER BY obligation_id',
    );
    for (const blue of blues) {
      const gross = Number(blue.gross),
        red = Math.min(Number(blue.red), gross);
      if (red <= 0) continue;
      let cumulative = 0,
        used = 0;
      for (const l of links.all(blue.id)) {
        cumulative += Number(l.amount_cents);
        const upto = proportion(red, cumulative, gross);
        out.set(Number(l.obligation_id), (out.get(Number(l.obligation_id)) || 0) + upto - used);
        used = upto;
      }
    }
    return out;
  }

  unmatched(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ kind: z.enum(['receivable', 'payable']) }).parse(raw);
    const list = pageSql(
      this.db,
      `SELECT o.*,o.amount_cents-${allocationSum('a.obligation_id=o.id', true)} AS outstanding,
      (SELECT sum(l.amount_cents) FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id=o.id AND i.status NOT IN ('draft','void')) AS invoiced,e.snapshot AS source
      FROM fin_obligations o LEFT JOIN fin_events e ON e.id=o.event_id LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind=? AND o.amount_cents>0 AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')`,
      [q.kind],
      raw,
      'date,id',
    );
    const released = this.redReleased(list.rows.map((r) => Number(r.id)));
    const net = (id: unknown, value: number) => value - (released.get(Number(id)) || 0);
    if (q.kind === 'receivable')
      return {
        ...list,
        rows: list.rows.map((o) =>
          o.invoiced == null ? o : { ...o, invoiced: net(o.id, Number(o.invoiced)) },
        ),
      };
    const ids = JSON.stringify(list.rows.map((r) => r.id));
    const linked = this.db
      .prepare(
        `SELECT l.*,i.number,i.date,i.status FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
      WHERE l.obligation_id IN (SELECT value FROM json_each(?)) AND i.status<>'void'`,
      )
      .all(ids);
    const orders = this.db
      .prepare(
        `SELECT o.id AS obligation_id,p.id,p.number,pl.id AS line_id,pl.quantity_units,pl.document
      FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
      JOIN json_each(coalesce(json_extract(e.snapshot,'$.doc.lines'),json_extract(e.snapshot,'$.doc.items'))) l
      JOIN purchase_lines pl ON pl.id=coalesce(json_extract(l.value,'$.purchaseLineId'),json_extract(l.value,'$.lineId'))
      JOIN purchases p ON p.id=pl.purchase_id WHERE o.id IN (SELECT value FROM json_each(?))`,
      )
      .all(ids);
    return {
      ...list,
      rows: list.rows.map((o) => {
        const invoices = linked.filter((l) => l.obligation_id === o.id);
        const purchases = orders
          .filter((l) => l.obligation_id === o.id)
          .map((l) => {
            const item = JSON.parse(String(l.document));
            const exact = item.priceBasis
              ? purchaseLineAmount({ ...item, quantity: quantityString(Number(l.quantity_units)) })
              : null;
            return {
              ...l,
              unit: item.unit,
              quantity_units: l.quantity_units,
              amount: exact == null ? null : theoreticalMoney([{ exact }]).gross,
            };
          });
        const source = JSON.parse(String(o.source ?? 'null')) as FinanceSourceSnapshot | null;
        const lines = source?.doc?.lines ?? source?.doc?.items ?? [];
        const sumByUnit = (items: { unit: unknown; quantity: number }[]) => {
          const result: Record<string, number> = Object.create(null);
          for (const item of items)
            if (typeof item.unit === 'string' && item.unit)
              result[item.unit] = (result[item.unit] ?? 0) + item.quantity;
          return result;
        };
        const orderedQty = sumByUnit(
          purchases.map((p) => ({ unit: p.unit, quantity: Number(p.quantity_units) })),
        );
        const stockedQty = sumByUnit(
          lines.flatMap((l) =>
            typeof l.stockedQuantity === 'string'
              ? [{ unit: l.item?.unit, quantity: quantityUnits(l.stockedQuantity) }]
              : [],
          ),
        );
        const invoiceQty = sumByUnit(
          invoices.flatMap((l) =>
            l.quantity_units == null ? [] : [{ unit: l.unit, quantity: Number(l.quantity_units) }],
          ),
        );
        const qtyDiff = (a: Record<string, number>, b: Record<string, number>) =>
          Object.keys(a).length && Object.keys(b).length
            ? [...new Set([...Object.keys(a), ...Object.keys(b)])].some(
                (unit) => a[unit] !== b[unit],
              )
            : null;
        const arrived = source?.theoretical?.gross ?? null;
        const ordered =
          purchases.length && purchases.every((p) => p.amount != null)
            ? purchases.reduce((n, p) => n + Number(p.amount), 0)
            : null;
        const invoiced = invoices.length
          ? net(o.id, invoices.reduce((n, r) => n + Number(r.amount_cents), 0))
          : null;
        return {
          ...o,
          matching: {
            purchases,
            invoices,
            orderedQty,
            stockedQty,
            invoiceQty,
            ordered,
            arrived,
            invoiced,
            orderQuantityDiff: qtyDiff(orderedQty, stockedQty),
            invoiceQuantityDiff: qtyDiff(stockedQty, invoiceQty),
            orderAmountDiff: ordered == null || arrived == null ? null : arrived - ordered,
            invoiceAmountDiff: invoiced == null || arrived == null ? null : invoiced - arrived,
          },
        };
      }),
    };
  }

  saveAttachment(actor: Actor | null, raw: unknown, bytes: Buffer) {
    const user = financeActor(actor, 'finance:edit');
    const v = request.extend({ filename: label }).parse(raw);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024 || /[/\\\r\n\0]/.test(v.filename))
      financeError('附件名称或大小不合法。');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const type =
      bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        ? 'image/png'
        : bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
          ? 'image/jpeg'
          : bytes.subarray(0, 5).toString() === '%PDF-'
            ? 'application/pdf'
            : 'application/octet-stream';
    return financeWrite(this.store, user, 'attachment.save', { ...v, sha }, () => {
      const found = this.db
        .prepare(
          'SELECT id,sha256,filename,media_type,length(bytes) AS size FROM fin_attachments WHERE sha256=?',
        )
        .get(sha);
      if (found) return { ...found };
      const key = Number(
        this.db
          .prepare(
            'INSERT INTO fin_attachments(sha256,filename,media_type,bytes,created_at) VALUES(?,?,?,?,?)',
          )
          .run(sha, v.filename, type, bytes, new Date().toISOString()).lastInsertRowid,
      );
      const result = {
        id: key,
        sha256: sha,
        filename: v.filename,
        media_type: type,
        size: bytes.length,
      };
      financeAudit(this.store, user, 'create', 'fin_attachments', key, null, result);
      return result;
    });
  }

  attachment(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    return row(this.db, 'fin_attachments', id.parse(rawId));
  }

  tax(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const { period } = z.object({ period: periodSchema }).parse(raw);
    const settings = this.db
      .prepare('SELECT taxpayer,tax_rates FROM fin_settings WHERE id=1')
      .get()!;
    const rates = JSON.parse(String(settings.tax_rates)) as Record<string, number | null>;
    const posted = this.db
      .prepare(
        `SELECT account_code,sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(credit-debit)) AS n
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.period<=?
      AND e.account_code LIKE '222101%' GROUP BY e.account_code`,
      )
      .all(period);
    const current = this.db
      .prepare(
        `SELECT account_code,sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(credit-debit)) AS n
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.period=?
      AND e.account_code LIKE '222101%' GROUP BY e.account_code`,
      )
      .all(period);
    const amount = (r: typeof posted, code: string) =>
      r.filter((v) => String(v.account_code).startsWith(code)).reduce((n, v) => n + Number(v.n), 0);
    const output = amount(current, '22210102'),
      input = -amount(current, '22210101'),
      transfer = amount(current, '22210103');
    const previous =
      amount(posted, '22210102') -
      output +
      amount(posted, '22210101') +
      input +
      amount(posted, '22210103') -
      transfer;
    const carryIn = Math.max(0, -previous);
    const estimate = output - input + transfer - carryIn;
    const payable = Math.max(0, estimate),
      carryOut = Math.max(0, -estimate);
    const rateAmount = (value: number, rate: number | null) =>
      rate == null ? null : proportion(value, rate, 10000);
    const taxable = this.db
      .prepare(
        "SELECT coalesce(sum(net),0) AS n FROM fin_invoices WHERE direction='sale' AND date BETWEEN ? AND ? AND status IN ('normal','red')",
      )
      .get(period + '-01', endOfMonth(period));
    const smallEstimate =
      rates.smallVat == null
        ? null
        : percentCents(Math.max(0, Number(taxable?.n)), String(rates.smallVat), 1, 100);
    const base = settings.taxpayer === 'small' ? smallEstimate : payable;
    return {
      period,
      taxpayer: settings.taxpayer,
      output,
      input,
      transfer,
      carryIn,
      carryOut,
      payable: base,
      rates,
      urban: base == null ? null : rateAmount(base, rates.urban),
      education: base == null ? null : rateAmount(base, rates.education),
      localEducation: base == null ? null : rateAmount(base, rates.localEducation),
      notice: '请以税局系统为准',
    };
  }
}
