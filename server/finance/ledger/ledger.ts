/** 凭证：制单、修改、提交审核记账作废、红字冲销，别的功能生成凭证的入口，开会计期间。读凭证见 voucher-read.ts。 */
import { z } from 'zod';
import { voucherChangeSchema, voucherEditSchema, voucherReversalSchema, voucherSchema } from '../../../shared/finance/index.js';
import type { FinanceEntry, VoucherTransition } from '../../../shared/finance/index.js';
import { type FinancePermission } from '../../../shared/core/index.js';
import type { Actor } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import { exists, one, rows } from '../../core/index.js';
import { FinanceSettings } from '../base/settings.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from '../base/core.js';
import { periodOf } from '../base/days.js';
import { finishAllocationReversal, releaseEventOnVoid } from '../events/event-status.js';
import { id as idSchema } from '../base/query.js';
import {
  voucherDetail,
  voucherEntries,
  voucherList,
  voucherRecord,
  voucherRecordSchema,
  type VoucherRecord,
} from './voucher-read.js';

/** 科目一行，加上是不是末级（没有下级科目） */
const accountWithLeaf = rows.fin_accounts.extend({ leaf: z.number() });
const periodStatus = rows.fin_periods.pick({ status: true });

/**
 * 别的财务功能作废、红冲自己生成的凭证时的说明：
 * linked 是来源模块自己操作（凭证页不能直接作废、红冲模块生成的凭证）；cash 是撤销收付款，用出纳权限；
 * permission 是模块撤回自己生成的凭证时用模块的权限，比如结账页重做计提用 finance:close。
 */
type VoucherCall = { linked?: boolean; cash?: boolean; permission?: FinancePermission };
/** 状态往前走一步：从哪个状态到哪个状态 */
const transitions = {
  submit: ['draft', 'pending'],
  approve: ['pending', 'approved'],
  post: ['approved', 'posted'],
} as const;

/** 作废、红冲用哪个权限：模块自己撤回用模块的权限，撤销收付款用出纳权限，别的用制单权限 */
function cancelPermission({ linked = false, cash = false, permission }: VoucherCall): FinancePermission {
  if (linked && permission) return permission;
  return cash ? 'finance:cash' : 'finance:edit';
}

export class FinanceLedger {
  private readonly settings: FinanceSettings;
  constructor(private readonly store: Store) {
    this.settings = new FinanceSettings(store);
  }

  private get db() {
    return this.store.db;
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    return voucherDetail(this.db, idSchema.parse(rawId));
  }

  list(actor: Actor | null, query: unknown) {
    financeActor(actor);
    return voucherList(this.db, query);
  }

  openPeriod(user: Actor, date: string) {
    const period = periodOf(date);
    const start = this.settings.get(user).startPeriod;
    if (!start) financeError('请先启用财务期初。');
    if (period < start) financeError('凭证日期早于财务启用期间。');
    const current = one(this.db, periodStatus, 'SELECT status FROM fin_periods WHERE period=?', period);
    if (current?.status === 'closed') financeError('该会计期间已结账。', 409);
    if (!current) {
      this.db.prepare("INSERT INTO fin_periods(period,status) VALUES(?,'open')").run(period);
      financeAudit(this.store, user, {
        action: 'open',
        entity: 'fin_periods',
        id: null,
        before: null,
        after: { period, status: 'open', version: 1 },
      });
    }
    return period;
  }

  private validateEntries(entries: FinanceEntry[], allowDisabled = false) {
    const { count, message } = voucherSchema.shape.entries.minimum;
    if (entries.length < count) financeError(message);
    let debit = 0n,
      credit = 0n;
    for (const entry of entries) {
      if (entry.debit > 0 === entry.credit > 0) financeError('分录借贷必须且仅能填写一方。');
      const current = one(
        this.db,
        accountWithLeaf,
        `SELECT a.*, NOT EXISTS(SELECT 1 FROM fin_accounts WHERE parent_code=a.code) AS leaf
        FROM fin_accounts a WHERE a.code=?`,
        entry.accountCode,
      );
      if (!current?.leaf || (!current.enabled && !allowDisabled))
        financeError('凭证科目必须为已启用的末级科目。');
      if ((entry.auxiliary?.kind ?? null) !== current.auxiliary)
        financeError('分录辅助项与科目要求不一致。');
      if (current.cash_kind && !entry.cashFlow)
        financeError('现金与银行科目分录必须标记现金流量项目。');
      debit += BigInt(entry.debit);
      credit += BigInt(entry.credit);
    }
    if (debit !== credit || debit === 0n) financeError('凭证借贷必须平衡且金额不能为零。');
  }

