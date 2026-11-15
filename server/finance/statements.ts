import { z } from 'zod';
import { versionSchema } from '../../shared/finance/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { findPartyName } from './business-source.js';
import { centsText } from '../../shared/core/index.js';
import { cashRecordText } from '../../shared/finance/index.js';
import { partyBalances } from './obligation-sql.js';
import { partyKind, range, request } from './query.js';
import { revokedToAdvance } from './cash-posting.js';
import { statementStatuses } from './stored-values.js';
import { many, one, rows } from '../core/index.js';
import { expectRow } from './finance-rows.js';
import { dayDistance } from './days.js';
import { statementRow, statementSql, type StatementRow } from './statement-sql.js';

const statementInput = range.extend({ kind: partyKind, partyId: z.string().min(1).max(100) });
type StatementQuery = z.output<typeof statementInput>;
/** 一个单位截至某天的余额（按应收、应付方向，已扣预收、预付）和其中还没抵货款的预收（预付） */
const partyBalance = z.object({ amount: z.number(), advance: z.number() });
const partyNameRow = z.object({ name: z.string().nullable() });

/** 拼摘要要知道的：应收还是应付、单据叫什么（“送货单 ”“到货单 ”）、哪些凭证用到了预收（预付） */
type Wording = { ar: boolean; word: string; advanceVouchers: Set<number | null> };

/**
 * 用到预收（预付）的凭证，这个单位的几条分录合成一行、按净额记：核销（预收转去抵应收）净额是 0，
 * 对方的欠款没变，不列；带现结优惠的核销只剩优惠那部分。只用应收（应付）的凭证照旧一条分录一行。
 */
function mergeAdvanceVouchers(raws: StatementRow[]) {
  const advanceVouchers = new Set(raws.filter((r) => r.number != null && r.adv).map((r) => r.voucher_id));
  const onAdvance = (r: StatementRow) => r.number != null && advanceVouchers.has(r.voucher_id);
  const items: StatementRow[] = [];
  for (const r of raws) {
    const last = items.at(-1);
    if (onAdvance(r) && last && last.number != null && last.voucher_id === r.voucher_id) {
      last.delta = last.delta + r.delta;
      last.adv = last.adv && r.adv;
      continue;
    }
    items.push({ ...r });
  }
  return { advanceVouchers, rows: items.filter((r) => !(onAdvance(r) && r.delta === 0)) };
}

/**
 * 红字行一律按它冲的那一行来写，不用红字凭证自己的摘要（那是操作员当场填的原因）：
 * - 冲的是送货、到货的往来：“红字冲销 送货单 SH-…”；冲的是重记的那笔时后面写“（冲 日期 重记的那笔）”，
 *   多层链里两行红字冲销分得出冲的是哪一笔；
 * - 撤销核销（收付款还在，只是不再抵这笔账）：“撤销核销 原核销日期 金额”；
 * - 撤销整笔收付款：“撤销收款 / 撤销付款 原日期 金额”；
 * - 别的（手工凭证、发票凭证、没有单号的往来）：“红字冲销 原凭证或原往来的摘要”，和原来那一行对得上。
 */
function redDescription(r: StatementRow, wording: Wording) {
  if (r.red_document)
    return (
      '红字冲销 ' +
      r.red_document +
      (r.red_target_rerecorded && r.red_target_date ? '（冲 ' + r.red_target_date + ' 重记的那笔）' : '')
    );
  const amount = centsText(Math.abs(r.delta)) + ' 元';
  if (r.red_module === 'cash') {
    // 冲的是“转为预收款”那张（撤销核销那天记的）：钱是原来那笔收付款收的，写原收付款的日期，
    // 不写转预收那天，免得看着像那天另收过一笔
    const when = r.red_original_description === revokedToAdvance && r.red_cash_date ? r.red_cash_date : r.red_original_date;
    return (r.red_allocation ? '撤销核销 ' : wording.ar ? '撤销收款 ' : '撤销付款 ') + (when ? when + ' ' : '') + amount;
  }
  const original =
    r.red_original_document != null
      ? wording.word + r.red_original_document
      : (r.red_original_description ?? '').replace(/^红字冲销\s*/, '').trim();
  return original ? '红字冲销 ' + original : '红字冲销';
}

/**
 * 别的行：送货、到货写单号；收付款那几行不用资金单的摘要（操作员自己填的），写“收客户款 01-03 100.00”
 * （类型、日期、这笔收付款的总额，和月度台账、凭证来源同一种写法）：确认时就核销的照这样写；
 * 预收（预付）那几行：没核销的写“收客户款 01-03 100.00（预收款）”，撤销核销后转回预收写“转为预收款”，
 * 带优惠的核销写“现结优惠”；别的功能记在预收（预付）上的（没核销的承兑票据）同样后面带“（预收款）”。
 */
function plainDescription(r: StatementRow, wording: Wording) {
  const cashText = r.cash_kind != null ? cashRecordText(r.cash_kind, r.cash_date, r.cash_total) : null;
  const name = wording.ar ? '预收款' : '预付款';
  const advanceVoucher = r.number != null && wording.advanceVouchers.has(r.voucher_id);
  if (r.document_number != null) return wording.word + r.document_number + (r.rerecorded ? '（更正后重记）' : '');
  if (r.module === 'cash' && advanceVoucher) {
    if (!r.adv) return '现结优惠';
    if (r.description === revokedToAdvance) return '转为' + name;
    return (cashText ?? r.description) + '（' + name + '）';
  }
  if (advanceVoucher && r.adv) return r.description + '（' + name + '）';
  if (r.module === 'cash' && r.cash_initial && cashText) return cashText;
  return r.description;
}

