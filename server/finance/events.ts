/**
 * 业务单据进财务：扫描已确认、已撤销的送货、到货、完工单和盘点流水，
 * 按来源指纹判断新增、替换或标“有差异”，挂暂估往来，来源被删的标“来源已删除”。
 * 一次扫一批（sync）；谁来扫、扫到完见 catch-up.ts。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { count, exists, many, one, rows } from '../core/index.js';
import { financeActor, financeAudit, financeTransaction } from './core.js';
import {
  readSource,
  readSourceOrSkip,
  sourceMissing,
  sourceRow,
  sourcesCte,
  sourceUnseen,
  type SourceRow,
} from './business-source.js';
import { eventChangesSince } from './event-changes.js';
import { differenceProblem, evaluateSource, taxBasis, type Evaluation } from './event-evaluate.js';
import { provisionalObligation, readEvent, revenuePolicy, type FinanceEvent } from './event-shared.js';
import {
  deliveryReversalsPending,
  flagBeforeOpeningChange,
  markSourceDeleted,
  refreshPendingDeliveryReversals,
  supersedeEvent,
} from './event-status.js';
import { eventColumns, insertEvent, updateEventSnapshot } from './event-columns.js';
import { expectRow } from './finance-rows.js';
import { returnEstimatesPending, syncReturnEstimates } from './return-estimates.js';
import { eventSourceKinds } from './stored-values.js';
import { skippedKeys } from './unreadable.js';
import { readSnapshot, type EventSnapshot, type FinanceSourceDocument } from './source-snapshot.js';
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
const startPeriod = rows.fin_settings.pick({ start_period: true });
/** 跳过的来源现在的内容（核对改好了没有，unreadable.ts 的 skippedKeys） */
const sourceContent = sourceRow.pick({ kind: true, id: true, number: true }).extend({ content: z.string() });
/** 来源 s 的“种类:编号”（SQL），和 unreadable.ts 跳过的键同一个写法 */
const sourceKey = (s: string) => `${s}.kind||':'||${s}.id`;

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

/** 被删的来源（FROM 和 WHERE，o 是观察记录、e 是它挂的事件）：财务看到过、还没记成已删除的；启用前的不管 */
const missingSources = `FROM fin_source_observations o JOIN fin_events e ON e.id=o.event_id
        WHERE o.status<>'deleted' AND e.status<>'before_opening' AND ${sourceMissing('o')}`;

/**
 * 截至 end（含）还没同步进财务的来源有几条，和补扫同一个条件：这一版财务还没扫到的（不分种类、状态：新确认的、
 * 内容变了的、已撤销或被更正替代的、盘点流水改写的），加上单据、盘点流水已被删、还没记成已删除的。
 * 补扫前它们还不是事件，结账检查的“业务单据”一步按它们拦；启用前的、只改了说明的也先算上，补扫一次就清掉。
 */
export function unseenSources(db: DatabaseSync, end: string) {
  return count(
    db,
    `${sourcesCte}
    SELECT (SELECT count(*) FROM sources s LEFT JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
      WHERE s.date<=?1 AND ${sourceUnseen('s', 'o')})
      + (SELECT count(*) ${missingSources} AND e.date<=?1)`,
    end,
  );
}

export class FinanceEvents {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  /** 只返回尚未扫描的版本（内容读不出来、已经跳过又没改过的不算），采购投影的来源是同一张到货单。 */
  private sources(limit = BATCH_SIZE) {
    const skipped = skippedKeys(this.db, eventSourceKinds, (keys) =>
      many(
        this.db,
        sourceContent,
        `${sourcesCte} SELECT kind,id,number,document AS content FROM sources s WHERE ${sourceKey('s')} IN (SELECT value FROM json_each(?))`,
        JSON.stringify(keys),
      ),
    );
    return many(
      this.db,
      observedSource,
      `${sourcesCte}
    SELECT s.*,o.event_id AS previous,o.status AS observed FROM sources s
    LEFT JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
    WHERE ${sourceUnseen('s', 'o')} AND ${sourceKey('s')} NOT IN (SELECT value FROM json_each(?))
    LIMIT ?`,
      JSON.stringify(skipped),
      limit,
    );
  }

  /** 财务启用的月份，没启用是 null */
  private start() {
    return expectRow(one(this.db, startPeriod, 'SELECT start_period FROM fin_settings WHERE id=1'), '财务设置').start_period;
  }

  /**
   * 有没有要补扫的（只读）：财务启用了，而且有还没扫到的来源（跳过的不算）、被删还没记的来源、
   * 要自动收尾的已撤销送货（deliveryReversalsPending），或者这个人这次真能记的采购退货暂估。没有的话补扫不开写事务（catch-up.ts）。
   */
  pending(user: Actor) {
    if (!this.start()) return false;
    return (
      this.sources(1).length > 0 ||
      exists(this.db, `SELECT 1 ${missingSources} LIMIT 1`) ||
      deliveryReversalsPending(this.db) ||
      returnEstimatesPending(this.store, user)
    );
  }

