/**
 * 财务派生凭证的撤回和红冲，一套做法：承兑票据、固定资产处置、费用报销、坏账、压款利息、保证金。
 * - 凭证还没记账（制单、待审核、已审核）：撤回 = 作废凭证；
 * - 已记账：只能红字冲销，生成一张红字凭证（原凭证不改）。
 * 凭证作废或红冲以后，来源记录的效果跟着撤掉。能按凭证推出来的（保证金余额、转抵、坏账核销、票据结算、
 * 利息算到哪天）读的时候就排除（obligation-sql.ts 的 voucherReversed、voucherStands）；
 * 有状态的（票据、资产、费用单、利息挂的往来）在下面各来源的 undo 里改回去。
 * 凭证页不能直接作废、红冲这些凭证（ledger.ts 指回来源页面），都从这里走，来源页面给入口。
 */
import { z } from 'zod';
import { dateSchema } from '../../../shared/core/index.js';
import type { Actor, Store } from '../../core/index.js';
import { exists, many, one, rows } from '../../core/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { sumOf } from '../base/finance-rows.js';
import { FinanceLedger } from './ledger.js';
import { allocationSum, voucherStands } from '../parties/obligation-sql.js';
import { id, label, request, row } from '../base/query.js';
import { voucherRecord, voucherRecordSchema, type VoucherRecord } from './voucher-read.js';

type Header = VoucherRecord['header'];
const headerSchema = voucherRecordSchema.shape.header;
type Source = {
  /** 用哪个权限撤（和生成时一样） */
  permission: 'finance:edit' | 'finance:cash';
  /** 不能撤的原因；能撤返回 null */
  blocker(store: Store, voucher: Header): string | null;
  /** 凭证撤回（red 为 null）或红冲（red 是红字凭证）以后，来源记录回到之前 */
  undo(store: Store, user: Actor, voucher: Header, red: Header | null): void;
};

/** 版本 +1 的几张表，写死表名（模块边界测试要看得出写的是谁的表） */
const bumps = {
  fin_obligations: 'UPDATE fin_obligations SET version=version+1 WHERE id=?',
  fin_deposits: 'UPDATE fin_deposits SET version=version+1 WHERE id=?',
  fin_notes: 'UPDATE fin_notes SET version=version+1 WHERE id=?',
} as const;
const bump = (store: Store, table: keyof typeof bumps, key: number | null) => store.db.prepare(bumps[table]).run(Number(key));

/** 票据名下在凭证 v 之后、还算数的凭证（核销、变更） */
const laterNoteVouchers = (store: Store, v: Header) =>
  exists(
    store.db,
    `SELECT 1 FROM fin_vouchers x WHERE x.module_source='note' AND x.module_id=? AND x.id>? AND x.reversal_of IS NULL
      AND ${voucherStands('x')} LIMIT 1`,
    Number(v.module_id),
    v.id,
  );

const settledObligation = z.object({ obligation_id: z.number() });
/** 被这张凭证核销过的往来（坏账、保证金转抵、票据结算），撤掉以后版本 +1，页面上拿旧版本的操作会被拦 */
const touchSettled = (store: Store, v: Header) => {
  for (const r of many(
    store.db,
    settledObligation,
    `SELECT obligation_id FROM fin_bad_debts WHERE voucher_id=?
      UNION SELECT obligation_id FROM fin_deposit_actions WHERE voucher_id=? AND obligation_id IS NOT NULL`,
    v.id,
    v.id,
  ))
    bump(store, 'fin_obligations', r.obligation_id);
};

/** 利息凭证挂的那笔往来（确认利息时记的“压款利息”） */
const interestObligation = (store: Store, v: Header) =>
  one(store.db, rows.fin_obligations, 'SELECT * FROM fin_obligations WHERE voucher_id=? AND reversal_of IS NULL', v.id);

const firstNoteVoucher = z.object({ id: z.number().nullable() });

