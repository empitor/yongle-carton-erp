import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { audit, inSavepoint, isLocalAdministrator, onceByRequest, one, operationRequest, requirePermission, rows } from '../core/index.js';
import { quantityUnits, today } from '../../shared/core/index.js';
import {
  flowDeliveredSchema,
  flowSaveMetaSchema,
  flowScheduledSchema,
  flowScheduleSchema,
  flowViewSchema,
  rawStockKey,
  type FlowDocument,
  type FlowDocView,
  type FlowKind,
} from '../../shared/business/index.js';
import { OperationsService } from '../operations/index.js';
import { fail, type FinishedStockInput, type FlowCommands, type NewRawItem } from './base.js';
import { insertFlowDocument, writeFlowDocument } from './document-store.js';
import { StockFlowService } from './stock-entries.js';
import { StockViews } from './stock-views.js';
import { rewriteRefs } from './refs.js';
import { documentInput, validateFlow } from './validate.js';
import { arrivalRecords } from './arrivals.js';
import { recomputeAfterMaintenance, refreshOrderProgress, updateOrders } from './order-progress.js';
import { draftIds, get, list, storedDocument, taskUntouched, viewOfKind, waitingGood } from './read.js';
import { preview } from './preview.js';
import { confirm } from './confirm.js';
import { cancel, reverse } from './undo.js';

/*
 * 单据流转的服务：保存、排期、送达、归档写在这里，读单据、核对预览、确认、取消撤销、到货
 * 分在同目录各自的文件里（更正在 correction.ts、说明编辑在 document-info.ts，不经过这个类），这里按原来的方法名转调（别的模块和路由都通过 FlowService 用）。
 * 拆出去的文件只认 base.ts 的 FlowCommands，不引用这个文件。
 * views 是采购单、库存品、订货单、流水的完整视图，stock 是采购单、库存品的保存入口（别的模块经这两个用）。
 */