  private writeEntries(id: number, entries: FinanceEntry[]) {
    const insert = this.db.prepare(`INSERT INTO fin_entries
      (voucher_id,position,account_code,description,debit,credit,auxiliary_kind,auxiliary_id,auxiliary_name,cash_flow)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const mark = this.db.prepare('UPDATE fin_accounts SET used=1 WHERE code=? AND used=0');
    entries.forEach((entry, i) => {
      insert.run(
        id,
        i + 1,
        entry.accountCode,
        entry.description,
        entry.debit,
        entry.credit,
        entry.auxiliary?.kind ?? null,
        entry.auxiliary?.id ?? null,
        entry.auxiliary?.name ?? null,
        entry.cashFlow,
      );
      mark.run(entry.accountCode);
    });
  }

  private insert(
    user: Actor,
    input: Omit<z.infer<typeof voucherSchema>, 'requestId'>,
    originalId: number | null,
    eventId: number | null = null,
  ) {
    const period = this.openPeriod(user, input.date);
    this.validateEntries(input.entries, originalId !== null);
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO fin_vouchers
      (number,date,period,description,attachment_count,reversal_of,event_id,status,maker_id,maker_name,created_at)
      VALUES((SELECT coalesce(max(number),0)+1 FROM fin_vouchers WHERE period=?),?,?,?,?,?,?,'draft',?,?,?)`,
        )
        .run(
          period,
          input.date,
          period,
          input.description,
          input.attachmentCount,
          originalId,
          eventId,
          user.id,
          user.name,
          new Date().toISOString(),
        ).lastInsertRowid,
    );
    this.writeEntries(id, input.entries);
    const after = voucherRecord(this.db, id);
    financeAudit(this.store, user, {
      action: originalId ? 'reverse' : 'create',
      entity: 'fin_vouchers',
      id,
      before: null,
      after,
    });
    return after;
  }

  create(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      input = voucherSchema.parse(raw);
    return financeWrite(this.store, user, { action: 'vouchers.create', input, result: voucherRecordSchema }, () =>
      this.insert(user, input, null),
    );
  }

  createLinked(
    actor: Actor | null,
    module: string,
    moduleId: number,
    raw: unknown,
    permission:
      'finance:edit' | 'finance:cash' | 'finance:approve' | 'finance:close' = 'finance:edit',
  ) {
    const user = financeActor(actor, permission),
      input = voucherSchema.parse(raw);
    if (!this.db.isTransaction) financeError('模块凭证须在同一事务中生成。', 409);
    const record = this.insert(user, input, null);
    this.db
      .prepare('UPDATE fin_vouchers SET module_source=?,module_id=? WHERE id=?')
      .run(module, moduleId, record.header.id);
    return voucherRecord(this.db, record.header.id);
  }

  createFromEvent(actor: Actor | null, eventId: number, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      input = voucherSchema.parse(raw);
    if (!this.db.isTransaction) financeError('请通过财务事件事务生成来源凭证。', 409);
    if (!exists(this.db, "SELECT 1 FROM fin_events WHERE id=? AND status='ready' AND voucher_id IS NULL", eventId))
      financeError('该来源事件不能生成凭证。', 409);
    return this.insert(user, input, null, eventId);
  }

  update(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      id = idSchema.parse(rawId),
      input = voucherEditSchema.parse(raw);
    const request = { action: 'vouchers.update', input: { ...input, id }, result: voucherRecordSchema };
    return financeWrite(this.store, user, request, () => {
      const before = voucherRecord(this.db, id),
        header = before.header;
      this.assertMutable(header);
      checkVersion(header, input.version);
      if (periodOf(input.date) !== header.period) financeError('跨期间更正须先作废，再录入新凭证。');
      if (header.reversal_of) financeError('红冲分录按原凭证固定，请作废后重新生成。');
      if (header.event_id || header.module_source) financeError('来源凭证分录不能手工覆盖。');
      this.openPeriod(user, input.date);
      this.validateEntries(input.entries);
      this.db
        .prepare(
          `UPDATE fin_vouchers SET date=?,description=?,attachment_count=?,status='draft',
        maker_id=?,maker_name=?,approver_id=NULL,approver_name=NULL,approved_at=NULL,version=version+1 WHERE id=?`,
        )
        .run(input.date, input.description, input.attachmentCount, user.id, user.name, id);
      this.db.prepare('DELETE FROM fin_entries WHERE voucher_id=?').run(id);
      this.writeEntries(id, input.entries);
      const after = voucherRecord(this.db, id);
      financeAudit(this.store, user, { action: 'update', entity: 'fin_vouchers', id, before, after });
      return after;
    });
  }

  private assertMutable(header: VoucherRecord['header']) {
    if (header.status === 'posted') financeError('已记账凭证不可修改或删除，只能红冲。', 409);
    if (header.status === 'void') financeError('凭证已作废。', 409);
  }

  transition(actor: Actor | null, rawId: unknown, action: VoucherTransition, raw: unknown, call: VoucherCall = {}) {
    const user = financeActor(
      actor,
      action === 'approve' || action === 'post' ? 'finance:approve' : cancelPermission(call),
    );
    const id = idSchema.parse(rawId),
      input = voucherChangeSchema.parse(raw);
    const request = { action: 'vouchers.' + action, input: { ...input, id }, result: voucherRecordSchema };
    return financeWrite(this.store, user, request, () => {
      const before = voucherRecord(this.db, id),
        header = before.header;
      if (call.cash && (action !== 'void' || !call.linked || header.module_source !== 'cash'))
        financeError('此操作仅适用于资金单凭证。', 403);
      this.assertMutable(header);
      checkVersion(header, input.version);
      this.openPeriod(user, header.date);
      if (action === 'void') this.voidVoucher(user, header, call.linked === true);
      else this.advance(user, before, action);
      const after = voucherRecord(this.db, id);
      if (action === 'post' && header.reversal_of) finishAllocationReversal(this.store, user, id);
      financeAudit(this.store, user, { action, entity: 'fin_vouchers', id, before, after });
      return after;
    });
  }

  private voidVoucher(user: Actor, header: VoucherRecord['header'], linked: boolean) {
    if (header.module_source && !linked) financeError('这张凭证由别的财务功能生成，请到来源页面撤回。', 409);
    this.db.prepare("UPDATE fin_vouchers SET status='void',version=version+1 WHERE id=?").run(header.id);
    if (header.event_id) releaseEventOnVoid(this.store, user, header.event_id, header.id);
  }

  /** 提交、审核、记账：状态往前走一步，审核、记账记下经办人 */
  private advance(user: Actor, before: VoucherRecord, action: keyof typeof transitions) {
    const header = before.header;
    const [from, to] = transitions[action];
    if (header.status !== from) financeError('凭证状态不允许执行此操作。', 409);
    if (action === 'approve' && header.maker_id === user.id && this.settings.get(user).requireSeparateApprover)
      financeError('制单人不能审核自己的凭证。', 403);
    this.validateEntries(voucherEntries(before.entries), header.reversal_of !== null);
    const actorColumns =
      action === 'approve'
        ? 'approver_id=?,approver_name=?,approved_at=?,'
        : action === 'post'
          ? 'poster_id=?,poster_name=?,posted_at=?,'
          : '';
    const values = actorColumns ? [user.id, user.name, new Date().toISOString()] : [];
    this.db
      .prepare(`UPDATE fin_vouchers SET ${actorColumns} status=?,version=version+1 WHERE id=?`)
      .run(...values, to, header.id);
  }

  reverse(actor: Actor | null, rawId: unknown, raw: unknown, call: VoucherCall = {}) {
    const linked = call.linked === true;
    const user = financeActor(actor, cancelPermission(call)),
      id = idSchema.parse(rawId),
      input = voucherReversalSchema.parse(raw);
    const request = {
      action: 'vouchers.reverse',
      input: { ...input, id, ...(linked ? { linked } : {}) },
      result: voucherRecordSchema,
    };
    return financeWrite(this.store, user, request, () => {
      const { header, entries } = voucherRecord(this.db, id);
      if (call.cash && (!linked || header.module_source !== 'cash'))
        financeError('此操作仅适用于资金单凭证。', 403);
      if ((header.module_source || header.event_id) && !linked)
        financeError('这张凭证由别的财务功能生成，请到来源页面红字冲销。', 409);
      checkVersion(header, input.version);
      if (header.status !== 'posted' || header.reversal_of) financeError('只可红冲已记账的原凭证。');
      if (input.date < header.date) financeError('红冲日期不得早于原凭证。');
      if (exists(this.db, "SELECT 1 FROM fin_vouchers WHERE reversal_of=? AND status<>'void'", id))
        financeError('已存在有效红冲凭证。', 409);
      const red = this.insert(user, { ...input, attachmentCount: 0, entries: voucherEntries(entries) }, id);
      if (!linked) return red;
      this.db
        .prepare('UPDATE fin_vouchers SET module_source=?,module_id=? WHERE id=?')
        .run(header.module_source ?? 'event_reversal', header.module_id ?? header.event_id, red.header.id);
      return voucherRecord(this.db, red.header.id);
    });
  }
}
