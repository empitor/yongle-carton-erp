/**
 * 财务待处理里人要处理的：补财务资料（单张、批量补税率），有差异的红字冲销并重做，
 * 盘点调整的核对确认、启用前单据提醒的核对。补完能记账的接着生成凭证。
 */
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { dateSchema } from '../../shared/core/index.js';
import { periodSchema, versionSchema } from '../../shared/finance/index.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { documentMoney, theoreticalMoney } from './amounts.js';
import { sourceContent } from './business-source.js';
import { reverseOriginalObligation } from './event-correction.js';
import { hasBookedObligations } from './event-source-obligations.js';
import { evaluateSource } from './event-evaluate.js';
import { assertSourceCurrent, currentSource, partyOf, provisionalObligation, readEvent } from './event-shared.js';
import { FinanceEventVouchers } from './event-voucher.js';
import { expectRow } from './finance-rows.js';
import { edit, id as recordId, label, request } from './query.js';
import { evidenceLine, readSnapshot, snapshotPartyIdPath, snapshotText } from './source-snapshot.js';
import { partyKinds } from './stored-values.js';

/** 批量补税率一次最多几张 */
const BATCH_MAX = 200;
const resolveInput = edit.extend({
  evidence: z.string().trim().max(1000).optional(),
  lines: z.array(evidenceLine).min(1).max(1000),
});
const batchInput = request.extend({
  items: z.array(z.strictObject({ id: recordId, version: versionSchema })).min(1).max(BATCH_MAX).optional(),
  partyId: recordId.optional(),
  kind: z.enum(partyKinds).optional(),
  period: periodSchema.optional(),
  rate: evidenceLine.shape.rate.optional(),
  mode: evidenceLine.shape.mode.optional(),
  noTax: z.boolean().default(false),
  usePartyDefault: z.boolean().default(false),
  evidence: z.string().trim().max(1000).optional(),
});
type BatchInput = z.output<typeof batchInput>;
/** 按往来单位和月份批量补：这个单位这个月还在资料待补的单据 */
type PartyMonth = { partyId: number; kind: (typeof partyKinds)[number]; period: string };
type BatchItem = { id: number; version: number };
const batchItem = rows.fin_events.pick({ id: true, version: true });
const taxTermsRow = rows.fin_party_terms.pick({ tax_rate: true, tax_mode: true });
/** 红字冲销并重做的结果：事件（重做后能记账的已生成凭证），加上处理了什么 */
const correctedEvent = rows.fin_events.extend({ handled: z.string() });

/** 批量补的范围：选了单据就是那几张，没选要给往来单位和月份 */
function batchScope(v: BatchInput): { items: BatchItem[] } | { party: PartyMonth } {
  if (v.items) return { items: v.items };
  const { partyId, kind, period } = v;
  if (!partyId || !kind || !period) financeError('请选择单据或指定往来单位和月份。');
  return { party: { partyId, kind, period } };
}

export class FinanceEventHandling {
  private readonly vouchers: FinanceEventVouchers;
  constructor(private readonly store: Store) {
    this.vouchers = new FinanceEventVouchers(store);
  }
  private get db() {
    return this.store.db;
  }

  /** 名下有没有还没出凭证的往来 */
  private hasProvisional(id: number) {
    return exists(this.db, 'SELECT 1 FROM fin_obligations WHERE event_id=? AND voucher_id IS NULL', id);
  }

