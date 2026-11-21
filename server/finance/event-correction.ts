import { z } from 'zod';
import { voucherSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, one, rows } from '../core/index.js';
import { financeAudit, financeError } from './core.js';
import type { FinanceEvent } from './event-shared.js';
import { sumOf } from './finance-rows.js';
import { FinanceLedger } from './ledger.js';
import { allocationSum } from './obligation-sql.js';
import { releaseNoteSettlements } from './note-settlements.js';
import { row } from './query.js';
import { redReleasedByObligation } from './red-invoices.js';
import { isReversed } from './reversal-pairs.js';
import type { FinanceSourceDocument } from './source-snapshot.js';
import type { VoucherRecord } from './voucher-read.js';

type Obligation = z.output<typeof rows.fin_obligations>;
type Header = VoucherRecord['header'];
/** 红字冲销并重做时人填的：红冲日期、原因，和事件的版本（拼请求号用） */
type CorrectionInput = { date: string; reason: string; version: number };

/** 凭证摘要最多几个码元（凭证录入的上限）；没有上限时不截 */
const SUMMARY_MAX = voucherSchema.shape.description.maxLength;
const eventNumber = z.object({ n: z.string().nullable() });

/**
 * 红字冲销的摘要：“红字冲销 送货单 SH-…：原因”。写进红字凭证和冲销往来，
 * 别处（对账单）只用前半句，不把内部原因发给对方。凭证摘要有字数上限，超出的截掉原因的尾巴。
 */
function reversalSummary(db: Store['db'], original: Obligation, reason: string) {
  const number = original.event_id
    ? one(db, eventNumber, 'SELECT source_number AS n FROM fin_events WHERE id=?', original.event_id)?.n
    : null;
  const head =
    '红字冲销 ' +
    (number == null
      ? '手工记的' + (original.kind === 'receivable' ? '应收' : '应付')
      : (original.kind === 'receivable' ? '送货单 ' : '到货单 ') + number);
  // 按整个字截，又不超过凭证摘要的码元上限：原因里有表情这类占两个码元的字时，直接 slice 会截出半个字
  let text = '';
  for (const char of head + '：' + reason) {
    if (SUMMARY_MAX !== null && text.length + char.length > SUMMARY_MAX) break;
    text += char;
  }
  return text;
}

/**
 * 这张单据（和它更正的原单）名下原来那笔往来：不是红冲记录、没被替代、还没红冲过，金额可以是 0
 * （整张红票冲完后应付是 0，但还挂着付款核销和重开额度，不能当作没有原往来）。
 * 两张单据的往来一起找，取最新的：替代单自己入过账以后又被撤销、再被更正或改了内容，
 * 要冲的是它自己的那笔；只找原单会冲不到，重做时又多挂一笔。
 */
function originalObligation(store: Store, event: FinanceEvent, doc: FinanceSourceDocument | undefined) {
  const previousRef = doc?.correctionOfReceiptId ?? doc?.correctionOf;
  const previousId = previousRef == null ? event.source_id : String(previousRef).replace(/^flow-/, '');
  return one(
    store.db,
    rows.fin_obligations,
    `SELECT o.* FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
    LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE e.source_kind=? AND e.source_id IN (SELECT value FROM json_each(?))
    AND o.reversal_of IS NULL AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')
    AND NOT ${isReversed('o')}
    ORDER BY o.id DESC LIMIT 1`,
    event.source_kind,
    JSON.stringify([...new Set([event.source_id, previousId])]),
  );
}

/**
 * 原往来上还挂着收付款核销、已开发票的，要人先处理，这里拦下；返回发票是不是已被红票冲平。
 * 只看已确认的蓝票，待确认和作废的关联不算；红票冲掉的额度扣掉。
 */
function assertSettlementsCleared(store: Store, original: Obligation) {
  const db = store.db,
    key = original.id;
  const allocated = sumOf(db, 'SELECT ' + allocationSum('a.obligation_id=?') + ' AS n', key);
  const invoiced = sumOf(
    db,
    `SELECT coalesce(sum(l.amount_cents),0) AS n FROM fin_invoice_links l
        JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id=? AND i.gross>0 AND i.status NOT IN ('draft','void')`,
    key,
  );
  const invoicedNet = invoiced - (redReleasedByObligation(db, [key]).get(key) || 0);
  const fullyRed = invoiced > 0 && invoicedNet <= 0;
  if (allocated && (fullyRed || original.amount_cents <= 0))
    financeError('原往来已全额红冲且仍有付款核销，请先转抵、退款或撤销核销后再更正。', 409);
  if (
    allocated ||
    exists(
      db,
      `SELECT 1 FROM fin_allocations a JOIN fin_vouchers v ON v.id=a.voucher_id
      WHERE a.obligation_id=? AND v.status NOT IN ('posted','void')`,
      key,
    )
  )
    financeError('请先撤销并记账该往来单的核销。', 409);
  if (invoicedNet > 0) financeError('请先处理已关联发票：开红票冲掉后再更正。', 409);
  return fullyRed;
}

/** 冲掉原往来要用到的：账号、事件、原往来、人填的日期原因，和凭证服务 */
type Undo = {
  store: Store;
  user: Actor;
  event: FinanceEvent;
  original: Obligation;
  input: CorrectionInput;
  ledger: FinanceLedger;
};

