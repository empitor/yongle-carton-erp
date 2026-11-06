import { z } from 'zod';
import { dateSchema } from '../../shared/domain.js';
import {
  voucherSchema,
  requestIdSchema,
  versionSchema,
  type FinanceEntry,
} from '../../shared/finance.js';
import { clampPage, parsePaging } from '../paging.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { FinanceSettings } from './settings.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { refreshPendingDeliveryReversals } from './pending-delivery.js';

const idSchema = z.coerce.number().int().positive();
const change = z.strictObject({ version: versionSchema, requestId: requestIdSchema });
const edit = voucherSchema.extend({ version: versionSchema });
const reversal = change.extend({ date: dateSchema, description: voucherSchema.shape.description });
const statusSchema = z.enum(['draft', 'pending', 'approved', 'posted', 'void']);

export class FinanceLedger {
  private readonly settings: FinanceSettings;
  constructor(private readonly store: Store) {
    this.settings = new FinanceSettings(store);
  }

  private get db() {
    return this.store.db;
  }

  private record(id: number) {
    const header = this.db.prepare('SELECT * FROM fin_vouchers WHERE id=?').get(id);
    if (!header) financeError('凭证不存在。', 404);
    const entries = this.db
      .prepare('SELECT * FROM fin_entries WHERE voucher_id=? ORDER BY position')
      .all(id);
    return { header: { ...header }, entries: entries.map((entry) => ({ ...entry })) };
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const record = this.record(idSchema.parse(rawId));
    const event =
      record.header.event_id == null
        ? null
        : this.db
            .prepare('SELECT id,source_kind,source_id,event_type,status FROM fin_events WHERE id=?')
            .get(record.header.event_id);
    return {
      ...record,
      source:
        event ??
        (record.header.module_source
          ? { module: record.header.module_source, id: record.header.module_id }
          : null),
    };
  }