export class FlowService implements FlowCommands {
  readonly ops: OperationsService;
  readonly views: StockViews;
  readonly stock: StockFlowService;
  constructor(readonly store: Store) {
    this.ops = new OperationsService(store);
    this.views = new StockViews(store);
    this.stock = new StockFlowService(this, this.views);
  }
  // 读单据在 read.ts；核对预览、确认、取消和撤销在 preview.ts、confirm.ts、undo.ts，这里保留原来的调用方式
  waitingGood(taskIds?: readonly number[], excludeId?: number) {
    return waitingGood(this.store, taskIds, excludeId);
  }
  list<K extends FlowKind = FlowKind>(kind?: K, includeArchived = false, workbenchDate?: string, ids?: readonly number[]): FlowDocView<K>[] {
    return list(this.store, kind, includeArchived, workbenchDate, ids);
  }
  draftIds(kind?: FlowKind) {
    return draftIds(this.store, kind);
  }
  get<K extends FlowKind = FlowKind>(id: number, kind?: K): FlowDocView<K> {
    return get(this.store, id, kind);
  }
  preview(id: number, who: Actor | null | undefined) {
    return preview(this, id, who);
  }
  confirm(id: number, raw: unknown, who: Actor | null | undefined) {
    return confirm(this, id, raw, who);
  }
  cancel(id: number, raw: unknown, who: Actor | null | undefined) {
    return cancel(this, id, raw, who);
  }
  reverse(id: number, raw: unknown, who: Actor | null | undefined) {
    return reverse(this, id, raw, who);
  }
  /**
   * options.moved：本机管理员拆分送货单时新建的那张单用。它的行是从原单原样搬过来的，不是新增的发货，
   * 不按订单剩余可发数量核对；这里也不记“新建待核对单据”的审计（新单随后沿用原单的状态，由拆单的地方记准）。
   * 别的账号传了不生效。
   */
  save<K extends FlowKind>(kind: K, raw: unknown, who: Actor | null | undefined, id?: number, options: { moved?: boolean; registered?: boolean } = {}): FlowDocView<K> {
    const actor = requirePermission(who, 'business:edit'),
      v: FlowDocument = documentInput(kind, raw),
      meta = flowSaveMetaSchema.parse(raw),
      moved = options.moved === true && isLocalAdministrator(actor);
    const target = { id, moved, registered: options.registered === true, version: meta.version };
    return inSavepoint(this.store.db, () => {
      if (!meta.requestId) return viewOfKind(this.saveDocument(v, actor, target), kind);
      const request = operationRequest('flow-save', meta.requestId, actor, { kind, id: id || null, input: v, version: meta.version });
      return onceByRequest(this.store, request, () => viewOfKind(this.saveDocument(v, actor, target), kind), flowViewSchema(kind));
    });
  }
  private saveDocument(v: FlowDocument, actor: Actor, target: SaveTarget) {
    const before = target.id ? this.get(target.id) : null,
      task = before ? this.editableTask(before, v, actor, target.version) : null;
    if (v.kind === 'production') v.finishedStockId = this.finishedStockOf(v, actor, before ? '完工单 ' + before.number : undefined);
    validateFlow(this, v, actor, false, { excludingId: target.id, skipRemaining: target.moved, registered: target.registered });
    // 安排生产就是下达：生产任务不动库存，新建时直接存成已下达，没有“待下达”这一步
    const issued = v.kind === 'task' && !before,
      id = target.id ? this.rewrite(target.id, v, task) : this.insert(v, actor);
    rewriteRefs(this.store, id, v);
    this.refreshTaskOrders(v, issued, task);
    const after = this.get(id);
    if (!target.moved)
      audit(this.store, actor, {
        action: task ? 'update-confirmed-task' : before ? 'update-draft' : issued ? 'issue-task' : 'create-draft',
        entity: 'flow_' + v.kind,
        id,
        document: { before, after },
      });
    return after;
  }
  /**
   * 改已有的单据之前核对：同一种、还没核对、没归档、版本和打开时一样。
   * 已下达的生产任务能改（任务不动库存）：还没开工（没有完工登记，含待入库的）的业务账号能改；
   * 开工以后只有本机管理员能改，不能换产品，做完了不能改计划日，计划数不能改小到已登记的完工数以下。
   * 返回能改的已下达生产任务，别的单据是 null。
   */
  private editableTask(before: FlowDocView, v: FlowDocument, actor: Actor, version: unknown) {
    const confirmed = v.kind === 'task' && before.kind === 'task' && before.status === 'confirmed' ? before : null,
      untouched = confirmed !== null && taskUntouched(this.store, confirmed.id),
      task = confirmed && (untouched || isLocalAdministrator(actor)) ? confirmed : null;
    if (before.kind !== v.kind || (before.status !== 'draft' && !task))
      fail(
        v.kind === 'task' && before.status === 'confirmed'
          ? '这张生产任务已经有完工单，不能再改；要少做请取消剩余任务，要多做请再安排一张。'
          : '只能修改还没核对的单据；已生效的到货、送货、完工单改数量用“更正到货单”“更正送货单”“更正完工单”，只改备注这类用“编辑”，整张没发生用撤销。',
        409,
      );
    if (before.archived) fail('这张单据已归档，请先恢复再改。');
    if (before.version !== version) fail('单据已被修改，请刷新。', 409);
    if (task && !untouched && v.kind === 'task') checkStartedTask(task, v);
    return task;
  }
  /** 整份写回改过的单据；改已下达的任务：保留下达人和下达时间，产品名跟着新产品走 */
  private rewrite(id: number, v: FlowDocument, task: FlowDocView<'task'> | null) {
    const stored: FlowDocument =
      task && v.kind === 'task'
        ? { ...storedDocument(this.store, task.id, 'task'), ...v, productName: this.store.product(v.productId, true)?.name }
        : v;
    writeFlowDocument(this.store, id, stored, { date: v.date, at: new Date().toISOString() });
    return id;
  }
  /** 新建一张单据，返回编号；生产任务新建就是下达：和确认后的单据一样带上产品名、下达人和下达时间 */
  private insert(v: FlowDocument, actor: Actor) {
    const at = new Date().toISOString();
    return insertFlowDocument(this.store, {
      date: v.date,
      status: v.kind === 'task' ? 'confirmed' : 'draft',
      document: v.kind === 'task' ? { ...v, productName: this.store.product(v.productId, true)?.name, confirmedBy: actor.name, confirmedAt: at } : v,
      actor,
      at,
    });
  }
  /** 下达了任务、已下达任务改了数量和订单：订单的生产状态重新算 */
  private refreshTaskOrders(v: FlowDocument, issued: boolean, task: FlowDocView<'task'> | null) {
    if (v.kind !== 'task') return;
    if (issued) updateOrders(this, v.orderIds || []);
    if (task) updateOrders(this, [...new Set([...(task.orderIds || []), ...(v.orderIds || [])])]);
  }
  schedule(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'), input = flowScheduleSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      return onceByRequest(this.store, operationRequest('flow-schedule', input.requestId, actor, { id, ...input }), (): Scheduled => {
        const before = this.get(id);
        if (before.version !== input.expectedVersion) fail('任务已修改，请刷新后安排日期。', 409);
        if (before.archived || (before.kind !== 'task' && before.kind !== 'delivery') ||
          (before.kind === 'delivery' ? before.status !== 'draft' : before.status !== 'confirmed' || before.progress >= 100))
          fail('仅可调整未完成生产任务或待送货的送货单。', 409);
        const doc = { ...storedDocument(this.store, id, before.kind), plannedDate: input.plannedDate, ...(input.plannedTime !== undefined ? { plannedTime: input.plannedTime } : {}) };
        writeFlowDocument(this.store, id, doc, { at: new Date().toISOString() });
        const after = this.get(id, before.kind);
        audit(this.store, actor, {
          action: 'schedule',
          entity: 'flow_' + before.kind,
          id,
          document: { before, after, requestId: input.requestId },
        });
        return { document: after, verified: after.plannedDate === input.plannedDate, inventoryChanged: false };
      }, flowScheduledSchema);
    });
  }
  // 下面几个的实现在同目录的 arrivals.ts、order-progress.ts，这里保留原来的调用方式
  arrivalRecords(raw: unknown = {}, scope?: { flowIds?: readonly number[] }) {
    return arrivalRecords(this, raw, scope);
  }
  recomputeAfterMaintenance(affectedOrders?: number[]) {
    recomputeAfterMaintenance(this, affectedOrders);
  }
  refreshOrderProgress(ids?: number[], onlyChanged = false) {
    refreshOrderProgress(this, ids, onlyChanged);
  }
  maintenanceReferences(id: number) {
    rewriteRefs(this.store, id, this.get(id));
  }
  /**
   * 导出送货单就是装车出库：待送货的送货单在这一步核对并出库（扣库存、算进订单已发），状态变“送货中”。
   * 和人工“核对并发货”是同一个确认，库存不够、订单变了照样拦下；送货单版本变了不出库。
   * shipDate：出库日不是今天时给（导出文件和交付完成跨了零点，按纸上印的那天出库），核对规则见 confirm.ts。
   */
  shipDelivery(id: number, expectedVersion: number, who: Actor | null | undefined, shipDate?: string) {
    const actor = requirePermission(who, 'business:edit');
    const doc = this.get(id);
    if (doc.kind !== 'delivery') fail('请选择送货单。');
    if (doc.status === 'confirmed') return doc;
    if (doc.version !== expectedVersion) fail('送货安排已变化，文件已交付但没有出库，请读取最新送货单后重新导出。', 409);
    const check = this.preview(id, actor);
    return this.confirm(
      id,
      { previewDigest: check.previewDigest, requestId: randomUUID(), acknowledged: true, ...(shipDate ? { shipDate } : {}) },
      actor,
    );
  }
  /** 导出送货单之前先按出库规则核对一遍（库存、订单、单位、规格），不通过就不生成文件。 */
  checkShippable(id: number, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit');
    const doc = this.get(id);
    if (doc.kind !== 'delivery' || doc.status !== 'draft' || doc.archived) fail('只有待送货的送货单能导出出库。', 409);
    validateFlow(this, doc, actor, true);
  }
  /** 客户收到货了：只记送达，不动库存（出库在导出送货单时已经做了）。 */
  /**
   * 完工入哪个成品库存由产品决定：一个产品只有一个成品库存，没有就按产品建、归档了就恢复
   * （OperationsService.finishedStockFor），传了 finishedStockId 的必须就是这个产品的那一个。
   * 产品不存在、已归档的不建库存，留给 validate 照常报。document 是这张完工单（还没编号时用它的生产任务），
   * 自动新建、恢复成品库存的审计里写上。
   */
  finishedStockOf(v: FinishedStockInput, actor: Actor, document?: string) {
    if (!this.store.product(v.productId, isLocalAdministrator(actor))) return v.finishedStockId;
    const task = !document && v.taskId ? one(this.store.db, rows.flow_documents.pick({ number: true }), 'SELECT number FROM flow_documents WHERE id=?', v.taskId) : null;
    return this.ops.finishedStockFor(v.productId, actor, v.finishedStockId, document ?? (task ? '生产任务 ' + task.number : undefined)).item.id;
  }
  /**
   * 到货行没选库存品：同一种原材料只有一个库存品（rawStockKey 相同就是同一种，归档的也算），
   * 库里已经有一样的就入到它那里（归档的自动恢复），没有才新建；一张单据里一样的几行共用一个。
   */
  createdItem(created: Map<string, number>, item: NewRawItem, actor: Actor, document: string) {
    const key = rawStockKey(item);
    const id = created.get(key) ?? this.ops.rawStockFor(item, actor, document).id;
    created.set(key, id);
    return id;
  }
  markDelivered(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      v = flowDeliveredSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      const doc = this.get(id);
      if (doc.kind !== 'delivery' || doc.status !== 'confirmed' || doc.archived) fail('只有已出库的送货单能确认送达。', 409);
      // 已经确认过就原样返回：双击、网络重试不报“已变化”
      if (doc.deliveredAt) return doc;
      if (doc.version !== v.version) fail('送货单已变化，请刷新后再确认。', 409);
      // 送达日期按业务时区算（北京时间），界面会预填今天让人确认或改
      const date = v.date || today(),
        shipped = today(new Date(shippedAt(doc)));
      if (date > today()) fail('送达日期不能晚于今天。');
      if (date < shipped) fail('送达日期不能早于出库日期 ' + shipped + '。');
      // 在库里存的那份内容上加送达记录（不是把视图写回去），送达日期列跟着一起写
      const stored = storedDocument(this.store, id, 'delivery');
      writeFlowDocument(this.store, id, { ...stored, deliveredAt: date, deliveredBy: actor.name }, { at: new Date().toISOString() });
      const after = this.get(id, 'delivery');
      audit(this.store, actor, {
        action: 'delivered',
        entity: 'flow_delivery',
        id,
        document: { before: doc, after },
      });
      return after;
    });
  }
}