  resolve(actor: Actor | null, rawId: unknown, raw: unknown, taxSource?: { rate: string; mode: string }[]) {
    const user = financeActor(actor, 'finance:edit'),
      id = recordId.parse(rawId);
    const input = resolveInput.parse(raw);
    return financeWrite(this.store, user, { action: 'events.resolve', input: { ...input, id }, result: rows.fin_events }, () => {
      const before = readEvent(this.db, id);
      checkVersion(before, input.version);
      if (before.status !== 'info_pending') financeError('只有资料待补事件可补充财务资料。', 409);
      assertSourceCurrent(this.db, before);
      const snapshot = readSnapshot(before);
      const doc = expectRow(snapshot.doc, '资料待补财务事件的单据快照');
      if (!doc.lines || doc.lines.length !== input.lines.length) financeError('财务补充明细须与原单行数一致。');
      const money = documentMoney(input.lines);
      const delivery = before.source_kind === 'delivery';
      const status = delivery && before.revenue_recognition === 'invoice' ? 'waiting_invoice' : 'ready';
      const amount = delivery ? money.gross : money.net;
      if (
        !amount &&
        exists(
          this.db,
          `SELECT 1 FROM fin_allocations a JOIN fin_obligations o ON o.id=a.obligation_id
        WHERE o.event_id=? AND a.status<>'revoked'`,
          id,
        )
      )
        financeError('已有核销，请先撤销再将货款改为零。');
      const resolved = snapshotText({
        ...snapshot,
        money,
        theoretical: snapshot.theoretical ?? theoreticalMoney(input.lines),
        evidence: input.evidence,
        financialLines: input.lines,
        missing: [],
        taxSource: taxSource ?? input.lines.map(() => ({ rate: 'manual', mode: 'manual' })),
      });
      this.db
        .prepare('UPDATE fin_events SET status=?,amount_cents=?,snapshot=?,problem=NULL,version=version+1 WHERE id=?')
        .run(amount ? status : 'no_amount', amount, resolved, id);
      const after = readEvent(this.db, id);
      if (this.hasProvisional(id) || status === 'waiting_invoice') provisionalObligation(this.store, user, after, doc);
      financeAudit(this.store, user, { action: 'resolve', entity: 'fin_events', id, before, after });
      return after.status === 'ready' && this.hasProvisional(id)
        ? this.vouchers.generate(user, id, { version: after.version, requestId: 'resolve:' + id + ':' + after.version })
        : after;
    });
  }

  resolveBatch(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = batchInput.parse(raw);
    const scope = batchScope(v);
    return financeWrite(this.store, user, { action: 'events.batch', input: { ...v }, result: z.array(rows.fin_events) }, () => {
      const selected = 'items' in scope ? scope.items : this.pendingOf(scope.party);
      if (selected.length > BATCH_MAX) financeError('每批最多补录 ' + BATCH_MAX + ' 张。');
      return selected.map((item) => this.resolveItem(user, v, item));
    });
  }

  /** 这个往来单位这个月还在资料待补的单据（多取一张，超过每批上限就报错） */
  private pendingOf({ partyId, kind, period }: PartyMonth) {
    return many(
      this.db,
      batchItem,
      `SELECT id,version FROM fin_events
        WHERE status='info_pending' AND substr(date,1,7)=? AND
        json_extract(snapshot,?)=? AND (source_kind='delivery')=? ORDER BY id LIMIT ?`,
      period,
      snapshotPartyIdPath(kind),
      partyId,
      Number(kind === 'customer'),
      BATCH_MAX + 1,
    );
  }

  /** 批量补税率里的一张：人给的税率口径，没给按往来单位的默认，再没有按快照里原来的；记下每行的税率从哪来 */
  private resolveItem(user: Actor, v: BatchInput, item: BatchItem) {
    const event = readEvent(this.db, item.id),
      snapshot = readSnapshot(event);
    const party = partyOf(this.db, event, expectRow(snapshot.doc, '资料待补财务事件的单据快照'), event.date);
    const defaults = v.usePartyDefault
      ? one(this.db, taxTermsRow, 'SELECT tax_rate,tax_mode FROM fin_party_terms WHERE kind=? AND party_id=?', party.auxiliary, party.id)
      : null;
    const lines = snapshot.financialLines;
    if (!lines) financeError('缺少价格或数量，请逐行补录。');
    const pick = (given: string | undefined, fallback: string | null | undefined, kept: string | null | undefined) =>
      v.noTax ? 'no_tax' : given ? 'manual' : fallback ? 'party' : (kept ?? 'manual');
    return this.resolve(
      user,
      item.id,
      {
        version: item.version,
        requestId: 'tax-batch:' + item.id + ':' + item.version,
        evidence: v.evidence,
        lines: lines.map((line) => ({
          exact: line.exact,
          rate: v.noTax ? '0' : (v.rate ?? defaults?.tax_rate ?? line.rate),
          mode: v.noTax ? '未税' : (v.mode ?? defaults?.tax_mode ?? line.mode),
        })),
      },
      lines.map((_, i) => ({
        rate: pick(v.rate, defaults?.tax_rate, snapshot.taxSource?.[i]?.rate),
        mode: pick(v.mode, defaults?.tax_mode, snapshot.taxSource?.[i]?.mode),
      })),
    );
  }

