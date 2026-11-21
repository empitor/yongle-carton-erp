/** 财务待处理页的读：事件列表、事件详情（含“改了什么”），和还没同步进来的已确认单据（月度台账、报表检查用）。 */
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { clampPage, count, many, parsePaging, rows } from '../core/index.js';
import { financeFacts } from '../flow/index.js';
import { financeActor } from './core.js';
import { lapsedStatuses, readSourceOrSkip, sourceIs, sourceKey, sourceTexts, unseenConfirmed } from './source-scan.js';
import { periodOf } from './days.js';
import { eventChangesSince, PREVIOUS_CHAIN_MAX } from './event-changes.js';
import { evaluateSource, partyTaxTerms, taxBasis } from './event-evaluate.js';
import { readEvent, revenuePolicy } from './event-shared.js';
import { bookingDate, endOfMonth } from './periods.js';
import { id as recordId } from './query.js';
import { isReversed } from './reversal-pairs.js';
import { sourceBooked } from './event-source-obligations.js';
import { eventColumns } from './event-columns.js';
import { readSnapshot } from './source-snapshot.js';
import { eventStatuses } from './stored-values.js';

// 事件列表能筛的状态：存进库的状态里，被新版本替代的、启用前的不在列表里出现
const eventStatus = z.enum(eventStatuses).exclude(['superseded', 'before_opening']);
/** 事件列表一行：事件几列和单号，同一张单据分组排序用的几列，红冲状态、上一条，会不会重做、能不能保留凭证 */
const listedEvent = rows.fin_events
  .pick({
    id: true,
    source_kind: true,
    source_id: true,
    event_type: true,
    date: true,
    amount_cents: true,
    status: true,
    voucher_id: true,
    problem: true,
    version: true,
  })
  .extend({
    number: z.string().nullable(),
    group_kind: z.string(),
    group_id: z.string(),
    group_date: z.string(),
    reversal_state: z.enum(['reversed', 'reversal']).nullable(),
    previous_event_id: z.number().nullable(),
    rebuild: z.number(),
    keepable: z.number(),
    replacement_booked: z.number().nullable(),
  });
type ListedEvent = z.output<typeof listedEvent>;
/** 红字冲销的默认日期：撤销（更正）那天所在月份已结账的，记到最早没结账月份的 1 号（movedTo）；没有那天是 null */
const correctionDate = (reversedOn: string | undefined, movedTo: (date: string) => string | null) =>
  reversedOn === undefined ? null : (movedTo(reversedOn) ?? reversedOn);
/** 沿着“上一条”找原来那张凭证时每一步读的：事件编号、凭证号、它的上一条 */
const chainStep = z.object({ id: z.number(), voucher_id: z.number().nullable(), previous: z.number().nullable() });