/**
 * 对账单上的一行。对账单要发给对方：摘要用对方看得懂的说法，不带操作员写的内部原因（凭证上的会计摘要不变）。
 * days_to_due 是到期日离对账期末还有几天（已过期是负数）。
 */
function statementLine(r: StatementRow, wording: Wording, to: string) {
  return {
    voucher_id: r.voucher_id,
    date: r.date,
    number: r.number,
    description: r.red ? redDescription(r, wording) : plainDescription(r, wording),
    position: r.position,
    due_date: r.due_date,
    delta: r.delta,
    red: r.red,
    reversed: r.reversed,
    rerecorded: r.rerecorded,
    days_to_due: r.due_date == null ? null : Math.round(dayDistance(to, r.due_date)),
  };
}

/** 往来对账单：发给对方核对的往来明细，期初、期末和应收应付“按单位”的“还欠”同一个算法。 */
export class FinanceStatements {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  statement(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = statementInput.parse(raw);
    const ar = q.kind === 'receivable';
    const aux = ar ? 'customer' : 'supplier';
    const posted = [q.kind, ar ? 1 : -1, q.to, aux, q.partyId, q.from, q.to];
    const raws = many(this.db, statementRow, statementSql(ar), ...posted, q.kind, q.partyId, q.from, q.to);
    const { advanceVouchers, rows: lines } = mergeAdvanceVouchers(raws);
    // 期初、期末余额和应收应付“按单位”的“还欠”同一个算法（partyBalances）：期末 = 期初 + 这段时间各行发生额
    const opening = this.balanceAt(q, q.from, true)?.amount ?? 0;
    // 期末还没抵货款的预收（预付）：界面上单独写一句；“按单位”的“预收款”一列是同一个数
    const advance = this.balanceAt(q, q.to, false);
    const state = this.statementState(q);
    const wording = { ar, word: ar ? '送货单 ' : '到货单 ', advanceVouchers };
    return {
      opening,
      closing: lines.reduce((sum, item) => sum + item.delta, opening),
      advance: advance?.advance ?? 0,
      items: lines.map((r) => statementLine(r, wording, q.to)),
      state,
    };
  }

  /** 这个单位截至某天（before 为 true 时到前一天）的余额，没有往来是 undefined */
  private balanceAt(q: StatementQuery, date: string, before: boolean) {
    const b = partyBalances(q.kind, date, before, q.partyId);
    return one(this.db, partyBalance, b.sql, ...b.args);
  }

  /** 这个单位这段时间的对账记录（已发送、已确认、有差异），没有是 null */
  private statementState(q: { kind: string; partyId: string; from: string; to: string }) {
    return (
      one(
        this.db,
        rows.fin_statements,
        'SELECT * FROM fin_statements WHERE kind=? AND party_id=? AND from_date=? AND to_date=?',
        q.kind,
        q.partyId,
        q.from,
        q.to,
      ) ?? null
    );
  }

  statementForExport(actor: Actor | null, raw: unknown) {
    const data = this.statement(actor, raw);
    const { kind, partyId, from, to } = statementInput.parse(raw);
    const receivable = kind === 'receivable';
    const name =
      findPartyName(this.db, receivable ? 'customer' : 'supplier', partyId) ??
      one(
        this.db,
        partyNameRow,
        `SELECT coalesce(
      (SELECT party_name FROM fin_obligations WHERE kind=? AND party_id=? ORDER BY date DESC,id DESC LIMIT 1),
      (SELECT auxiliary_name FROM fin_opening WHERE auxiliary_kind=? AND auxiliary_id=? ORDER BY id LIMIT 1)
    ) AS name`,
        kind,
        partyId,
        receivable ? 'customer' : 'supplier',
        partyId,
      )?.name;
    return { from, to, kind, party: name ?? '名称缺失', data };
  }

  mark(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const q = range
      .extend({
        kind: partyKind,
        partyId: z.string().min(1).max(100),
        status: z.enum(statementStatuses),
        discrepancy: z.string().trim().max(1000).default(''),
        requestId: request.shape.requestId,
        version: versionSchema.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, { action: 'statement.mark', input: q, result: rows.fin_statements }, () => {
      const before = this.statementState(q);
      if (before) checkVersion(before, q.version ?? 0);
      else if (q.version) financeError('对账记录不存在。', 404);
      if (q.status === 'difference' && !q.discrepancy) financeError('请填写对账差异。');
      this.db
        .prepare(
          `INSERT INTO fin_statements(kind,party_id,from_date,to_date,status,discrepancy) VALUES(?,?,?,?,?,?)
        ON CONFLICT(kind,party_id,from_date,to_date) DO UPDATE SET status=excluded.status,discrepancy=excluded.discrepancy,version=version+1`,
        )
        .run(q.kind, q.partyId, q.from, q.to, q.status, q.discrepancy);
      const after = expectRow(this.statementState(q) ?? undefined, '对账记录');
      financeAudit(this.store, user, { action: 'mark', entity: 'fin_statements', id: after.id, before, after });
      return { ...after };
    });
  }
}
