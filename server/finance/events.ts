/**
 * 业务单据进财务：扫描已确认、已撤销的送货、到货、完工单和盘点流水，
 * 按来源指纹判断新增、替换或标“有差异”，挂暂估往来，来源被删的标“来源已删除”。
 */
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { exists, many, one, rows } from '../core/index.js';
import { financeActor, financeAudit, financeWrite } from './core.js';
import { sourceContent, sourceMissing, sourceRow, sourcesCte, type SourceRow } from './business-source.js';
import { eventChangesSince } from './event-changes.js';
import { differenceProblem, evaluateSource, taxBasis, type Evaluation } from './event-evaluate.js';
import { provisionalObligation, readEvent, revenuePolicy, type FinanceEvent } from './event-shared.js';
import {
  flagBeforeOpeningChange,
  markSourceDeleted,
  refreshPendingDeliveryReversals,
  supersedeEvent,
} from './event-status.js';
import { expectRow } from './finance-rows.js';
import { request } from './query.js';
import { sourceHash, withNumber } from './source-fingerprint.js';
import { syncReturnEstimates } from './return-estimates.js';
import { readSnapshot, snapshotText, type FinanceSourceDocument } from './source-snapshot.js';
import {
  allocationsPending,
  hasPendingObligations,
  relatedSources,
  releaseProvisionalObligations,
  supersedeObligations,
} from './event-source-obligations.js';

/** 一次同步最多扫几条来源、几条被删的来源；扫满了告诉页面还有（remaining） */
const BATCH_SIZE = 100;
/** 还没扫过这一版的来源：来源一行，加上财务上次看到它时挂的事件和它的状态（第一次看到都是 null） */
const observedSource = sourceRow.extend({ previous: z.number().nullable(), observed: z.string().nullable() });
type ObservedSource = z.output<typeof observedSource>;
const syncResult = z.object({ processed: z.number(), remaining: z.boolean() });
const startPeriod = rows.fin_settings.pick({ start_period: true });

/** 同步一条来源时要的：账号、来源、单据内容（带单号）、上一条事件、来源指纹、事件类型、收入确认口径 */
type SyncContext = {
  user: Actor;
  source: ObservedSource;
  doc: FinanceSourceDocument;
  previous: FinanceEvent | undefined;
  hash: string;
  eventType: string;
  policy: string;
};

/** 来源单据对应的财务事件类型：送货确认或冲销、到货确认或更正、完工、盘点调整 */
function eventTypeOf(source: SourceRow, doc: FinanceSourceDocument) {
  const reversal = source.status === 'reversed' || doc.correctionOf || doc.correctionOfReceiptId || doc.replacedBy;
  if (source.kind === 'delivery') return reversal ? 'delivery.reversed' : 'delivery.confirmed';
  if (source.kind === 'production') return 'production.completed';
  if (source.kind === 'stock') return 'stock.adjusted';
  return reversal ? 'arrival.corrected' : 'arrival.confirmed';
}

/** 记进 amount_cents 的金额：送货含税、到货不含税（暂估），和更新、预览、红字冲销并重做同一个口径；没有金额是 null */
const recordedAmount = (kind: string, result: Evaluation) =>
  (kind === 'delivery' ? result.money?.gross : result.money?.net) ?? null;
/** 事件快照里记的上一条：编号、指纹、状态 */
const previousOf = (previous: FinanceEvent | undefined) =>
  previous ? { eventId: previous.id, hash: previous.source_hash, status: previous.status } : null;

export class FinanceEvents {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  /** 只返回尚未扫描的版本，采购投影的来源是同一张到货单。 */
  private sources() {
    return many(
      this.db,
      observedSource,
      `${sourcesCte}
    SELECT s.*,o.event_id AS previous,o.status AS observed FROM sources s
    LEFT JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
    WHERE o.source_id IS NULL OR o.source_version<>s.version OR o.status<>s.status
    LIMIT ?`,
      BATCH_SIZE,
    );
  }