  /**
   * 补扫一批（一个写事务）：最多 BATCH_SIZE 条来源、BATCH_SIZE 条被删的来源；扫满了 remaining 是 true，再调一次接着扫。
   * 内容读不出来的来源跳过（unreadable.ts），读出来以后的步骤出错照常抛、整批回滚。
   * 审计记的是 actor（发起这次读取或补扫的人）；财务未启用时什么都不做。
   */
  sync(actor: Actor | null) {
    const user = financeActor(actor);
    return financeTransaction(this.db, () => {
      const start = this.start();
      if (!start) return { processed: 0, remaining: false };
      const sources = this.sources();
      let processed = 0;
      for (const source of sources) {
        const read = readSourceOrSkip(this.db, source);
        if (read) processed += this.syncSource(user, source, start, read);
      }
      const missing = many(this.db, rows.fin_events, `SELECT e.* ${missingSources} LIMIT ?`, BATCH_SIZE);
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

  /** 同步一条来源（read 是读出来的内容和指纹）：返回 1 是新增或改动了事件，0 是只记下看到了（没变、启用前的）。 */
  private syncSource(user: Actor, source: ObservedSource, start: string, { doc, hash }: ReturnType<typeof readSource>) {
    const previous =
      source.previous === null ? undefined : one(this.db, rows.fin_events, 'SELECT * FROM fin_events WHERE id=?', source.previous);
    const policy = previous?.revenue_recognition ?? revenuePolicy(this.db, doc.confirmedAt ?? source.at);
    const context: SyncContext = {
      user,
      source,
      doc,
      previous,
      hash,
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
      ...taxBasis(eventColumns({ missing: effective.missing, theoretical: effective.theoretical })),
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
    // 这里按替代单评估（effective）算出来，记进 document_cents，“改了什么”拿它比金额；已撤销、被替代的单据没有金额，是 null
    const documentCents = recordedAmount(source.kind, effective);
    const listed = changed && this.listedChanges(context, effective, documentCents);
    const snapshot: EventSnapshot = {
      doc,
      money: result.money,
      taxSource: result.taxSource,
      theoretical: effective.theoretical,
      financialLines: result.financialLines,
      missing: result.missing,
      warnings: result.warnings,
    };
    if (previous?.source_hash === context.hash) {
      this.refreshEvaluated(context, previous, result, snapshot, documentCents);
      return;
    }
    const id = insertEvent(
      this.db,
      {
        source_kind: source.kind,
        source_id: source.id,
        event_type: context.eventType,
        source_version: source.version,
        source_hash: context.hash,
        date: source.date,
        amount_cents: recordedAmount(source.kind, result),
        status: changed ? 'difference' : result.status,
        problem: changed ? differenceProblem(source.status, doc, true, listed) : result.problem,
        revenue_recognition: context.policy,
        previous,
        document_cents: documentCents,
      },
      snapshot,
    );
    if (previous) this.handOver(context, previous, changed);
    const current = readEvent(this.db, id);
    if ((current.status === 'info_pending' || current.status === 'waiting_invoice') && current.amount_cents)
      provisionalObligation(this.store, user, current, doc);
    this.observe(source, id);
    financeAudit(this.store, user, { action: 'sync', entity: 'fin_events', id, before: null, after: readEvent(this.db, id) });
  }

  /** 指纹没变（资料待补、还没挂往来的重新评估）：在原来那条上按新的评估刷新（它接手的上一条不变） */
  private refreshEvaluated(
    { user, source, doc }: SyncContext,
    previous: FinanceEvent,
    result: Evaluation,
    snapshot: EventSnapshot,
    documentCents: number | null,
  ) {
    updateEventSnapshot(this.db, previous.id, snapshot, {
      status: result.status,
      problem: result.problem,
      amount_cents: recordedAmount(source.kind, result),
      document_cents: documentCents,
    });
    const after = readEvent(this.db, previous.id);
    if (after.amount_cents) provisionalObligation(this.store, user, after, doc);
    financeAudit(this.store, user, { action: 'refresh', entity: 'fin_events', id: previous.id, before: previous, after });
    this.observe(source, previous.id);
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
    const id = insertEvent(
      this.db,
      {
        source_kind: source.kind,
        source_id: source.id,
        event_type: eventType,
        source_version: source.version,
        source_hash: hash,
        date: source.date,
        status: 'before_opening',
      },
      {},
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
    const id = insertEvent(
      this.db,
      {
        source_kind: source.kind,
        source_id: source.id,
        event_type: eventType,
        source_version: source.version,
        source_hash: hash,
        date: source.date,
        status: 'corrected',
        problem: '单据已撤销或被更正替代，还没入过账，不用处理。',
        revenue_recognition: policy,
        previous,
      },
      { doc, money: null },
    );
    if (previous && ['ready', 'info_pending', 'waiting_invoice', 'no_amount', 'difference'].includes(previous.status))
      supersedeEvent(this.store, user, previous);
    this.observe(source, id);
    financeAudit(this.store, user, { action: 'sync', entity: 'fin_events', id, before: null, after: readEvent(this.db, id) });
  }

  /** 失效单据又改了内容：在原事件上换成新内容（状态、上一条都不动），不多一条 */
  private refreshInPlace({ user, source, doc, hash }: SyncContext, previous: FinanceEvent) {
    const id = previous.id;
    updateEventSnapshot(this.db, id, { ...readSnapshot(previous), doc }, {
      source_version: source.version,
      source_hash: hash,
      date: source.date,
    });
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
