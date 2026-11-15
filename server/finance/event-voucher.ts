/** 可记账的送货、到货事件生成凭证和往来（送货确认收入、到货暂估）。 */
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { one, rows } from '../core/index.js';
import { dateSchema } from '../../shared/core/index.js';
import type { FinanceEntry } from '../../shared/finance/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { partyOf, readEvent, redoMark, saveInstallments, assertSourceCurrent, type FinanceEvent } from './event-shared.js';
import { expectRow } from './finance-rows.js';
import { FinanceLedger } from './ledger.js';
import { edit, id as recordId, row } from './query.js';
import { documentNumber, readSnapshot, type DocumentMoney, type FinanceSourceDocument } from './source-snapshot.js';
import { financeTemplate } from './template.js';
import { bookingDate } from './periods.js';
import { readTermsSnapshot } from './terms.js';

/** 凭证上的往来单位（辅助项） */
type Party = { kind: 'customer' | 'supplier'; id: string; name: string };
/** 一张事件凭证的分录要的：记账日、摘要、金额、单据金额明细（送货要拆不含税和税额）和往来单位 */
type VoucherPlan = { delivery: boolean; description: string; amount: number; money: DocumentMoney | null; party: Party };

export class FinanceEventVouchers {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  generate(actor: Actor | null, rawId: unknown, raw: unknown, correctedDate?: string) {
    const user = financeActor(actor, 'finance:edit'),
      id = recordId.parse(rawId);
    const input = edit.parse(raw);
    return financeWrite(this.store, user, { action: 'events.generate', input: { ...input, id }, result: rows.fin_events }, () => {
      const before = readEvent(this.db, id);
      checkVersion(before, input.version);
      if (before.status === 'info_pending' && before.amount_cents) return before;
      if (before.status !== 'ready' || before.voucher_id) financeError('该事件尚不能制单。', 409);
      const snapshot = readSnapshot(before);
      const doc = expectRow(snapshot.doc, '可记账财务事件的单据快照');
      assertSourceCurrent(this.db, before);
      const delivery = before.source_kind === 'delivery';
      const party: Party = {
        kind: delivery ? 'customer' : 'supplier',
        id: String(delivery ? (doc.customerId ?? '') : (doc.supplierId ?? '')),
        name: delivery ? (doc.customerName ?? '') : (doc.supplierName ?? ''),
      };
      if (!party.id || !party.name) financeError('单据上没有客户或供应商，请先在单据里补上。');
      // 记账日：红字冲销并重做时人选的日期；否则单据日期，所在月份已结账的记到最早没结账月份的 1 号。
      // 和单据日期不同时摘要注明单据日期；到期日、分期都按单据日期加账期算，晚记账不让对方多出账期。
      const documentDate = before.date;
      const date = dateSchema.parse(correctedDate ?? bookingDate(this.db, documentDate));
      const description =
        (delivery ? '送货确认 ' : '到货暂估 ') +
        String(documentNumber(doc, before.source_id)) +
        (date === documentDate ? '' : '（单据日期 ' + documentDate + '）');
      const plan = { delivery, description, amount: Number(before.amount_cents), money: snapshot.money ?? null, party };
      const voucher = new FinanceLedger(this.store).createFromEvent(user, id, {
        requestId: input.requestId,
        date,
        description,
        entries: this.entries(plan),
      });
      this.attachObligation(user, before, doc, { date, voucherId: voucher.header.id, amount: plan.amount });
      this.db
        .prepare("UPDATE fin_events SET voucher_id=?,status='generated',version=version+1 WHERE id=?")
        .run(voucher.header.id, id);
      const after = readEvent(this.db, id);
      financeAudit(this.store, user, { action: 'generate', entity: 'fin_events', id, before, after });
      return after;
    });
  }

  /** 送货：借应收（含税），贷收入（不含税）和销项税；到货：借原材料暂估（不含税），贷应付暂估 */
  private entries({ delivery, description, amount, money, party }: VoucherPlan): FinanceEntry[] {
    const template = financeTemplate(this.store, delivery ? 'delivery.confirmed' : 'arrival.confirmed');
    const mapping = { party: template('party'), net: template('net') };
    const entry = (accountCode: string, debit: number, credit: number, auxiliary: FinanceEntry['auxiliary'] = null) => ({
      accountCode,
      description,
      debit,
      credit,
      auxiliary,
      cashFlow: null,
    });
    if (!delivery) return [entry(mapping.net, amount, 0), entry(mapping.party, 0, amount, party)];
    if (!money) financeError('送货单的财务事件快照里没有金额，请刷新后重试。', 409);
    return [
      entry(mapping.party, amount, 0, party),
      ...(money.net ? [entry(mapping.net, 0, money.net)] : []),
      ...(money.tax ? [entry(template('tax'), 0, money.tax)] : []),
    ];
  }

  /**
   * 凭证挂到往来上，记账日作往来日期：暂挂的往来，或原凭证作废了、往来还指着它的（凭证页作废已生成的凭证会清凭证号；
   * 红字冲销并重做时作废还没记账的原凭证，事件那时是“有差异”，凭证号不清，往来还指着作废凭证）接着用这一条，
   * 上面的核销、发票关联、转抵都保留；没有就新记一笔。分期按单据日期加账期算。返回往来编号。
   */
  private attachObligation(
    user: Actor,
    event: FinanceEvent,
    doc: FinanceSourceDocument,
    booking: { date: string; voucherId: number; amount: number },
  ) {
    const id = event.id;
    const terms = partyOf(this.db, event, doc, event.date);
    const provisional =
      one(
        this.db,
        rows.fin_obligations,
        `SELECT * FROM fin_obligations WHERE event_id=? AND voucher_id IS NULL
        AND tax_status<>'superseded' LIMIT 1`,
        id,
      ) ??
      one(
        this.db,
        rows.fin_obligations,
        `SELECT o.* FROM fin_obligations o JOIN fin_vouchers v ON v.id=o.voucher_id
        WHERE o.event_id=? AND v.status='void' AND o.reversal_of IS NULL AND o.tax_status<>'superseded'
        ORDER BY o.id LIMIT 1`,
        id,
      );
    let obligationId: number;
    if (provisional) {
      obligationId = provisional.id;
      this.db
        .prepare(
          // 往来日期跟着凭证换成记账日，和新建往来一个口径（到期日仍按单据日期算，暂估时已算好）
          `UPDATE fin_obligations SET voucher_id=?,amount_cents=?,date=?,
        tax_status='known',version=version+1 WHERE id=?`,
        )
        .run(booking.voucherId, booking.amount, booking.date, obligationId);
    } else
      obligationId = Number(
        this.db
          .prepare(
            `INSERT INTO fin_obligations
        (kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,terms_snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            terms.kind,
            terms.id,
            terms.name,
            booking.date,
            terms.due,
            booking.amount,
            (terms.kind === 'receivable' ? '送货确认 ' : '到货确认 ') + String(documentNumber(doc, event.source_id)) + redoMark(this.db, id),
            id,
            booking.voucherId,
            terms.snapshot,
          ).lastInsertRowid,
      );
    const termsUsed = provisional
      ? readTermsSnapshot(provisional.terms_snapshot, `fin_obligations.terms_snapshot（往来 ${provisional.id}）`)
      : terms.terms;
    saveInstallments(this.db, obligationId, booking.amount, event.date, termsUsed);
    financeAudit(this.store, user, {
      action: 'create',
      entity: 'fin_obligations',
      id: obligationId,
      before: provisional ?? null,
      after: row(this.db, 'fin_obligations', obligationId),
    });
    return obligationId;
  }
}