  sync(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor),
      input = request.parse(raw);
    return financeWrite(this.store, user, { action: 'events.sync', input, result: syncResult }, () => {
      const start = expectRow(one(this.db, startPeriod, 'SELECT start_period FROM fin_settings WHERE id=1'), '财务设置').start_period;
      if (!start) return { processed: 0, remaining: false };
      const sources = this.sources();
      let processed = 0;
      for (const source of sources) processed += this.syncSource(user, source, start);
      const missing = many(
        this.db,
        rows.fin_events,
        `SELECT e.* FROM fin_source_observations o JOIN fin_events e ON e.id=o.event_id
        WHERE o.status<>'deleted' AND e.status<>'before_opening' AND ${sourceMissing('o')}
        LIMIT ?`,
        BATCH_SIZE,
      );
      for (const before of missing) markSourceDeleted(this.store, user, before);
      refreshPendingDeliveryReversals(this.store, user);
      // 未到票的采购退货按暂估单价冲减暂估（退货撤销时加回来），见 return-estimates.ts
      processed += syncReturnEstimates(this.store, user);
      return {
        processed: processed + missing.length,
        remaining: sources.length === BATCH_SIZE || missing.length === BATCH_SIZE,
      };
    });
  }

  /** 同步一条来源：返回 1 是新增或改动了事件，0 是只记下看到了（没变、启用前的）。 */
  private syncSource(user: Actor, source: ObservedSource, start: string) {
    const content = sourceContent(source);
    const doc = withNumber(content, source.number);
    const previous =
      source.previous === null ? undefined : one(this.db, rows.fin_events, 'SELECT * FROM fin_events WHERE id=?', source.previous);
    const policy = previous?.revenue_recognition ?? revenuePolicy(this.db, doc.confirmedAt ?? source.at);
    const context: SyncContext = {
      user,
      source,
      doc,
      previous,
      hash: sourceHash(source, content),
      eventType: eventTypeOf(source, doc),
      policy,
    };
    if (this.onlyObserve(context, start)) return 0;
    this.record(context);
    return 1;
  }

  /**
   * 不用新增或改动事件、只记下看到了这一版的：启用前的单据（启用后又改了的记一句提醒）、指纹没变的。
   * 启用前的单据启用后又被改了（补价格、管理员编辑、冲销）：日期还在启用月之前就仍不进账，
   * 只记下看到了新版本。生成事件的话日期早于启用月，凭证和更正都做不了，结账会一直卡住。
   * 财务看的内容变了的，记一条不卡结账的提醒，让人核对期初往来。
   */
  private onlyObserve({ user, source, doc, previous, hash, eventType }: SyncContext, start: string) {
    if (previous?.status === 'before_opening' && source.date < start) {
      flagBeforeOpeningChange(this.store, user, previous, hash, source.status === 'reversed' || !!doc.replacedBy);
      this.observe(source, previous.id);
      return true;
    }
    if (source.date < start && !previous) {
      this.ignoreBeforeOpening(user, source, eventType, hash);
      return true;
    }
    const unchanged =
      previous?.source_hash === hash &&
      !(previous.status === 'info_pending' && !exists(this.db, 'SELECT 1 FROM fin_obligations WHERE event_id=?', previous.id));
    if (unchanged) this.observe(source, previous.id);
    return unchanged;
  }

  /**
   * 来源变了：新增或改动事件。
   * 送货、到货：这张单据和它更正的原单名下，有没有要人处理的东西（出过凭证，或者往来被核销、关联了发票这类）。
   * 都没有就是“还没入过账”：撤销、被更正替代都没有什么可红冲的，不要人点“红字冲销并重做”，也不卡结账；
   * 系统自己挂的暂估往来（没凭证、没被动过）跟着作废。有的话照旧走“有差异”，由人红冲重做。
   */
  private record(context: SyncContext) {
    const { source, doc, previous } = context;
    // 已撤销的送货还挂着“待撤销核销”时又改了内容（比如本机管理员改订单换客户，送货单跟着换）：就地换成新内容，不新建事件。
    // 新建的话这一条被替代，撤销核销记账后的自动收尾（refreshPendingDeliveryReversals）就接不上原来那条事件
    if (previous?.status === 'awaiting_allocation_reversal' && source.kind === 'delivery' && source.status === 'reversed') {
      this.refreshInPlace(context, previous);
      return;
    }
    const related = relatedSources(source, doc);
    const settled = !!related && previous?.voucher_id == null && !hasPendingObligations(this.db, source.kind, related);
    const inactive = source.status === 'reversed' || !!doc.replacedBy;
    if (settled && inactive) this.recordInactive(context, related);
    else this.recordEvaluated(context, settled ? related : null);
  }

  /**
   * 已经入账的不能原地换一张新事件：开票确认收入时凭证挂在往来上、事件本身没有凭证号，
   * 往来已有凭证、发票关联或核销的，同样要走差异，否则会多出一笔待开票应收。
   */
  private bookedBefore(previous: FinanceEvent) {
    return (
      !!previous.voucher_id ||
      previous.status === 'generated' ||
      ['difference', 'source_deleted'].includes(previous.status) ||
      exists(
        this.db,
        `SELECT 1 FROM fin_obligations o WHERE o.event_id=? AND (
          ${allocationsPending('o')}
          OR EXISTS(SELECT 1 FROM fin_bad_debts b WHERE b.obligation_id=o.id)
          OR EXISTS(SELECT 1 FROM fin_deposit_actions d WHERE d.obligation_id=o.id)
          OR EXISTS(SELECT 1 FROM fin_vouchers v WHERE v.id=o.voucher_id AND v.status<>'void')
          OR EXISTS(SELECT 1 FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
            WHERE l.obligation_id=o.id AND i.status<>'void'))`,
        previous.id,
      )
    );
  }

  /** 说明里提不提“改了什么”：按详情里会列出来的那几项（和 get 同一个比法）先比一遍 */
  private listedChanges({ source, doc, previous, eventType }: SyncContext, effective: Evaluation, amount: number | null) {
    if (source.status !== 'confirmed' || doc.replacedBy || !previous) return false;
    const changes = eventChangesSince(this.db, previous.id, source.kind, eventType, {
      doc,
      date: source.date,
      amount,
      ...taxBasis({ missing: effective.missing, theoretical: effective.theoretical }),
    });
    return changes.length > 0;
  }

  /**
   * 按单据现在的内容评估，新增一条事件（或在原来那条上刷新），上一条没处理完的由它接手，需要时挂暂估往来。
   * settledRelated 是名下什么都没挂（还没入过账）时这张单据和它更正的原单；入过账的是 null。
   */
  private recordEvaluated(context: SyncContext, settledRelated: string[] | null) {
    const { user, source, doc, previous } = context;
    const settled = settledRelated !== null;
    // 有效的替代单，原单没入过账：原单挂的暂估往来作废，替代单按一张正常的新单据评估。
    // 替代单沿用原单日期，那个月已经结账的，生成凭证时记到最早没结账的月份（periods.ts 的 bookingDate）。
    if (settledRelated) releaseProvisionalObligations(this.store, user, source.kind, settledRelated.slice(1));
    const result = evaluateSource(this.db, source, doc, { policy: context.policy, replacement: settled });
    const effective =
      result.status === 'difference' && source.status === 'confirmed' && ['delivery', 'arrival'].includes(source.kind)
        ? evaluateSource(this.db, source, doc, { policy: context.policy, replacement: true })
        : result;
    // 名下什么都没挂（settled）的送货、到货不算：上一条“有差异”留着也只是没东西可冲。
    const changed = !settled && !!previous && this.bookedBefore(previous);
    // 单据按现在内容算出的金额：有效的更正单“有差异”时 amount_cents 还空着（红字冲销并重做时才算），
    // 这里按替代单评估（effective）算出来，记进快照，“改了什么”拿它比金额；已撤销、被替代的单据没有金额，是 null
    const documentAmount = recordedAmount(source.kind, effective);
    const listed = changed && this.listedChanges(context, effective, documentAmount);
    const snapshot = snapshotText({
      doc,
      money: result.money,
      documentAmount,
      taxSource: result.taxSource,
      theoretical: effective.theoretical,
      financialLines: result.financialLines,
      missing: result.missing,
      warnings: result.warnings,
      previous: previousOf(previous),
    });
    if (previous?.source_hash === context.hash) {
      this.refreshEvaluated(context, previous, result, snapshot);
      return;
    }
    const id = this.insertEvaluated(context, {
      amount: recordedAmount(source.kind, result),
      snapshot,
      status: changed ? 'difference' : result.status,
      problem: changed ? differenceProblem(source.status, doc, true, listed) : result.problem,
    });
    if (previous) this.handOver(context, previous, changed);
    const current = readEvent(this.db, id);
    if ((current.status === 'info_pending' || current.status === 'waiting_invoice') && current.amount_cents)
      provisionalObligation(this.store, user, current, doc);
    this.observe(source, id);
    financeAudit(this.store, user, { action: 'sync', entity: 'fin_events', id, before: null, after: readEvent(this.db, id) });
  }

  /** 指纹没变（资料待补、还没挂往来的重新评估）：在原来那条上按新的评估刷新 */
  private refreshEvaluated({ user, source, doc }: SyncContext, previous: FinanceEvent, result: Evaluation, snapshot: string) {
    this.db
      .prepare('UPDATE fin_events SET status=?,problem=?,snapshot=?,amount_cents=?,version=version+1 WHERE id=?')
      .run(result.status, result.problem, snapshot, recordedAmount(source.kind, result), previous.id);
    const after = readEvent(this.db, previous.id);
    if (after.amount_cents) provisionalObligation(this.store, user, after, doc);
    financeAudit(this.store, user, { action: 'refresh', entity: 'fin_events', id: previous.id, before: previous, after });
    this.observe(source, previous.id);
  }

  /** 新记一条事件，返回编号 */
  private insertEvaluated(
    { source, eventType, hash, policy }: SyncContext,
    event: { amount: number | null; snapshot: string; status: string; problem: string | null },
  ) {
    return Number(
      this.db
        .prepare(
          `INSERT INTO fin_events
      (source_kind,source_id,event_type,source_version,source_hash,date,amount_cents,snapshot,status,problem,revenue_recognition)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          source.kind,
          source.id,
          eventType,
          source.version,
          hash,
          source.date,
          event.amount,
          event.snapshot,
          event.status,
          event.problem,
          policy,
        ).lastInsertRowid,
    );
  }

  /**
   * 送货、到货上一条还没处理的“有差异”“待撤销核销”由新的这条接手：更正按单据找原往来，新的这条能红冲同样的往来；
   * 留着上一条的话，它对不上来源当前版本，更正会被拒、也不再自动收尾，结账就一直卡着。
   */
  private handOver({ user, source }: SyncContext, previous: FinanceEvent, changed: boolean) {
    const takes =
      (!changed && ['ready', 'info_pending', 'waiting_invoice', 'cost_pending'].includes(previous.status)) ||
      (['difference', 'awaiting_allocation_reversal'].includes(previous.status) && ['delivery', 'arrival'].includes(source.kind));
    if (!takes) return;
    supersedeEvent(this.store, user, previous);
    supersedeObligations(
      this.store,
      user,
      many(this.db, rows.fin_obligations, 'SELECT * FROM fin_obligations WHERE event_id=? AND voucher_id IS NULL', previous.id),
    );
  }

  /** 启用前的单据：保留忽略标记，避免启用前历史占满扫描批次。 */
  private ignoreBeforeOpening(user: Actor, source: ObservedSource, eventType: string, hash: string) {
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO fin_events
      (source_kind,source_id,event_type,source_version,source_hash,date,snapshot,status)
      VALUES(?,?,?,?,?,?,?,'before_opening')`,
        )
        .run(source.kind, source.id, eventType, source.version, hash, source.date, snapshotText({}))
        .lastInsertRowid,
    );
    this.observe(source, id);
    financeAudit(this.store, user, {
      action: 'ignore_before_opening',
      entity: 'fin_events',
      id,
      before: null,
      after: readEvent(this.db, id),
    });
  }

  /**
   * 送货、到货已撤销或被更正替代、名下又什么都没挂（还没入过账）：系统挂的暂估往来作废，事件直接记成已更正，
   * 不要人红冲。已经记成已更正的又改了内容，就地换成新内容，不多一条。
   */
  private recordInactive(context: SyncContext, related: string[]) {
    const { user, source, doc, previous, hash, eventType, policy } = context;
    releaseProvisionalObligations(this.store, user, source.kind, related);
    const previousDoc = previous ? readSnapshot(previous).doc : undefined;
    if (previous?.status === 'corrected' && (source.observed === 'reversed' || !!previousDoc?.replacedBy)) {
      // 已经记成已更正的失效单据又改了内容（管理员补备注、改订单拆单）：就地换成新内容，不多一条
      this.refreshInPlace(context, previous);
      return;
    }
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO fin_events
        (source_kind,source_id,event_type,source_version,source_hash,date,snapshot,status,problem,revenue_recognition)
        VALUES(?,?,?,?,?,?,?,'corrected',?,?)`,
        )
        .run(
          source.kind,
          source.id,
          eventType,
          source.version,
          hash,
          source.date,
          snapshotText({ doc, money: null, previous: previousOf(previous) }),
          '单据已撤销或被更正替代，还没入过账，不用处理。',
          policy,
        ).lastInsertRowid,
    );
    if (previous && ['ready', 'info_pending', 'waiting_invoice', 'no_amount', 'difference'].includes(previous.status))
      supersedeEvent(this.store, user, previous);
    this.observe(source, id);
    financeAudit(this.store, user, { action: 'sync', entity: 'fin_events', id, before: null, after: readEvent(this.db, id) });
  }

  /** 失效单据又改了内容：在原事件上换成新内容（状态、上一条都不动），不多一条 */
  private refreshInPlace({ user, source, doc, hash }: SyncContext, previous: FinanceEvent) {
    const id = previous.id;
    this.db
      .prepare('UPDATE fin_events SET source_version=?,source_hash=?,date=?,snapshot=?,version=version+1 WHERE id=?')
      .run(source.version, hash, source.date, snapshotText({ ...readSnapshot(previous), doc }), id);
    financeAudit(this.store, user, { action: 'refresh', entity: 'fin_events', id, before: previous, after: readEvent(this.db, id) });
    this.observe(source, id);
  }

  private observe(source: ObservedSource, id: number) {
    this.db
      .prepare(
        `INSERT INTO fin_source_observations(source_kind,source_id,source_version,status,event_id) VALUES(?,?,?,?,?) ON CONFLICT(source_kind,source_id)
      DO UPDATE SET source_version=excluded.source_version,status=excluded.status,event_id=excluded.event_id`,
      )
      .run(source.kind, source.id, source.version, source.status, id);
  }
}
