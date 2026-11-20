/**
 * 确认发票：生成发票凭证（红票冲原蓝票或另做一张，蓝票见 invoice-blue.ts），更新发票状态，
 * 红票按关联累计分摊冲减原蓝票关联的往来。
 */
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, rows } from '../core/index.js';
import { accountCodeSchema } from '../../shared/finance/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { blueInvoiceVoucher, type ConfirmContext } from './invoice-blue.js';
import { assertInvoiceableObligation, invoiceDetail, invoiceDetailSchema } from './invoice-rules.js';
import { FinanceLedger } from './ledger.js';
import { edit, entry, id, row } from './query.js';
import { redReleasedByObligation } from './red-invoices.js';
import { rescaleInstallments } from './terms.js';

export class FinanceInvoiceConfirm {
  private readonly ledger: FinanceLedger;
  constructor(private readonly store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  confirm(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ counterAccount: accountCodeSchema.optional() }).parse(raw);
    return financeWrite(this.store, user, { action: 'invoice.confirm', input: { ...v, key }, result: invoiceDetailSchema }, () => {
      const before = invoiceDetail(this.db, key),
        i = before.invoice;
      checkVersion(i, v.version);
      if (i.status !== 'draft') financeError('只有待确认的发票可以确认。');
      // 待确认时关联之后来源单可能被更正：旧往来已被替代或冲销，确认时再查一遍，免得把旧往来救活、多出一笔应收应付。
      for (const l of before.links)
        assertInvoiceableObligation(
          this.db,
          Number(l.obligation_id),
          (arrival) => '到货 ' + arrival + ' 已撤销或被更正替代，请先在这张发票上去掉对它的关联。',
        );
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
      const c: ConfirmContext = {
        user, key, counterAccount: v.counterAccount, links: before.links,
        i, date, purchase, auxiliary, net, tax, gross, create,
      };
      let voucher: number | null = null;
      if (gross < 0) voucher = this.redInvoiceVoucher(c);
      else if (purchase || v.counterAccount || before.links.some((l) => this.invoiceRevenue(l.event_id)))
        voucher = blueInvoiceVoucher(this.store, this.ledger, c);
      // 红票要冲减原蓝票关联的往来（采购冲应付，销售冲应收）：按关联累计分摊，和发票页“已开票”扣红票的口径一致。
      // 已经收付过款的，冲减后会显示多付或多收，下次收付款抵扣或退款。
      // 只有红票生成了凭证（总账的应收应付真的被冲减）才冲往来；按送货确认收入的销售发票本身不记账，
      // 不填对方科目的红票也不记账，这时往来保持不变，和总账一致。
      const redObligations =
        gross < 0 && voucher != null
          ? many(
              this.db,
              rows.fin_invoice_links.pick({ obligation_id: true }),
              'SELECT DISTINCT obligation_id FROM fin_invoice_links WHERE invoice_id=?',
              Number(i.original_id),
            ).map((r) => r.obligation_id)
          : [];
      const releasedBefore = redReleasedByObligation(this.db, redObligations);
      const status = gross < 0 ? 'red' : purchase ? 'pending_certification' : 'normal';
      this.db
        .prepare('UPDATE fin_invoices SET status=?,voucher_id=?,version=version+1 WHERE id=?')
        .run(status, voucher, key);
      const releasedAfter = redReleasedByObligation(this.db, redObligations);
      for (const obligationId of redObligations) {
        const reduce =
          (releasedAfter.get(obligationId) || 0) - (releasedBefore.get(obligationId) || 0);
        if (!reduce) continue;
        const o = row(this.db, 'fin_obligations', obligationId);
        this.db
          .prepare('UPDATE fin_obligations SET amount_cents=amount_cents-?,version=version+1 WHERE id=?')
          .run(reduce, obligationId);
        rescaleInstallments(this.db, obligationId, Number(o.amount_cents) - reduce);
        financeAudit(this.store, user, { action: 'invoice_red', entity: 'fin_obligations', id: obligationId, before: o, after: row(this.db, 'fin_obligations', obligationId) });
      }
      const after = invoiceDetail(this.db, key);
      financeAudit(this.store, user, { action: 'confirm', entity: 'fin_invoices', id: key, before, after });
      return after;
    });
  }

  /** 关联往来的来源事件是开票时确认收入的送货单（没有来源事件的不是） */
  private invoiceRevenue(eventId: number | null) {
    return (
      eventId !== null &&
      exists(this.db, "SELECT 1 FROM fin_events WHERE id=? AND revenue_recognition='invoice'", eventId)
    );
  }

  /**
   * 红票的凭证：和原蓝票金额一致且原蓝票有凭证的，直接红冲原蓝票凭证；部分红冲按原业务对方科目另做一张；
   * 原蓝票没有凭证、又没填对方科目的不做凭证（返回 null）。
   */
  private redInvoiceVoucher(c: ConfirmContext): number | null {
    const { user, key, counterAccount, i, date, purchase, auxiliary, net, tax, gross, create } = c;
    const description = '发票 ' + i.number;
    let voucher: number | null = null;
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
          { linked: true },
        ).header.id,
      );
    } else if (blue.voucher_id || counterAccount) {
      if (!counterAccount) financeError('部分红票需明确原业务对方科目。');
      const counter = counterAccount;
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
    return voucher;
  }
}
