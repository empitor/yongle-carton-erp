import { isFlowKind } from '../../shared/core/index.js';
import { z } from 'zod';
import { dailyQuerySchema, flowDocNames, shiftDate, type ArrivalDaily as ArrivalDailyOf, type DailyResult, type DayCount, type DeliveryDaily as DeliveryDailyOf, type FlowDocView, type WarehouseDailyResult } from '../../shared/business/index.js';
import { type Store } from '../core/index.js';
import { many, notFound, one, rows } from '../core/index.js';
import { arrivalRecords } from './rules/arrivals.js';
import { deliveryRecords } from './delivery/daily-deliveries.js';
import { FlowService } from './rules/service.js';

/*
 * 仓库台账（到货、送货、生产任务按日期看）：同一批次按身份合并；计划日与真实完成日分别归属，未计划的实物流转也保留。
 * 查询参数的规则在 shared/business/flow/flow-requests.ts（GET /flow/daily 和助手共用），回答的结构在 shared/business/flow/flow-views.ts。
 */

type DailyQuery = z.output<typeof dailyQuerySchema>;
/** 按日期记账的两种单据（生产任务只按计划日列） */
type Ledger = 'arrival' | 'delivery';

/** 台账里决定日期归属和状态的字段；records() 的每条记录也带这些字段，可直接拿来汇总。 */
type DailyHead = {
  plannedDate: string | null;
  actualDate: string | null;
  completed: boolean;
  cancelled: boolean;
  pending: boolean;
  status: string;
  date: string;
  /** 送货单已出库、还没确认送达（送货中）。 */
  inTransit?: boolean;
  /** 对应的业务单据，按主键组装完整记录时用。 */
  flowId?: number;
};
/**
 * flowIds：按主键只组装这几张单据，不给是全部（到货、送货同一个意思）；
 * includeArchived：点开一张时、今日页算本月发货时连已归档的也读（列表不带）
 */
type DailySelection = { flowIds?: readonly number[]; includeArchived?: boolean };
type MovementRow = z.output<typeof rows.stock_movements>;
type ArrivalDaily = ArrivalDailyOf<MovementRow>;
type DeliveryDaily = DeliveryDailyOf<MovementRow>;
/** 台账查询按种类的结果 */
type DailyResults = WarehouseDailyResult<MovementRow>;

/** 台账里的到货单：到货记录加上台账的日期和状态（到货没有计划日，到货安排在订货单上） */
function arrivalLedger(store: Store, selection?: DailySelection): ArrivalDaily[] {
  return arrivalRecords(new FlowService(store), { includeInactive: true }, selection).map((r) => ({
    ...r,
    actualDate: r.status === 'confirmed' ? r.date : null,
    plannedDate: null,
    completed: r.effective,
    cancelled: !r.effective && r.status !== 'draft',
    pending: r.status === 'draft',
    flowId: r.flowId,
  }));
}

/**
 * 日历每天的计划、实际完成、待执行和合计，取消、冲销的不算。
 * 一次遍历分组；日期按首次出现（先计划日、后实际日）的顺序，与逐日筛选的结果相同。
 */
function dailyCounts(all: readonly DailyHead[]) {
  const counts = new Map<string, DayCount>();
  const slot = (d: string) => {
    const found = counts.get(d);
    if (found) return found;
    const created = { planned: 0, completed: 0, pending: 0, total: 0 };
    counts.set(d, created);
    return created;
  };
  for (const r of all) {
    const planned = r.plannedDate ? slot(r.plannedDate) : null,
      actual = r.actualDate ? slot(r.actualDate) : null;
    if (r.cancelled) continue;
    if (planned) {
      planned.planned++;
      planned.total++;
      if (r.pending) planned.pending++;
    }
    if (actual) {
      if (r.completed) actual.completed++;
      if (r.actualDate !== r.plannedDate) actual.total++;
    }
  }
  return counts;
}
const summaryOf = (counts: Map<string, DayCount>, d: string) => {
  const c = counts.get(d);
  return { planned: c?.planned || 0, completed: c?.completed || 0, pending: c?.pending || 0 };
};
/** 按天看的日历部分：这天的合计和每天的计数 */
const calendarOf = (counts: Map<string, DayCount>, date: string) => ({
  summary: summaryOf(counts, date),
  counts: Object.fromEntries([...counts].map(([d, c]) => [d, { ...c }])),
});
/** 某天要列出的记录：计划在这天、实际在这天，或没排计划、还没核对的登记在这天。 */
const onDay = (r: DailyHead, date: string) =>
  r.plannedDate === date ||
  r.actualDate === date ||
  (!r.plannedDate && r.status === 'draft' && r.date === date);