export class FinanceEventViews {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  /** 这几个月里已确认、这一版还没同步进财务的送货、到货单，按单据现在的内容先算上（月度台账、报表检查用） */
  unsynced(actor: Actor | null, period: string, lastPeriod = period) {
    financeActor(actor);
    const unseen = unseenConfirmed(this.db, period + '-01', endOfMonth(lastPeriod));
    const texts = sourceTexts(this.db, unseen);
    const policyByDate = new Map<string, string>();
    const taxTerms = partyTaxTerms(this.db);
    // 内容读不出来的跳过（一张坏单据不让台账、报表检查整页出错），它照样算在 unseenSources 里拦结账
    return unseen.flatMap(({ previous, observed: _observed, ...head }) => {
      // 同一次读里对照出来的单据都读得到原文（heads 和 texts 是同一个口径）
      const source = texts.get(sourceKey(head));
      const read = source && readSourceOrSkip(this.db, source);
      if (!source || !read) return [];
      const { doc } = read;
      const at = doc.confirmedAt ?? source.at;
      let policy = policyByDate.get(at);
      if (policy === undefined) {
        policy = revenuePolicy(this.db, at);
        policyByDate.set(at, policy);
      }
      const result = evaluateSource(this.db, source, doc, { policy, replacement: true, taxTerms });
      const snapshot = {
        doc,
        money: result.money,
        theoretical: result.theoretical,
        taxSource: result.taxSource,
        financialLines: result.financialLines,
        warnings: result.warnings,
        missing: result.missing,
      };
      // 单号、往来单位和同步以后存进事件列的同一个取法（月度台账按它们列）
      const columns = eventColumns(snapshot);
      return [
        {
          id: previous,
          source_kind: source.kind,
          source_id: source.id,
          date: source.date,
          amount_cents: (source.kind === 'delivery' ? result.money?.gross : result.money?.net) ?? null,
          status: result.status,
          missing: result.missing ?? [],
          problem: result.problem,
          theoretical: result.theoretical?.gross ?? null,
          number: columns.source_number,
          party: columns.party_name,
          snapshot,
        },
      ];
    });
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const row = readEvent(this.db, recordId.parse(rawId));
    const snapshot = readSnapshot(row);
    return {
      ...row,
      snapshot,
      previous: row.previous_event_id === null ? null : readEvent(this.db, row.previous_event_id),
      // 有差异时详情里列“改之前 / 改之后”，只列变了的、和财务有关的项
      // 金额：有效的更正单“有差异”时 amount_cents 还空着，用同步时按单据内容算出的 document_cents（和 sync 里的比法一致）
      changes: eventChangesSince(this.db, row.previous_event_id, row.source_kind, row.event_type, {
        doc: snapshot.doc ?? {},
        date: row.date,
        amount: row.amount_cents ?? row.document_cents,
        ...taxBasis(row),
      }),
    };
  }

