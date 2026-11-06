import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dateSchema, today } from '../../shared/domain.js';
import { accountCodeSchema, versionSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { edit, entry, id, label, money, pageSql, partyKind, range, request, row } from './query.js';
import { discount } from './terms.js';
import {
  activeCashAllocation,
  allocationReversalMessage,
  refreshPendingDeliveryReversals,
} from './pending-delivery.js';

const allocation = z.strictObject({
  obligationId: id,
  version: versionSchema,
  amount: money,
  discount: z.number().int().nonnegative().default(0),
  reason: label.optional(),
});
const methods = z.enum(['现金', '银行', '承兑汇票', '微信', '支付宝', '其他']);
const statementInput = range.extend({ kind: partyKind, partyId: z.string().min(1).max(100) });
type StatementLine = {
  voucher_id: number | null;
  date: string;
  number: number | null;
  description: string;
  position: number;
  due_date: string | null;
  delta: number;
};
const cashKind = z.enum(['receipt', 'payment', 'transfer', 'income', 'outlay']);
const cashSchema = request.extend({
  id: id.optional(),
  version: versionSchema.optional(),
  kind: cashKind,
  accountId: id,
  targetAccountId: id.optional(),
  partyId: id.optional(),
  date: dateSchema,
  amount: money,
  method: methods,
  description: label,
  counterAccount: accountCodeSchema.optional(),
  cashFlow: label.optional(),
});
export const allocationSum = (condition: string, posted = false) => `coalesce((
  SELECT sum(a.amount_cents ${condition.startsWith('a.cash_id') ? '-a.discount_cents' : ''}) FROM (
    SELECT id,cash_id,obligation_id,date,amount_cents,voucher_id,status,discount_cents FROM fin_allocations
    UNION ALL SELECT NULL,NULL,obligation_id,date,amount_cents,voucher_id,'active',0 FROM fin_deposit_actions WHERE kind='apply'
    UNION ALL SELECT NULL,NULL,obligation_id,date,amount_cents,voucher_id,'active',0 FROM fin_bad_debts WHERE kind='writeoff'
  ) a JOIN fin_vouchers av ON av.id=a.voucher_id
  WHERE ${condition} AND (a.status IN ('active','reversing') OR (a.status='revoked' AND EXISTS(
    SELECT 1 FROM fin_allocations r WHERE r.reversal_of=a.id))) AND av.status ${posted ? "='posted'" : "<>'void'"}
),0)`;
const roles = {
  receipt: { obligation: 'receivable', auxiliary: 'customer', party: '1122', advance: '2203' },
  payment: { obligation: 'payable', auxiliary: 'supplier', party: '2202', advance: '1123' },
} as const;

export class FinanceSettlements {
  private ledger: FinanceLedger;
  constructor(private store: Store) {
    this.ledger = new FinanceLedger(store);
  }
  private get db() {
    return this.store.db;
  }

  accounts(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({ date: dateSchema.default(() => today()), kind: z.string().max(20).optional() })
      .parse(raw);
    return pageSql(
      this.db,
      `SELECT a.*, coalesce((SELECT sum(debit-credit) FROM fin_opening
      WHERE account_code=a.account_code AND auxiliary_id IS NULL),0)+coalesce((
      SELECT sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(e.debit-e.credit))
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
      WHERE v.status='posted' AND v.date<=? AND e.account_code=a.account_code),0) AS balance
      FROM fin_cash_accounts a WHERE (? IS NULL OR a.kind=?)`,
      [q.date, q.kind ?? null, q.kind ?? null],
      raw,
      'id',
    );
  }

  saveAccount(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const v = request
      .extend({
        id: id.optional(),
        version: versionSchema.optional(),
        name: label,
        kind: z.enum(['cash', 'bank', 'wechat', 'alipay', 'other']),
        accountCode: accountCodeSchema,
        lastFour: z
          .string()
          .regex(/^\d{4}$/)
          .nullable()
          .default(null),
        enabled: z.boolean().default(true),
      })
      .parse(raw);
    if (v.kind !== 'bank' && v.lastFour) financeError('只有银行账户可保存账号后四位。');
    return financeWrite(this.store, user, 'cash.account', v, () => {
      const before = v.id ? row(this.db, 'fin_cash_accounts', v.id) : null;
      const account = this.db
        .prepare(
          `SELECT * FROM fin_accounts a WHERE code=? AND enabled=1 AND
        auxiliary IS NULL AND category='asset' AND NOT EXISTS(SELECT 1 FROM fin_accounts WHERE parent_code=a.code)`,
        )
        .get(v.accountCode);
      if (
        !account ||
        (v.kind === 'bank' && account.cash_kind !== 'bank') ||
        (v.kind === 'cash' && account.cash_kind !== 'cash')
      )
        financeError('资金账户须对应启用的末级资金科目。');
      if (
        this.db
          .prepare('SELECT 1 FROM fin_cash_accounts WHERE (name=? OR account_code=?) AND id<>?')
          .get(v.name, v.accountCode, v.id ?? 0)
      )
        financeError('资金账户名称或对应科目已使用。', 409);
      const values = [v.name, v.kind, v.accountCode, v.lastFour, Number(v.enabled)] as const;
      let key = v.id;
      if (before) {
        checkVersion(before, v.version ?? 0);
        if (v.accountCode !== before.account_code || v.kind !== before.kind)
          financeError('资金账户科目和类型须保持一致。');
        this.db
          .prepare(
            'UPDATE fin_cash_accounts SET name=?,kind=?,account_code=?,last_four=?,enabled=?,version=version+1 WHERE id=?',
          )
          .run(...values, key!);
      } else {
        key = Number(
          this.db
            .prepare(
              'INSERT INTO fin_cash_accounts(name,kind,account_code,last_four,enabled) VALUES(?,?,?,?,?)',
            )
            .run(...values).lastInsertRowid,
        );
      }
      const after = row(this.db, 'fin_cash_accounts', key!);
      financeAudit(this.store, user, 'save', 'fin_cash_accounts', key!, before, after);
      return after;
    });
  }

  cashList(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z
      .object({
        kind: cashKind.optional(),
        accountId: id.optional(),
        partyId: z.string().optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
      })
      .parse(raw);
    const sql = `SELECT c.*, ${allocationSum('a.cash_id=c.id')} AS allocated,
      c.amount_cents-${allocationSum('a.cash_id=c.id')} AS unallocated FROM fin_cash_documents c
      WHERE (? IS NULL OR c.kind=?) AND (? IS NULL OR c.account_id=? OR c.target_account_id=?)
      AND (? IS NULL OR c.party_id=?) AND c.date BETWEEN ? AND ?`;
    return pageSql(
      this.db,
      sql,
      [
        q.kind ?? null,
        q.kind ?? null,
        q.accountId ?? null,
        q.accountId ?? null,
        q.accountId ?? null,
        q.partyId ?? null,
        q.partyId ?? null,
        q.from ?? '0000-01-01',
        q.to ?? '9999-12-31',
      ],
      raw,
      'date',
    );
  }

  cash(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const key = id.parse(rawId);
    return {
      ...row(this.db, 'fin_cash_documents', key),
      allocations: this.db
        .prepare('SELECT * FROM fin_allocations WHERE cash_id=? ORDER BY id')
        .all(key),
      vouchers: this.db
        .prepare(
          "SELECT id,number,period,status FROM fin_vouchers WHERE module_source='cash' AND module_id=? ORDER BY id",
        )
        .all(key),
    };
  }

  daily(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = z.object({ date: dateSchema.default(() => today()) }).parse(raw);
    const sql = `WITH flow AS (
      SELECT e.account_code,v.date,(e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END) AS amount
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted' AND v.date<=?
    ), activity AS (
      SELECT account_code,sum(CASE WHEN date<? THEN amount ELSE 0 END) AS prior,
        sum(CASE WHEN date=? AND amount>0 THEN amount ELSE 0 END) AS income,
        sum(CASE WHEN date=? AND amount<0 THEN -amount ELSE 0 END) AS expense FROM flow GROUP BY account_code
    ) SELECT a.id,a.name,a.kind,a.account_code,coalesce(f.income,0) AS income,coalesce(f.expense,0) AS expense,
      coalesce((SELECT sum(debit-credit) FROM fin_opening WHERE account_code=a.account_code AND auxiliary_id IS NULL),0)
        +coalesce(f.prior,0) AS opening FROM fin_cash_accounts a LEFT JOIN activity f ON f.account_code=a.account_code`;
    return pageSql(
      this.db,
      `SELECT *,opening+income-expense AS closing,(opening+income-expense<0) AS insufficient FROM (${sql})`,
      [q.date, q.date, q.date, q.date],
      raw,
      'id',
    );
  }

  suggest(actor: Actor | null, rawId: unknown, raw: unknown) {
    financeActor(actor);
    const q = z.object({ date: dateSchema.optional() }).parse(raw),
      key = id.parse(rawId);
    const cash = row(this.db, 'fin_cash_documents', key);
    const rule = roles[cash.kind as keyof typeof roles];
    if (!rule) return { allocations: [], available: 0 };
    const date = q.date ?? String(cash.date);
    let left = Number(cash.amount_cents) - this.allocated('cash_id', key);
    const available = left;
    const balances = this.db
      .prepare(
        `SELECT * FROM (SELECT o.*,
      o.amount_cents-${allocationSum('a.obligation_id=o.id')} AS balance,
      (SELECT min(i.due_date) FROM fin_installments i WHERE i.obligation_id=o.id) AS first_installment,
      (SELECT coalesce(json_extract(e.snapshot,'$.doc.number'),json_extract(e.snapshot,'$.doc.reference')) FROM fin_events e WHERE e.id=o.event_id) AS source_number
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE o.kind=? AND o.party_id=? AND o.date<=?
      AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status='posted') AND NOT EXISTS(
        SELECT 1 FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id WHERE r.reversal_of=o.id AND rv.status<>'void')
      ) WHERE balance>0 ORDER BY coalesce(first_installment,due_date,date),date,id LIMIT 100`,
      )
      .all(rule.obligation, cash.party_id, date);
    const allocations = [];
    for (const o of balances) {
      if (left <= 0) break;
      const amount = Math.min(left, Number(o.balance));
      const snap = JSON.parse(String(o.terms_snapshot ?? 'null'));
      const offer = discount(
        String(o.date),
        o.due_date as string | null,
        date,
        Number(o.balance),
        JSON.parse(snap?.options ?? '{}'),
      );
      allocations.push({
        obligationId: Number(o.id),
        version: Number(o.version),
        amount,
        discount: 0,
        offer,
        dueDate: o.due_date,
        date: o.date,
        description: o.description,
        balance: Number(o.balance),
        sourceNumber: o.source_number,
      });
      left -= amount;
    }
    return { allocations, available, unallocated: left };
  }

  autoAllocate(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = request
      .extend({
        kind: z.enum(['receipt', 'payment']),
        partyId: id,
        date: dateSchema,
        documents: z
          .array(z.strictObject({ id, version: versionSchema }))
          .min(1)
          .max(50),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'cash.autoAllocate', v, () => {
      const rows = [];
      for (const item of v.documents) {
        const c = row(this.db, 'fin_cash_documents', item.id);
        checkVersion(c, item.version);
        if (c.kind !== v.kind || c.party_id !== String(v.partyId))
          financeError('资金单与所选往来单位不符。');
        const plan = this.suggest(user, item.id, { date: v.date });
        if (plan.allocations.length)
          rows.push(
            this.allocate(user, item.id, {
              date: v.date,
              version: item.version,
              requestId: 'auto-allocate:' + item.id + ':' + item.version,
              allocations: plan.allocations.map(({ obligationId, version, amount }) => ({
                obligationId,
                version,
                amount,
              })),
            }),
          );
      }
      return { rows };
    });
  }

  saveCash(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      v = cashSchema.parse(raw);
    return financeWrite(this.store, user, 'cash.save', v, () => this.writeCash(user, v));
  }

  writeCash(user: Actor, v: z.infer<typeof cashSchema>) {
    financeActor(user, 'finance:cash');
    if (!this.db.isTransaction) financeError('资金单须在同一事务生成。');
    this.ledger.openPeriod(user, v.date);
    const before = v.id ? row(this.db, 'fin_cash_documents', v.id) : null;
    if (before) {
      checkVersion(before, v.version ?? 0);
      if (before.status !== 'draft') financeError('已确认资金单不可修改。', 409);
    }
    this.activeAccount(v.accountId);
    let partyName: string | null = null;
    if (v.kind === 'receipt' || v.kind === 'payment') {
      if (!v.partyId) financeError('请填写往来单位。');
      const party = row(this.db, v.kind === 'receipt' ? 'customers' : 'suppliers', v.partyId);
      partyName = String(party.name);
    } else if (v.kind === 'transfer') {
      if (!v.targetAccountId || v.targetAccountId === v.accountId)
        financeError('请填写不同的转入资金账户。');
      this.activeAccount(v.targetAccountId);
    } else if (!v.counterAccount || !v.cashFlow) financeError('请填写对方科目和现金流量项目。');
    const args = [
      v.kind,
      v.accountId,
      v.targetAccountId ?? null,
      v.partyId == null ? null : String(v.partyId),
      partyName,
      v.date,
      v.amount,
      v.method,
      v.description,
      v.counterAccount ?? null,
      v.cashFlow ?? null,
    ] as const;
    let key = v.id;
    if (before) {
      this.db
        .prepare(
          `UPDATE fin_cash_documents SET kind=?,account_id=?,target_account_id=?,party_id=?,party_name=?,
        date=?,amount_cents=?,method=?,description=?,counter_account=?,cash_flow=?,version=version+1 WHERE id=?`,
        )
        .run(...args, key!);
    } else {
      key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_cash_documents(kind,account_id,target_account_id,party_id,party_name,date,
        amount_cents,method,description,counter_account,cash_flow) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(...args).lastInsertRowid,
      );
    }
    const after = row(this.db, 'fin_cash_documents', key!);
    financeAudit(this.store, user, 'save', 'fin_cash_documents', key!, before, after);
    return after;
  }

  private activeAccount(key: number) {
    const account = row(this.db, 'fin_cash_accounts', key);
    if (!account.enabled) financeError('资金账户已停用。');
    return String(account.account_code);
  }

  private cashEntries(c: Record<string, unknown>, amount: number, toParty: boolean) {
    const bank = this.activeAccount(Number(c.account_id));
    const kind = c.kind as z.infer<typeof cashKind>;
    if (kind === 'transfer')
      return [
        entry(this.activeAccount(Number(c.target_account_id)), amount, 0, null, '内部转账'),
        entry(bank, 0, amount, null, '内部转账'),
      ];
    if (kind === 'income' || kind === 'outlay') {
      const counter = String(c.counter_account),
        flow = String(c.cash_flow);
      if (counter === bank) financeError('收支对方科目须不同。');
      return kind === 'income'
        ? [entry(bank, amount, 0, null, flow), entry(counter, 0, amount)]
        : [entry(counter, amount, 0), entry(bank, 0, amount, null, flow)];
    }
    const rule = roles[kind],
      auxiliary = { kind: rule.auxiliary, id: String(c.party_id), name: String(c.party_name) };
    const counter = toParty ? rule.party : rule.advance;
    return kind === 'receipt'
      ? [entry(bank, amount, 0, null, '销售商品收到的现金'), entry(counter, 0, amount, auxiliary)]
      : [entry(counter, amount, 0, auxiliary), entry(bank, 0, amount, null, '购买商品支付的现金')];
  }

  private makeVoucher(
    user: Actor,
    key: number,
    date: string,
    description: string,
    entries: ReturnType<typeof entry>[],
    requestId: string,
    cash: boolean,
  ) {
    return Number(
      this.ledger.createLinked(
        user,
        'cash',
        key,
        { date, description, entries, requestId },
        cash ? 'finance:cash' : 'finance:edit',
      ).header.id,
    );
  }

  private allocated(where: 'cash_id' | 'obligation_id', key: number) {
    return Number(
      this.db.prepare('SELECT ' + allocationSum('a.' + where + '=?') + ' AS amount').get(key)
        ?.amount,
    );
  }

  private addAllocation(
    user: Actor,
    c: Record<string, unknown>,
    v: z.infer<typeof allocation>,
    date: string,
    requestId: string,
    initial: boolean,
  ) {
    const cashId = Number(c.id),
      before = row(this.db, 'fin_obligations', v.obligationId);
    const rule = roles[c.kind as keyof typeof roles];
    if (
      !rule ||
      before.kind !== rule.obligation ||
      before.party_id !== c.party_id ||
      Number(before.amount_cents) <= 0 ||
      date < String(c.date) ||
      date < String(before.date)
    )
      financeError('核销的日期、方向或往来单位不匹配。');
    checkVersion(before, v.version);
    if (
      before.event_id &&
      this.db
        .prepare(
          `SELECT 1 FROM fin_events e JOIN flow_documents f
      ON f.id=cast(e.source_id AS INTEGER) AND f.kind='delivery'
      WHERE e.id=? AND e.source_kind='delivery' AND f.status='reversed'`,
        )
        .get(before.event_id)
    )
      financeError(allocationReversalMessage, 409);
    if (
      before.tax_status === 'superseded' ||
      (before.voucher_id && this.ledger.get(user, before.voucher_id).header.status !== 'posted')
    )
      financeError('往来凭证须先记账。');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
      WHERE r.reversal_of=? AND rv.status<>'void'`,
        )
        .get(v.obligationId)
    )
      financeError('已红冲往来单不能核销。');
    const balance = Number(before.amount_cents) - this.allocated('obligation_id', v.obligationId);
    const cashAmount = v.amount - v.discount;
    if (
      v.discount >= v.amount ||
      v.amount > balance ||
      cashAmount > Number(c.amount_cents) - this.allocated('cash_id', cashId)
    )
      financeError('核销金额超过可用余额。');
    const options = JSON.parse(String(before.terms_snapshot ?? 'null'))?.options;
    const offer = discount(
      String(before.date),
      before.due_date as string | null,
      date,
      v.amount,
      JSON.parse(options ?? '{}'),
    );
    if (v.discount && v.discount !== offer?.amount && !v.reason)
      financeError('手工覆盖优惠时必须填写原因。');
    const auxiliary = { kind: rule.auxiliary, id: String(c.party_id), name: String(c.party_name) };
    const entries = initial
      ? this.cashEntries(c, cashAmount, true)
      : c.kind === 'receipt'
        ? [
            entry(rule.advance, cashAmount, 0, auxiliary),
            entry(rule.party, 0, cashAmount, auxiliary),
          ]
        : [
            entry(rule.party, cashAmount, 0, auxiliary),
            entry(rule.advance, 0, cashAmount, auxiliary),
          ];
    if (v.discount) {
      const fee = String(
        JSON.parse(
          String(
            this.db
              .prepare("SELECT mapping FROM fin_templates WHERE name='settlement.discount'")
              .get()!.mapping,
          ),
        ).fee,
      );
      const partyEntry = entries.find((e) => e.accountCode === rule.party)!;
      if (c.kind === 'receipt') {
        partyEntry.credit += v.discount;
        entries.push(entry(fee, v.discount, 0));
      } else {
        partyEntry.debit += v.discount;
        entries.push(entry(fee, 0, v.discount));
      }
    }
    const voucher = this.makeVoucher(
      user,
      cashId,
      date,
      initial ? String(c.description) : '往来核销',
      entries,
      requestId,
      initial,
    );
    const key = Number(
      this.db
        .prepare(
          `INSERT INTO fin_allocations(cash_id,obligation_id,date,amount_cents,voucher_id,initial,discount_cents,discount_reason)
      VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          cashId,
          v.obligationId,
          date,
          v.amount,
          voucher,
          Number(initial),
          v.discount,
          v.reason ?? null,
        ).lastInsertRowid,
    );
    this.db.prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?').run(v.obligationId);
    financeAudit(
      this.store,
      user,
      'allocate',
      'fin_allocations',
      key,
      null,
      row(this.db, 'fin_allocations', key),
    );
    financeAudit(
      this.store,
      user,
      'allocate',
      'fin_obligations',
      v.obligationId,
      before,
      row(this.db, 'fin_obligations', v.obligationId),
    );
    return voucher;
  }

  confirm(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit.extend({ allocations: z.array(allocation).max(100).default([]) }).parse(raw);
    return financeWrite(this.store, user, 'cash.confirm', { ...v, key }, () => {
      const before = row(this.db, 'fin_cash_documents', key);
      checkVersion(before, v.version);
      if (before.status !== 'draft') financeError('只有资金草稿可以确认。', 409);
      const date = String(before.date);
      const vouchers = v.allocations.map((a) =>
        this.addAllocation(user, before, a, date, v.requestId, true),
      );
      const left = Number(before.amount_cents) - this.allocated('cash_id', key);
      if (left)
        vouchers.push(
          this.makeVoucher(
            user,
            key,
            date,
            String(before.description),
            this.cashEntries(before, left, false),
            v.requestId,
            true,
          ),
        );
      this.db
        .prepare(
          "UPDATE fin_cash_documents SET status='confirmed',voucher_id=?,version=version+1 WHERE id=?",
        )
        .run(vouchers[0], key);
      const outgoing = ['payment', 'transfer', 'outlay'].includes(String(before.kind));
      const daily = outgoing ? this.daily(user, { date, pageSize: 200 }) : null;
      const balance = daily?.rows.find((r) => r.id === before.account_id)?.closing;
      const after = {
        ...this.cash(user, key),
        warning:
          outgoing && balance != null && Number(balance) < Number(before.amount_cents)
            ? '资金余额不足，请核对。'
            : null,
      };
      financeAudit(this.store, user, 'confirm', 'fin_cash_documents', key, before, after);
      return after;
    });
  }

  allocate(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit
      .extend({ date: dateSchema, allocations: z.array(allocation).min(1).max(100) })
      .parse(raw);
    return financeWrite(this.store, user, 'cash.allocate', { ...v, key }, () => {
      const before = row(this.db, 'fin_cash_documents', key);
      checkVersion(before, v.version);
      if (
        before.status !== 'confirmed' ||
        this.db
          .prepare(
            `SELECT 1 FROM fin_vouchers WHERE module_source='cash'
        AND module_id=? AND status NOT IN ('posted','void')`,
          )
          .get(key)
      )
        financeError('请先完成资金凭证记账。');
      v.allocations.forEach((a) => this.addAllocation(user, before, a, v.date, v.requestId, false));
      this.db.prepare('UPDATE fin_cash_documents SET version=version+1 WHERE id=?').run(key);
      const after = this.cash(user, key);
      financeAudit(this.store, user, 'allocate', 'fin_cash_documents', key, before, after);
      return after;
    });
  }

  revoke(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      key = id.parse(rawId);
    const v = edit.extend({ date: dateSchema, reason: label }).parse(raw);
    return financeWrite(this.store, user, 'cash.revoke', { ...v, key }, () => {
      const before = row(this.db, 'fin_allocations', key),
        cash = row(this.db, 'fin_cash_documents', Number(before.cash_id));
      checkVersion(before, v.version);
      if (
        before.status !== 'active' ||
        before.reversal_of ||
        this.db.prepare('SELECT 1 FROM fin_allocations WHERE reversal_of=?').get(key)
      )
        financeError('核销已撤销或已生成反向核销。', 409);
      if (v.date < String(before.date)) financeError('撤销日期不得早于核销日期。');
      const record = this.ledger.get(user, before.voucher_id).header;
      const closed = this.db
        .prepare("SELECT 1 FROM fin_periods WHERE period=? AND status='closed'")
        .get(record.period);
      this.ledger.openPeriod(user, v.date);
      const ref = { version: Number(record.version), requestId: v.requestId + ':r' };
      // 子事务使用派生请求号，外层重试整体回放。
      if (ref.requestId.length > 100)
        ref.requestId = ref.requestId.slice(0, 60) + ':' + key + ':revoke';
      if (record.status === 'posted') {
        const reversal = this.ledger.reverse(
          user,
          record.id,
          { ...ref, date: v.date, description: v.reason },
          true,
        );
        const reverseId = Number(
          this.db
            .prepare(
              `INSERT INTO fin_allocations
          (cash_id,obligation_id,date,amount_cents,voucher_id,initial,reversal_of,discount_cents) VALUES(?,?,?,?,?,?,?,?)`,
            )
            .run(
              before.cash_id,
              before.obligation_id,
              v.date,
              -Number(before.amount_cents),
              reversal.header.id,
              before.initial,
              key,
              -Number(before.discount_cents),
            ).lastInsertRowid,
        );
        financeAudit(
          this.store,
          user,
          'reverse',
          'fin_allocations',
          reverseId,
          null,
          row(this.db, 'fin_allocations', reverseId),
        );
      } else {
        this.ledger.transition(user, record.id, 'void', ref, true);
      }
      if (!closed)
        this.db
          .prepare('UPDATE fin_allocations SET status=?,version=version+1 WHERE id=?')
          .run(record.status === 'posted' ? 'reversing' : 'revoked', key);
      if (before.initial) {
        const rule = roles[cash.kind as keyof typeof roles];
        const auxiliary = {
          kind: rule.auxiliary,
          id: String(cash.party_id),
          name: String(cash.party_name),
        };
        const amount = Number(before.amount_cents) - Number(before.discount_cents);
        if (record.status !== 'posted') {
          const entries = this.cashEntries(cash, amount, false);
          this.makeVoucher(
            user,
            Number(cash.id),
            v.date,
            '撤销核销转预收预付',
            entries,
            v.requestId,
            false,
          );
        } else {
          const bank = String(
            row(this.db, 'fin_cash_accounts', Number(cash.account_id)).account_code,
          );
          const flow = cash.kind === 'receipt' ? '销售商品收到的现金' : '购买商品支付的现金';
          const entries =
            cash.kind === 'receipt'
              ? [entry(bank, amount, 0, null, flow), entry(rule.advance, 0, amount, auxiliary)]
              : [entry(rule.advance, amount, 0, auxiliary), entry(bank, 0, amount, null, flow)];
          this.makeVoucher(
            user,
            Number(cash.id),
            v.date,
            '撤销核销转预收预付',
            entries,
            v.requestId,
            false,
          );
        }
      }
      this.db
        .prepare('UPDATE fin_obligations SET version=version+1 WHERE id=?')
        .run(before.obligation_id);
      this.db.prepare('UPDATE fin_cash_documents SET version=version+1 WHERE id=?').run(cash.id);
      const after = row(this.db, 'fin_allocations', key);
      financeAudit(this.store, user, 'revoke', 'fin_allocations', key, before, {
        ...after,
        reason: v.reason,
        date: v.date,
      });
      refreshPendingDeliveryReversals(this.store, user, Number(before.obligation_id));
      return after;
    });
  }

  cancel(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:cash'),
      key = id.parse(rawId);
    const v = edit.extend({ date: dateSchema, reason: label }).parse(raw);
    return financeWrite(this.store, user, 'cash.cancel', { ...v, key }, () => {
      const before = row(this.db, 'fin_cash_documents', key);
      checkVersion(before, v.version);
      if (before.status !== 'confirmed') financeError('只有已确认资金单可以撤销。', 409);
      if (v.date < String(before.date)) financeError('撤销日期不得早于资金单日期。');
      const active = this.db
        .prepare(
          `SELECT 1 FROM fin_allocations a JOIN fin_vouchers original ON original.id=a.voucher_id
        WHERE a.cash_id=? AND ${activeCashAllocation}`,
        )
        .get(key);
      if (active) financeError('请先撤销核销，已生成的核销红冲须先记账。', 409);
      this.ledger.openPeriod(user, v.date);
      const vouchers = this.db
        .prepare(
          `SELECT v.* FROM fin_vouchers v
        WHERE v.module_source='cash' AND v.module_id=? AND v.status<>'void'
        AND v.reversal_of IS NULL AND NOT EXISTS(
          SELECT 1 FROM fin_vouchers red WHERE red.reversal_of=v.id AND red.status='posted')
        ORDER BY v.id`,
        )
        .all(key);
      const voidedVoucherIds: number[] = [],
        reversalVoucherIds: number[] = [];
      for (const voucher of vouchers) {
        if (v.date < String(voucher.date)) financeError('撤销日期不得早于关联凭证日期。');
        const requestId =
          'cash-cancel:' +
          createHash('sha256')
            .update(JSON.stringify([v.requestId, voucher.id]))
            .digest('hex');
        const ref = { requestId, version: Number(voucher.version) };
        if (voucher.status === 'posted') {
          const red = this.ledger.reverse(
            user,
            voucher.id,
            { ...ref, date: v.date, description: v.reason },
            true,
            true,
          );
          reversalVoucherIds.push(Number(red.header.id));
        } else {
          this.ledger.transition(user, voucher.id, 'void', ref, true, true);
          voidedVoucherIds.push(Number(voucher.id));
        }
      }
      this.db
        .prepare("UPDATE fin_cash_documents SET status='cancelled',version=version+1 WHERE id=?")
        .run(key);
      const expense = this.db
        .prepare("SELECT * FROM fin_expenses WHERE cash_id=? AND status='paid'")
        .get(key);
      if (expense) {
        this.db
          .prepare(
            "UPDATE fin_expenses SET status='approved',cash_id=NULL,version=version+1 WHERE id=?",
          )
          .run(expense.id);
        financeAudit(
          this.store,
          user,
          'payment_cancel',
          'fin_expenses',
          Number(expense.id),
          expense,
          row(this.db, 'fin_expenses', Number(expense.id)),
        );
      }
      const after = {
        ...this.cash(user, key),
        status: 'cancelled',
        voidedVoucherIds,
        reversalVoucherIds,
      };
      financeAudit(this.store, user, 'cancel', 'fin_cash_documents', key, before, {
        ...after,
        date: v.date,
        reason: v.reason,
      });
      return after;
    });
  }

  statement(actor: Actor | null, raw: unknown) {
    financeActor(actor);
    const q = statementInput.parse(raw);
    const ar = q.kind === 'receivable';
    const code = ar ? '1122' : '2202',
      aux = ar ? 'customer' : 'supplier';
    const items = this.db
      .prepare(
        `SELECT v.id AS voucher_id,v.date,v.number,v.description,e.position,
      (SELECT min(o.due_date) FROM fin_obligations o WHERE o.voucher_id=v.id AND o.party_id=e.auxiliary_id) AS due_date,
      CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END * ? * (e.debit-e.credit) AS delta
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
      WHERE v.status='posted' AND e.account_code LIKE ? AND e.auxiliary_kind=? AND e.auxiliary_id=?
      AND v.date BETWEEN ? AND ?
      UNION ALL SELECT o.voucher_id,o.date,NULL,o.description,0,o.due_date,o.amount_cents
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind=? AND o.party_id=? AND o.opening_id IS NULL AND o.tax_status<>'superseded'
        AND (o.voucher_id IS NULL OR (v.status<>'posted' AND v.status<>'void' AND o.event_id IS NOT NULL))
        AND o.date BETWEEN ? AND ?
      ORDER BY date,voucher_id,position`,
      )
      .all(ar ? 1 : -1, code + '%', aux, q.partyId, q.from, q.to, q.kind, q.partyId, q.from, q.to) as unknown as StatementLine[];
    const balance = this.db
      .prepare(
        `SELECT ?*(coalesce((SELECT sum(debit-credit) FROM fin_opening
      WHERE account_code LIKE ? AND auxiliary_kind=? AND auxiliary_id=?),0)+coalesce((
      SELECT sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(e.debit-e.credit))
      FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id
      WHERE v.status='posted' AND e.account_code LIKE ? AND e.auxiliary_kind=? AND e.auxiliary_id=? AND v.date<?),0)) AS amount`,
      )
      .get(ar ? 1 : -1, code + '%', aux, q.partyId, code + '%', aux, q.partyId, q.from);
    const provisional = this.db
      .prepare(
        `SELECT coalesce(sum(o.amount_cents),0) AS amount
      FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE o.kind=? AND o.party_id=? AND o.date<?
      AND o.opening_id IS NULL AND o.tax_status<>'superseded'
      AND (o.voucher_id IS NULL OR (v.status<>'posted' AND v.status<>'void' AND o.event_id IS NOT NULL))`,
      )
      .get(q.kind, q.partyId, q.from);
    const opening = Number(balance?.amount) + Number(provisional?.amount);
    const state =
      this.db
        .prepare(
          'SELECT * FROM fin_statements WHERE kind=? AND party_id=? AND from_date=? AND to_date=?',
        )
        .get(q.kind, q.partyId, q.from, q.to) ?? null;
    return {
      opening,
      closing: items.reduce((sum, item) => sum + Number(item.delta), opening),
      items: items.map((item) => ({
        ...item,
        days_to_due:
          item.due_date == null
            ? null
            : Math.round((Date.parse(String(item.due_date)) - Date.parse(q.to)) / 86400000),
      })),
      state,
    };
  }

  statementForExport(actor: Actor | null, raw: unknown) {
    const data = this.statement(actor, raw);
    const { kind, partyId, from, to } = statementInput.parse(raw);
    const receivable = kind === 'receivable';
    const name = this.db.prepare(`SELECT coalesce(
      (SELECT name FROM ${receivable ? 'customers' : 'suppliers'} WHERE id=?),
      (SELECT party_name FROM fin_obligations WHERE kind=? AND party_id=? ORDER BY date DESC,id DESC LIMIT 1),
      (SELECT auxiliary_name FROM fin_opening WHERE auxiliary_kind=? AND auxiliary_id=? ORDER BY id LIMIT 1)
    ) AS name`).get(partyId, kind, partyId, receivable ? 'customer' : 'supplier', partyId)?.name;
    return { from, to, kind, party: name == null ? '名称缺失' : String(name), data };
  }

  markStatement(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const q = range
      .extend({
        kind: partyKind,
        partyId: z.string().min(1).max(100),
        status: z.enum(['sent', 'confirmed', 'difference']),
        discrepancy: z.string().trim().max(1000).default(''),
        requestId: request.shape.requestId,
        version: versionSchema.optional(),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'statement.mark', q, () => {
      const before = this.statement(user, q).state;
      if (before) checkVersion(before, q.version ?? 0);
      else if (q.version) financeError('对账记录不存在。', 404);
      if (q.status === 'difference' && !q.discrepancy) financeError('请填写对账差异。');
      this.db
        .prepare(
          `INSERT INTO fin_statements(kind,party_id,from_date,to_date,status,discrepancy) VALUES(?,?,?,?,?,?)
        ON CONFLICT(kind,party_id,from_date,to_date) DO UPDATE SET status=excluded.status,discrepancy=excluded.discrepancy,version=version+1`,
        )
        .run(q.kind, q.partyId, q.from, q.to, q.status, q.discrepancy);
      const after = this.statement(user, q).state!;
      financeAudit(this.store, user, 'mark', 'fin_statements', Number(after.id), before, after);
      return { ...after };
    });
  }
}