  list(actor: Actor | null, query: unknown) {
    financeActor(actor);
    const paging = parsePaging(query);
    const filters = z
      .object({
        period: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
        status: statusSchema.optional(),
      })
      .parse(query);
    const params = [
      filters.period ?? null,
      filters.period ?? null,
      filters.status ?? null,
      filters.status ?? null,
    ];
    const where = 'WHERE (? IS NULL OR period=?) AND (? IS NULL OR status=?)';
    const total = Number(
      this.db.prepare(`SELECT count(*) AS n FROM fin_vouchers ${where}`).get(...params)?.n,
    );
    const page = clampPage(paging.page ?? 1, paging.pageSize, total);
    return {
      rows: this.db
        .prepare(
          `SELECT * FROM fin_vouchers ${where} ORDER BY period DESC,number DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, paging.pageSize, (page - 1) * paging.pageSize),
      page,
      pageSize: paging.pageSize,
      filteredRecords: total,
    };
  }

  openPeriod(user: Actor, date: string) {
    const period = date.slice(0, 7);
    const start = this.settings.get(user).startPeriod;
    if (!start) financeError('请先启用财务期初。');
    if (period < start) financeError('凭证日期早于财务启用期间。');
    const current = this.db.prepare('SELECT status FROM fin_periods WHERE period=?').get(period);
    if (current?.status === 'closed') financeError('该会计期间已结账。', 409);
    if (!current) {
      this.db.prepare("INSERT INTO fin_periods(period,status) VALUES(?,'open')").run(period);
      financeAudit(this.store, user, 'open', 'fin_periods', null, null, {
        period,
        status: 'open',
        version: 1,
      });
    }
    return period;
  }

  private validateEntries(entries: FinanceEntry[], allowDisabled = false) {
    if (entries.length < 2) financeError('至少填写两条分录。');
    let debit = 0n,
      credit = 0n;
    const account = this.db.prepare(`SELECT a.*, NOT EXISTS(
      SELECT 1 FROM fin_accounts WHERE parent_code=a.code) AS leaf FROM fin_accounts a WHERE a.code=?`);
    for (const entry of entries) {
      if (entry.debit > 0 === entry.credit > 0) financeError('分录借贷必须且仅能填写一方。');
      const current = account.get(entry.accountCode);
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

  private readEntries(entries: ReturnType<FinanceLedger['record']>['entries']): FinanceEntry[] {
    return entries.map((entry) => ({
      accountCode: String(entry.account_code),
      description: String(entry.description),
      debit: Number(entry.debit),
      credit: Number(entry.credit),
      auxiliary: entry.auxiliary_kind
        ? {
            kind: entry.auxiliary_kind as NonNullable<FinanceEntry['auxiliary']>['kind'],
            id: String(entry.auxiliary_id),
            name: String(entry.auxiliary_name),
          }
        : null,
      cashFlow: entry.cash_flow as string | null,
    }));
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
    const after = this.record(id);
    financeAudit(
      this.store,
      user,
      originalId ? 'reverse' : 'create',
      'fin_vouchers',
      id,
      null,
      after,
    );
    return after;
  }

  create(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      input = voucherSchema.parse(raw);
    return financeWrite(this.store, user, 'vouchers.create', input, () =>
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
    return this.record(Number(record.header.id));
  }

  createFromEvent(actor: Actor | null, eventId: number, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      input = voucherSchema.parse(raw);
    if (!this.db.isTransaction) financeError('请通过财务事件事务生成来源凭证。', 409);
    const event = this.db
      .prepare("SELECT id FROM fin_events WHERE id=? AND status='ready' AND voucher_id IS NULL")
      .get(eventId);
    if (!event) financeError('该来源事件不能生成凭证。', 409);
    return this.insert(user, input, null, eventId);
  }

  update(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      id = idSchema.parse(rawId),
      input = edit.parse(raw);
    return financeWrite(this.store, user, 'vouchers.update', { ...input, id }, () => {
      const before = this.record(id),
        header = before.header;
      this.assertMutable(header);
      checkVersion(header, input.version);
      if (input.date.slice(0, 7) !== header.period)
        financeError('跨期间更正须先作废，再录入新凭证。');
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
      const after = this.record(id);
      financeAudit(this.store, user, 'update', 'fin_vouchers', id, before, after);
      return after;
    });
  }

  private assertMutable(header: ReturnType<FinanceLedger['record']>['header']) {
    if (header.status === 'posted') financeError('已记账凭证不可修改或删除，只能红冲。', 409);
    if (header.status === 'void') financeError('凭证已作废。', 409);
  }

  transition(
    actor: Actor | null,
    rawId: unknown,
    action: 'submit' | 'approve' | 'post' | 'void',
    raw: unknown,
    linked = false,
    cashCancellation = false,
  ) {
    const user = financeActor(
      actor,
      action === 'approve' || action === 'post'
        ? 'finance:approve'
        : cashCancellation
          ? 'finance:cash'
          : 'finance:edit',
    );
    const id = idSchema.parse(rawId),
      input = change.parse(raw);
    return financeWrite(this.store, user, 'vouchers.' + action, { ...input, id }, () => {
      const before = this.record(id),
        header = before.header;
      if (cashCancellation && (action !== 'void' || !linked || header.module_source !== 'cash'))
        financeError('此操作仅适用于资金单凭证。', 403);
      this.assertMutable(header);
      checkVersion(header, input.version);
      this.openPeriod(user, String(header.date));
      const transitions = {
        submit: ['draft', 'pending'],
        approve: ['pending', 'approved'],
        post: ['approved', 'posted'],
      } as const;
      if (action === 'void') {
        if (header.module_source && !linked) financeError('请在来源模块中作废凭证。', 409);
        this.db
          .prepare("UPDATE fin_vouchers SET status='void',version=version+1 WHERE id=?")
          .run(id);
        if (header.event_id) {
          const find = this.db.prepare('SELECT * FROM fin_events WHERE id=?');
          const event = find.get(header.event_id);
          const active = this.db
            .prepare('SELECT 1 FROM fin_source_observations WHERE event_id=?')
            .get(header.event_id);
          if (active && event?.status === 'generated') {
            this.db
              .prepare(
                "UPDATE fin_events SET voucher_id=NULL,status='ready',version=version+1 WHERE id=?",
              )
              .run(header.event_id);
            financeAudit(
              this.store,
              user,
              'voucher_void',
              'fin_events',
              Number(header.event_id),
              event,
              find.get(header.event_id),
            );
          }
        }
      } else {
        const [from, to] = transitions[action];
        if (header.status !== from) financeError('凭证状态不允许执行此操作。', 409);
        if (
          action === 'approve' &&
          header.maker_id === user.id &&
          this.settings.get(user).requireSeparateApprover
        )
          financeError('制单人不能审核自己的凭证。', 403);
        this.validateEntries(this.readEntries(before.entries), header.reversal_of !== null);
        const actorColumns =
          action === 'approve'
            ? 'approver_id=?,approver_name=?,approved_at=?,'
            : action === 'post'
              ? 'poster_id=?,poster_name=?,posted_at=?,'
              : '';
        const values = actorColumns ? [user.id, user.name, new Date().toISOString()] : [];
        this.db
          .prepare(`UPDATE fin_vouchers SET ${actorColumns} status=?,version=version+1 WHERE id=?`)
          .run(...values, to, id);
      }
      const after = this.record(id);
      if (action === 'post' && header.reversal_of) {
        const revoked = this.db
          .prepare(
            `SELECT * FROM fin_allocations WHERE status='reversing' AND id IN
          (SELECT reversal_of FROM fin_allocations WHERE voucher_id=?)`,
          )
          .all(id);
        for (const allocation of revoked) {
          this.db
            .prepare("UPDATE fin_allocations SET status='revoked',version=version+1 WHERE id=?")
            .run(allocation.id);
          financeAudit(
            this.store,
            user,
            'revoke_post',
            'fin_allocations',
            Number(allocation.id),
            allocation,
            this.db.prepare('SELECT * FROM fin_allocations WHERE id=?').get(allocation.id),
          );
        }
        const allocation = this.db
          .prepare(
            'SELECT obligation_id FROM fin_allocations WHERE voucher_id=? AND reversal_of IS NOT NULL',
          )
          .get(id);
        if (allocation)
          refreshPendingDeliveryReversals(this.store, user, Number(allocation.obligation_id));
      }
      financeAudit(this.store, user, action, 'fin_vouchers', id, before, after);
      return after;
    });
  }

  remove(actor: Actor | null, rawId: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const { header } = this.get(user, rawId);
    this.assertMutable(header);
    financeError('凭证编号须保留，请使用作废操作。', 405);
  }

  reverse(
    actor: Actor | null,
    rawId: unknown,
    raw: unknown,
    linked = false,
    cashCancellation = false,
  ) {
    const user = financeActor(actor, cashCancellation ? 'finance:cash' : 'finance:edit'),
      id = idSchema.parse(rawId),
      input = reversal.parse(raw);
    return financeWrite(
      this.store,
      user,
      'vouchers.reverse',
      { ...input, id, ...(linked ? { linked } : {}) },
      () => {
        const { header, entries } = this.record(id);
        if (cashCancellation && (!linked || header.module_source !== 'cash'))
          financeError('此操作仅适用于资金单凭证。', 403);
        if ((header.module_source || header.event_id) && !linked)
          financeError('请在来源模块中红冲凭证。', 409);
        checkVersion(header, input.version);
        if (header.status !== 'posted' || header.reversal_of)
          financeError('只可红冲已记账的原凭证。');
        if (input.date < String(header.date)) financeError('红冲日期不得早于原凭证。');
        if (
          this.db
            .prepare("SELECT 1 FROM fin_vouchers WHERE reversal_of=? AND status<>'void'")
            .get(id)
        )
          financeError('已存在有效红冲凭证。', 409);
        const red = this.insert(
          user,
          { ...input, attachmentCount: 0, entries: this.readEntries(entries) },
          id,
        );
        if (!linked) return red;
        this.db
          .prepare('UPDATE fin_vouchers SET module_source=?,module_id=? WHERE id=?')
          .run(
            header.module_source ?? 'event_reversal',
            header.module_id ?? header.event_id,
            red.header.id,
          );
        return this.record(Number(red.header.id));
      },
    );
  }
}