const statusRow = rows.flow_documents.pick({ id: true, date: true, status: true });

export class WarehouseDaily {
  constructor(readonly store: Store) {}
  records(kind: 'arrival', workbenchDate?: string, selection?: DailySelection): ArrivalDaily[];
  records(kind: 'delivery', workbenchDate?: string, selection?: DailySelection): DeliveryDaily[];
  records(kind: 'task'): FlowDocView<'task'>[];
  records(kind: Ledger, workbenchDate?: string, selection?: DailySelection): (ArrivalDaily | DeliveryDaily)[];
  records(kind: DailyQuery['kind'], workbenchDate?: string, selection?: DailySelection): (ArrivalDaily | DeliveryDaily | FlowDocView<'task'>)[];
  records(kind: DailyQuery['kind'], workbenchDate?: string, selection?: DailySelection): (ArrivalDaily | DeliveryDaily | FlowDocView<'task'>)[] {
    switch (kind) {
      case 'arrival':
        return arrivalLedger(this.store, selection);
      case 'task':
        return new FlowService(this.store).list('task');
      case 'delivery':
        return deliveryRecords(this.store, workbenchDate, selection?.flowIds, selection?.includeArchived);
    }
  }
  /**
   * 台账表头：与 records() 同一顺序、同一合并规则，只读日期、状态和单据表上的镜像列
   * （计划日、送达日），不解析单据内容，不组装明细、采购和流水。
   */
  heads(kind: Ledger): DailyHead[] {
    const db = this.store.db;
    if (kind === 'delivery') {
      const archived = this.store.archivedIds('flow_delivery');
      return many(
        db,
        statusRow.extend({ planned_date: z.string(), delivered_at: rows.flow_documents.shape.delivered_at }),
        "SELECT id,date,status,planned_date,delivered_at FROM flow_documents WHERE kind='delivery' ORDER BY date DESC,id DESC",
      )
        .filter((r) => !archived.has(r.id))
        .map((r) => ({
          flowId: r.id,
          plannedDate: r.planned_date,
          actualDate: r.status === 'confirmed' ? r.date : null,
          completed: r.status === 'confirmed',
          pending: r.status === 'draft',
          cancelled: ['cancelled', 'reversed'].includes(r.status),
          // 确认就是出库（确认时一定写出库时间），所以已确认、还没有送达日的就是送货中
          inTransit: r.status === 'confirmed' && !r.delivered_at,
          status: r.status,
          date: r.date,
        }));
    }
    // 到货单的顺序与 arrivalRecords 一致：按编号倒序（receiptEvents 按编号升序，arrivalRecords 再整体反转）
    const archived = this.store.archivedIds('flow_arrival');
    return many(db, statusRow, "SELECT id,date,status FROM flow_documents WHERE kind='arrival' ORDER BY id DESC")
      .filter((d) => !archived.has(d.id))
      .map((d) => ({
        flowId: d.id,
        plannedDate: null,
        actualDate: d.status === 'confirmed' ? d.date : null,
        completed: d.status === 'confirmed',
        cancelled: d.status !== 'confirmed' && d.status !== 'draft',
        pending: d.status === 'draft',
        status: d.status,
        date: d.date,
      }));
  }
  /** 这些表头对应的完整记录，顺序与全量 records() 中的顺序一致。 */
  recordsFor(kind: 'arrival', heads: readonly DailyHead[]): ArrivalDaily[];
  recordsFor(kind: 'delivery', heads: readonly DailyHead[]): DeliveryDaily[];
  recordsFor(kind: Ledger, heads: readonly DailyHead[]): (ArrivalDaily | DeliveryDaily)[];
  recordsFor(kind: Ledger, heads: readonly DailyHead[]): (ArrivalDaily | DeliveryDaily)[] {
    return this.records(kind, undefined, {
      flowIds: [...new Set(heads.flatMap((h) => (typeof h.flowId === 'number' ? [h.flowId] : [])))],
    });
  }
  /** 已经读过表头的（今日页）：按表头算这一天的计划、完成、待执行，不再读一遍 */
  daySummary(heads: readonly DailyHead[], date: string) {
    return summaryOf(dailyCounts(heads), date);
  }
  get(raw: unknown): DailyResults {
    const q = dailyQuerySchema.parse(raw);
    switch (q.kind) {
      case 'task':
        return { kind: q.kind, date: q.date, records: this.tasksOn(q.date, q.scope) };
      // 点开一张（doc）：只组装这一张，已归档的也读
      case 'arrival':
        if (q.doc) return { kind: q.kind, date: q.date, records: this.records('arrival', undefined, this.single(q.kind, q.doc)) };
        return this.ledger(q.kind, q, () => this.records('arrival'), (heads) => this.recordsFor('arrival', heads));
      case 'delivery':
        if (q.doc) return { kind: q.kind, date: q.date, records: this.records('delivery', undefined, this.single(q.kind, q.doc)) };
        return this.ledger(q.kind, q, () => this.records('delivery'), (heads) => this.recordsFor('delivery', heads));
    }
  }
  /** 点开一张（doc）：按主键认这张单据，编号不存在、不是这种单据报 404 说清楚；只组装它，已归档的也读 */
  private single(kind: Ledger, id: number): DailySelection {
    const row = one(this.store.db, rows.flow_documents.pick({ kind: true }), 'SELECT kind FROM flow_documents WHERE id=?', id);
    if (!row) notFound('没有编号 ' + id + ' 的单据，可能已经删掉了。');
    if (row.kind !== kind)
      notFound('编号 ' + id + ' 的单据' + (isFlowKind(row.kind) ? '是' + flowDocNames[row.kind] : '') + '，不是' + flowDocNames[kind] + '。');
    return { flowIds: [id], includeArchived: true };
  }
  /** 计划在这天的生产任务：按计划日列（有索引）圈出编号，再按主键组装；all 是读全部再筛 */
  private tasksOn(date: string, scope: DailyQuery['scope']) {
    const flow = new FlowService(this.store);
    if (scope === 'all') return flow.list('task').filter((r) => r.plannedDate === date);
    const ids = many(this.store.db, rows.flow_documents.pick({ id: true }), "SELECT id FROM flow_documents WHERE kind='task' AND planned_date=?", date);
    return flow.list('task', false, undefined, ids.map((r) => r.id));
  }
  /**
   * 到货、送货按日期看。recent：还要处理的不管多早都带上，其余按实际日、计划日或单据日期，在最近 days 天里的才带；
   * 按天看先读表头，日历计数用表头算，完整记录只组装当天的；all 读全部完整记录。
   */
  private ledger<K extends Ledger, R extends DailyHead>(
    kind: K,
    q: Pick<DailyQuery, 'date' | 'scope' | 'days'>,
    all: () => R[],
    of: (heads: readonly DailyHead[]) => R[],
  ): DailyResult<K, R> {
    const { date, scope, days } = q;
    if (scope === 'recent') {
      const from = shiftDate(date, -days);
      const heads = this.heads(kind);
      const recent = (h: DailyHead) =>
        h.pending || h.inTransit || [h.actualDate, h.plannedDate, h.date].some((d) => typeof d === 'string' && d >= from);
      return { kind, date, scope, days, from, records: of(heads.filter(recent)), total: heads.length };
    }
    if (scope === 'all') {
      const records = all();
      return { kind, date, ...calendarOf(dailyCounts(records), date), records };
    }
    const heads = this.heads(kind);
    return {
      kind,
      date,
      ...calendarOf(dailyCounts(heads), date),
      records: of(heads.filter((r) => onDay(r, date))).filter((r) => onDay(r, date)),
    };
  }
}