const reversingVoucher = rows.fin_vouchers.pick({ id: true });
/** 这张凭证有没有冲掉它的（没作废的）红字凭证 */
const reversalOf = (store: Store, voucherId: number) =>
  one(store.db, reversingVoucher, "SELECT id FROM fin_vouchers WHERE reversal_of=? AND status<>'void'", voucherId);

/** 原往来直接标成已替代（没有凭证可冲，或凭证已经冲平） */
function supersede({ store, user, original }: Undo) {
  store.db.prepare("UPDATE fin_obligations SET tax_status='superseded',version=version+1 WHERE id=?").run(original.id);
  financeAudit(store, user, {
    action: 'supersede',
    entity: 'fin_obligations',
    id: original.id,
    before: original,
    after: row(store.db, 'fin_obligations', original.id),
  });
}

/** 红冲已记账的原凭证（或到票留下的余量暂估凭证），记一笔冲销往来 */
function reverseVoucher(undo: Undo, target: Header, amount: number, ref: { version: number; requestId: string }) {
  const { store, user, event, original, input, ledger } = undo;
  const summary = reversalSummary(store.db, original, input.reason);
  const red = ledger.reverse(user, target.id, { ...ref, date: input.date, description: summary }, { linked: true });
  // 冲的是退货、部分到票后另出的余量暂估凭证时，红字凭证记在这条往来的事件名下，不挂到退货单、发票上：
  // 退货冲了多少按挂在退货单上的凭证算（return-estimates.ts 的 returnBooked、returnCosts），挂上去就算错了
  if (target.id !== original.voucher_id)
    store.db
      .prepare("UPDATE fin_vouchers SET module_source='event_reversal',module_id=? WHERE id=?")
      .run(original.event_id, red.header.id);
  const reversal = Number(
    store.db
      .prepare(
        `INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,reversal_of)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        original.kind,
        original.party_id,
        original.party_name,
        input.date,
        input.date,
        -amount,
        summary,
        event.id,
        red.header.id,
        original.id,
      ).lastInsertRowid,
  );
  financeAudit(store, user, {
    action: 'reverse',
    entity: 'fin_obligations',
    id: reversal,
    before: null,
    after: row(store.db, 'fin_obligations', reversal),
  });
}

/**
 * 按原往来的凭证情况冲掉它：已记账的红冲原凭证；没记账的作废；发票凭证已被红票冲平的只冲到票留下的余量暂估，
 * 没有余量就直接替代原往来（额度也随之作废、不能再关联新票）。返回写进说明的“处理了什么”。
 */
function undoOriginal(undo: Undo, fullyRed: boolean) {
  const { store, user, event, original, input, ledger } = undo;
  const voucher = original.voucher_id ? ledger.get(user, original.voucher_id).header : null;
  // 发票凭证已被红票冲平（整张红冲会直接红冲原凭证，部分红冲各有凭证），不能再冲一次
  const offset = !!voucher && (!!reversalOf(store, voucher.id) || (fullyRed && voucher.module_source === 'invoice'));
  const remainder =
    offset && Number(original.estimate_remaining) > 0 && original.estimate_voucher_id
      ? ledger.get(user, original.estimate_voucher_id).header
      : null;
  const target = offset ? remainder : voucher;
  const amount = offset ? Number(original.estimate_remaining) : original.amount_cents;
  const handled = target ? '原凭证已冲销过' : offset ? '原凭证已被红票冲平，原往来已作废' : '原往来没有凭证，已作废';
  if (!target || (offset && reversalOf(store, target.id))) {
    supersede(undo);
    return handled;
  }
  const ref = { version: target.version, requestId: 'event-correct:' + event.id + ':' + input.version };
  if (target.status === 'posted' && !reversalOf(store, target.id)) {
    reverseVoucher(undo, target, amount, ref);
    return '已红字冲销原凭证';
  }
  if (target.status === 'posted') return handled;
  ledger.transition(user, target.id, 'void', ref, { linked: true });
  if (offset) supersede(undo);
  return '已作废没记账的原凭证';
}

/**
 * 送货、到货“红字冲销并重做”的前一半：找到这张单据（和它更正的原单）名下原来那笔往来，按情况红冲原凭证、
 * 作废没记账的原凭证或直接作废往来；收付款核销、已开发票要人先处理。返回写进说明的“处理了什么”。
 */
export function reverseOriginalObligation(
  store: Store,
  user: Actor,
  event: FinanceEvent,
  doc: FinanceSourceDocument | undefined,
  input: CorrectionInput,
) {
  const original = originalObligation(store, event, doc);
  const ledger = new FinanceLedger(store);
  ledger.openPeriod(user, input.date);
  if (!original) return '原单没有要冲销的往来';
  // 票据冲过这笔往来的，先把票据的钱转回预收（预付），不拦更正；收付款核销仍要人先撤销
  releaseNoteSettlements(store, user, original.id, input.date, input.reason);
  const fullyRed = assertSettlementsCleared(store, original);
  return undoOriginal({ store, user, event, original, input, ledger }, fullyRed);
}