/** 保存改哪张（没有 id 是新建）、打开时的版本、是不是拆单搬过来的行（moved）、是不是登记到货按订货单存的（registered） */
type SaveTarget = { id?: number; version: unknown; moved: boolean; registered: boolean };
/** 排期的结果（同一请求号再交时按它核对上次存下的结果） */
type Scheduled = z.output<typeof flowScheduledSchema>;
/**
 * 已开工的生产任务（本机管理员改）：不能换产品，做完了不能改计划日；
 * 这次把计划数改小的，不能改到比已登记的完工数还少（已入库加待核对入库，和任务视图的完工进度同一口径，取消、撤销的不算）。
 * 完工本来允许超计划（只提示），计划数没动或改大的不查，超产的任务照样能改备注、计划日
 */
function checkStartedTask(before: FlowDocView<'task'>, v: FlowDocument<'task'>) {
  if (v.productId !== before.productId) fail('这张生产任务已经有完工单，不能换产品。', 409);
  if (before.progress >= 100 && v.plannedDate !== before.plannedDate) fail('这张生产任务已完工，计划生产日期不能再改。', 409);
  const planned = quantityUnits(v.quantity),
    registered = quantityUnits(before.completed) + quantityUnits(before.pendingCompleted);
  if (planned < quantityUnits(before.quantity) && planned < registered)
    fail('计划数不能少于已登记的完工数（已入库 ' + before.completed + ' ' + before.unit + '，待核对入库 ' + before.pendingCompleted + ' ' + before.unit + '）。');
}
/** 已出库送货单的出库时间：确认出库时写的，没有就是这张单据有问题，说清楚，不按别的时间算 */
function shippedAt(doc: FlowDocView<'delivery'>) {
  if (!doc.shippedAt) return fail('送货单 ' + doc.number + ' 没有出库时间记录，不能确认送达，请先核对这张送货单。', 409);
  return doc.shippedAt;
}