  list(actor: Actor | null, query: unknown) {
    financeActor(actor);
    const q = z.object({ status: eventStatus.optional() }).parse(query);
    const { page: requested, pageSize } = parsePaging(query);
    const where = "WHERE (? IS NULL OR status=?) AND status NOT IN ('before_opening','superseded')";
    const args = [q.status ?? null, q.status ?? null];
    const total = count(this.db, 'SELECT count(*) FROM fin_events ' + where, ...args);
    const page = clampPage(requested ?? 1, pageSize, total);
    const listed = many(
      this.db,
      listedEvent,
      // 同一张单据的几条（原来那条、做红字冲销的那条、重做的那条）排在一起，组内按先后；组按组里最晚的日期倒序，编号兜底保证翻页稳定。
      `SELECT * FROM (SELECT *,max(date) OVER (PARTITION BY group_kind,group_id) AS group_date FROM (
      SELECT id,source_kind,source_id,source_number AS number,event_type,date,amount_cents,status,
      voucher_id,problem,version,
      source_kind AS group_kind,
      source_id AS group_id,
      CASE WHEN status NOT IN ('corrected','superseded') AND (
          EXISTS(SELECT 1 FROM fin_vouchers red WHERE red.reversal_of=e.voucher_id AND red.status<>'void')
          OR EXISTS(SELECT 1 FROM fin_obligations o WHERE o.event_id=e.id AND o.reversal_of IS NULL AND ${isReversed('o')}))
        THEN 'reversed'
        WHEN status='corrected' AND EXISTS(SELECT 1 FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
          WHERE r.event_id=e.id AND r.reversal_of IS NOT NULL AND rv.status<>'void') THEN 'reversal' END AS reversal_state,
      previous_event_id,
      -- 红字冲销后会不会重做：和 correct() 一样，单据还有效、没被更正替代才重做；已撤销、被替代、删掉的只红冲。
      -- 来源现在的状态（被更正替代的原单也是已撤销，还没补扫进来的撤销、删除也算，sourceIs）
      CASE WHEN e.source_kind IN ('delivery','arrival') AND ${sourceIs('e', 'confirmed')} THEN 1 ELSE 0 END AS rebuild,
      -- 单据已删的：名下有出过凭证的往来才能“核对无误，保留凭证”
      CASE WHEN e.status='source_deleted' AND ${sourceBooked('e')} THEN 1 ELSE 0 END AS keepable,
      -- “有差异”的到货要算红字冲销的默认日期（reversalDates）；替代单记过账（有已生成凭证的事件）以后再改的不算原单撤销那天
      CASE WHEN e.source_kind='arrival' AND e.status='difference' THEN EXISTS(SELECT 1 FROM fin_events g
        WHERE g.source_kind='arrival' AND g.source_id=e.source_id AND g.status='generated') END AS replacement_booked
      FROM fin_events e ${where}))
      ORDER BY group_date DESC,group_kind,cast(group_id AS INTEGER) DESC,group_id DESC,id LIMIT ? OFFSET ?`,
      lapsedStatuses(this.db),
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    const voucherOf = this.previousVouchers(listed);
    const movedTo = this.bookingDates();
    const reversedOn = this.reversalDates(listed);
    return {
      rows: listed.map(({ previous_event_id: _previous, group_date: _date, group_kind: _kind, group_id: _group, replacement_booked: _booked, ...r }) => ({
        ...r,
        previous_voucher_id: voucherOf.get(r.id) ?? null,
        // 可记账的单据所在月份已结账：生成凭证时记到哪天（和 generate 同一个 bookingDate），界面提示一句；没换日期的是 null
        booking_date: r.status === 'ready' && r.voucher_id == null ? movedTo(r.date) : null,
        // 撤销、更正过的到货红字冲销的默认日期：撤销（更正）那天，那个月已结账的记到最早没结账月份的 1 号；别的是 null
        correction_date: correctionDate(reversedOn.get(r.id), movedTo),
      })),
      page,
      pageSize,
      filteredRecords: total,
    };
  }

  /**
   * 这一页里“有差异”的到货撤销（更正）那天（事件编号 → 日期）：已撤销的是冲回它库存的流水日期；更正出来的替代单还没记过账时
   * （更正带出来的那一次“有差异”）取原单冲回流水的日期，记过账以后再改的不算。都取最晚的，没有的不在结果里。
   */
  private reversalDates(listed: ListedEvent[]) {
    const out = new Map<number, string>();
    const arrivals = listed.filter((r) => r.replacement_booked !== null);
    if (!arrivals.length) return out;
    const found = financeFacts.sources.arrivalReversalDates(this.db, arrivals.map((r) => r.source_id));
    for (const r of arrivals) {
      const dates = found.get(r.source_id);
      const days = [dates?.own, r.replacement_booked ? null : dates?.replaced].filter((d): d is string => !!d);
      const latest = days.sort().at(-1);
      if (latest) out.set(r.id, latest);
    }
    return out;
  }

  /** 原来那张凭证：沿着“上一条”往前找最近一张有凭证的。同一张单改了几次，中间的“有差异”自己都没有凭证 */
  private previousVouchers(listed: ListedEvent[]) {
    const voucherOf = new Map<number, number | null>();
    let pending = new Map<number, number>(); // 事件 → 当前查到的上一条
    for (const r of listed) if (r.previous_event_id != null) pending.set(r.id, r.previous_event_id);
    for (let depth = 0; pending.size && depth < PREVIOUS_CHAIN_MAX; depth++) {
      const steps = many(
        this.db,
        chainStep,
        'SELECT id,voucher_id,previous_event_id AS previous FROM fin_events WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify([...new Set(pending.values())]),
      );
      const found = new Map(steps.map((p) => [p.id, p]));
      const next = new Map<number, number>();
      for (const [eventId, previousId] of pending) {
        const p = found.get(previousId);
        if (!p) continue;
        if (p.voucher_id != null) voucherOf.set(eventId, p.voucher_id);
        else if (p.previous != null) next.set(eventId, p.previous);
      }
      pending = next;
    }
    return voucherOf;
  }

  /** 这天所在月份已结账时记到哪天（bookingDate：最早没结账月份的 1 号），没结账的是 null；同一页里同一个月只查一次 */
  private bookingDates() {
    const moved = new Map<string, string | null>();
    return (date: string) => {
      const period = periodOf(date);
      if (!moved.has(period)) {
        const booked = bookingDate(this.db, date);
        moved.set(period, booked === date ? null : booked);
      }
      return moved.get(period) ?? null;
    };
  }
}