  correct(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      id = recordId.parse(rawId);
    const input = edit.extend({ date: dateSchema, reason: label }).parse(raw);
    return financeWrite(this.store, user, { action: 'events.correct', input: { ...input, id }, result: correctedEvent }, () => {
      const event = readEvent(this.db, id);
      checkVersion(event, input.version);
      if (!['difference', 'source_deleted'].includes(event.status) || !['delivery', 'arrival'].includes(event.source_kind))
        financeError('该来源不适用往来全额红冲。', 409);
      const snapshot = readSnapshot(event),
        doc = snapshot.doc;
      const source = currentSource(this.db, event.source_kind, event.source_id);
      if (source) assertSourceCurrent(this.db, event);
      // 处理完写进说明：记成“已更正”时不能还挂着“有差异”的那句，让人以为还要处理
      const handled = reverseOriginalObligation(this.store, user, event, doc, input);
      let status = 'corrected';
      if (source?.status === 'confirmed' && doc && !doc.replacedBy) {
        const result = evaluateSource(this.db, source, doc, { policy: String(event.revenue_recognition), replacement: true });
        status = result.status;
        this.db.prepare('UPDATE fin_events SET snapshot=?,amount_cents=?,problem=? WHERE id=?').run(
          snapshotText({
            ...snapshot,
            money: result.money,
            theoretical: result.theoretical,
            financialLines: result.financialLines,
            missing: result.missing,
            taxSource: result.taxSource,
            warnings: result.warnings,
          }),
          (source.kind === 'delivery' ? result.money?.gross : result.money?.net) ?? null,
          result.problem,
          id,
        );
      }
      if (status === 'corrected') {
        const ending = !source
          ? '，单据已删除，不再重做。'
          : sourceContent(source).replacedBy
            ? '，单据已被更正替代，由替代单入账。'
            : '，单据已撤销，不再重做。';
        this.db.prepare('UPDATE fin_events SET problem=? WHERE id=?').run(handled + ending, id);
      }
      this.db.prepare('UPDATE fin_events SET status=?,voucher_id=NULL,version=version+1 WHERE id=?').run(status, id);
      const after = readEvent(this.db, id);
      if ((status === 'info_pending' || status === 'waiting_invoice') && after.amount_cents && doc)
        provisionalObligation(this.store, user, after, doc);
      financeAudit(this.store, user, { action: 'correct', entity: 'fin_events', id, before: event, after });
      const result =
        status === 'ready'
          ? this.vouchers.generate(
              user,
              id,
              { version: after.version, requestId: 'event-rebuild:' + id + ':' + input.version },
              input.date,
            )
          : after;
      return { ...result, handled };
    });
  }

  acknowledgeStatisticalCorrection(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      id = recordId.parse(rawId);
    const v = edit.extend({ reason: label }).parse(raw);
    return financeWrite(this.store, user, { action: 'events.acknowledge', input: { ...v, id }, result: rows.fin_events }, () => {
      const before = readEvent(this.db, id);
      checkVersion(before, v.version);
      // 启用前单据启用后变了的提醒：核对过期初往来就清掉，不改状态（仍是启用前、不进账）。
      const opening = before.status === 'before_opening' && before.problem != null;
      // 没有往来凭证可红冲的差异：盘点调整（管理员改了流水）。
      // 库存数量和成本由月末成本计算按流水算，这里核对过就不再提示。
      const stock = before.source_kind === 'stock' && before.status === 'difference';
      // 单据已删、原凭证还在：收入、成本是真的（比如删单时保留了库存流水），核对后保留原凭证，不红冲。
      const deleted = before.status === 'source_deleted';
      if (!opening && !stock && !deleted)
        financeError('此操作只适用于盘点调整的差异、单据已删的和启用前单据的提醒。', 409);
      // 没有还算数的凭证可保留的（只挂着暂估往来和核销、发票，或凭证已被红冲平）：保留了总账里也没有它，只能红字冲销
      if (deleted && !hasBookedObligations(this.db, before.source_kind, [before.source_id]))
        financeError('这张单据没有还算数的凭证可保留：点“红字冲销”；挂着收付款核销或发票的，先撤销核销或红冲发票。', 409);
      this.db
        .prepare(
          opening
            ? 'UPDATE fin_events SET problem=NULL,version=version+1 WHERE id=?'
            : deleted
              ? "UPDATE fin_events SET status='corrected',problem='单据已删除，核对后保留原凭证。',version=version+1 WHERE id=?"
              : "UPDATE fin_events SET status='corrected',version=version+1 WHERE id=?",
        )
        .run(id);
      const after = readEvent(this.db, id);
      financeAudit(this.store, user, { action: 'acknowledge', entity: 'fin_events', id, before, after: { ...after, reason: v.reason } });
      return after;
    });
  }
}