const derivedSources: Record<string, Source> = {
  deposit: {
    permission: 'finance:cash',
    blocker(store, v) {
      const deposit = row(store.db, 'fin_deposits', Number(v.module_id));
      if (deposit.voucher_id !== v.id) return null;
      const used = exists(
        store.db,
        `SELECT 1 FROM fin_deposit_actions a JOIN fin_vouchers x ON x.id=a.voucher_id
          WHERE a.deposit_id=? AND ${voucherStands('x')} LIMIT 1`,
        deposit.id,
      );
      return used ? '这笔保证金已经有退回或转抵，先撤回或红冲那几笔。' : null;
    },
    undo(store, _user, v) {
      bump(store, 'fin_deposits', v.module_id);
      touchSettled(store, v);
    },
  },
  interest: {
    permission: 'finance:edit',
    blocker(store, v) {
      const o = interestObligation(store, v);
      if (!o) return null;
      const paid = sumOf(store.db, `SELECT ${allocationSum('a.obligation_id=?')} AS n`, o.id);
      return paid ? '这笔利息已经收（付）过，先撤销核销。' : null;
    },
    undo(store, user, v, red) {
      // 撤回时凭证作废，利息挂的往来跟着不算；红冲时记一笔冲销往来，和单据红字冲销成对看（reversal-pairs.ts）
      const o = interestObligation(store, v);
      if (!o || !red) return;
      const key = Number(
        store.db
          .prepare(
            `INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description,voucher_id,reversal_of)
            VALUES(?,?,?,?,?,'红字冲销 压款利息',?,?)`,
          )
          .run(o.kind, o.party_id, o.party_name, red.date, -o.amount_cents, red.id, o.id).lastInsertRowid,
      );
      bump(store, 'fin_obligations', o.id);
      financeAudit(store, user, {
        action: 'reverse',
        entity: 'fin_obligations',
        id: key,
        before: null,
        after: row(store.db, 'fin_obligations', key),
      });
    },
  },
  bad_debt: {
    permission: 'finance:edit',
    blocker: () => null,
    undo(store, _user, v) {
      touchSettled(store, v);
    },
  },
  asset_disposal: {
    permission: 'finance:edit',
    blocker(store, v) {
      return row(store.db, 'fin_assets', Number(v.module_id)).status === 'disposed' ? null : '资产不是已处置状态。';
    },
    undo(store, _user, v) {
      store.db.prepare("UPDATE fin_assets SET status='active',version=version+1 WHERE id=?").run(Number(v.module_id));
    },
  },
  expense: {
    permission: 'finance:edit',
    blocker(store, v) {
      const e = row(store.db, 'fin_expenses', Number(v.module_id));
      if (e.voucher_id !== v.id) return '这张凭证不是费用单现在的凭证。';
      return e.status === 'paid' ? '费用单已经付款，先在收付款里撤销这笔付款。' : null;
    },
    undo(store, _user, v) {
      // 回到待审核，重新审核时另出凭证
      store.db
        .prepare("UPDATE fin_expenses SET status='pending',voucher_id=NULL,version=version+1 WHERE id=?")
        .run(Number(v.module_id));
    },
  },
  note: {
    permission: 'finance:cash',
    blocker(store, v) {
      const note = row(store.db, 'fin_notes', Number(v.module_id));
      if (note.voucher_id === v.id)
        return note.status === 'held' && laterNoteVouchers(store, v) ? '这张票据后来还有核销，先撤回那几笔。' : null;
      // 核销、来源更正转回这类：票据后来变更过就不能单独撤
      return Number(note.voucher_id) > v.id ? '票据后来已经变更，先撤回那次变更。' : null;
    },
    undo(store, _user, v) {
      const note = row(store.db, 'fin_notes', Number(v.module_id));
      if (note.voucher_id === v.id) {
        // 撤的是收票（开票）：票据作废；撤的是变更（背书、贴现、到期、退票）：回到持有，凭证指回收票那张
        const first = one(
          store.db,
          firstNoteVoucher,
          "SELECT min(id) AS id FROM fin_vouchers WHERE module_source='note' AND module_id=? AND reversal_of IS NULL",
          note.id,
        )?.id;
        if (note.status === 'held')
          store.db.prepare("UPDATE fin_notes SET status='cancelled',version=version+1 WHERE id=?").run(note.id);
        else
          store.db
            .prepare("UPDATE fin_notes SET status='held',voucher_id=?,version=version+1 WHERE id=?")
            .run(Number(first), note.id);
      } else bump(store, 'fin_notes', note.id);
      touchSettled(store, v);
    },
  },
};

const withdrawInput = request.extend({ version: z.number().int().positive(), reason: label });
const reverseInput = withdrawInput.extend({ date: dateSchema });

export class FinanceDerivedVouchers {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }

  /** 凭证和它的来源规则 */
  private source(rawId: unknown) {
    const key = id.parse(rawId);
    const header = voucherRecord(this.store.db, key).header;
    const source = Object.hasOwn(derivedSources, String(header.module_source))
      ? derivedSources[String(header.module_source)]
      : undefined;
    if (!source || header.reversal_of != null)
      financeError('这张凭证不是票据、资产处置、费用、坏账、利息、保证金生成的。', 409);
    return { key, header, source };
  }

  /** 撤回：凭证还没记账，作废它，来源回到之前 */
  withdraw(actor: Actor | null, rawId: unknown, raw: unknown) {
    const { key, header, source } = this.source(rawId);
    const user = financeActor(actor, source.permission),
      v = withdrawInput.parse(raw);
    const write = { action: 'derived.withdraw', input: { ...v, key }, result: headerSchema };
    return financeWrite(this.store, user, write, () => {
      checkVersion(header, v.version);
      if (header.status === 'posted') financeError('凭证已记账，只能红字冲销。', 409);
      if (header.status === 'void') financeError('凭证已经作废。', 409);
      const blocked = source.blocker(this.store, header);
      if (blocked) financeError(blocked, 409);
      this.ledger.transition(
        user,
        key,
        'void',
        { version: v.version, requestId: v.requestId + ':void' },
        { linked: true, permission: source.permission },
      );
      source.undo(this.store, user, header, null);
      const after = voucherRecord(this.store.db, key).header;
      financeAudit(this.store, user, {
        action: 'withdraw',
        entity: 'fin_vouchers',
        id: key,
        before: header,
        after: { ...after, reason: v.reason },
      });
      return after;
    });
  }

  /** 红冲：凭证已记账，生成红字凭证，来源回到之前 */
  reverse(actor: Actor | null, rawId: unknown, raw: unknown) {
    const { key, header, source } = this.source(rawId);
    const user = financeActor(actor, source.permission),
      v = reverseInput.parse(raw);
    const write = { action: 'derived.reverse', input: { ...v, key }, result: headerSchema };
    return financeWrite(this.store, user, write, () => {
      checkVersion(header, v.version);
      if (header.status !== 'posted') financeError('凭证还没记账，请撤回。', 409);
      const blocked = source.blocker(this.store, header);
      if (blocked) financeError(blocked, 409);
      const red = this.ledger.reverse(
        user,
        key,
        { version: v.version, requestId: v.requestId + ':reverse', date: v.date, description: '红冲：' + v.reason },
        { linked: true, permission: source.permission },
      ).header;
      source.undo(this.store, user, header, red);
      financeAudit(this.store, user, {
        action: 'reverse',
        entity: 'fin_vouchers',
        id: key,
        before: header,
        after: { redVoucherId: red.id, reason: v.reason },
      });
      return red;
    });
  }
}
