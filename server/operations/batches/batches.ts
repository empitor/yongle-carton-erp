import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { audit, exists, inSavepoint, many, one, requirePermission, rows } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { peekSequence, takeSequence } from '../../core/index.js';
import { quantityString } from '../../../shared/core/index.js';
import { today } from '../../../shared/core/index.js';
import { batchProgress, batchRowKey, batchRows, batchScheduleSchema, defaultSchedule, purchaseLinesOf, toScheduleEntries, type BatchSourceLine, type ScheduleEntry } from '../../../shared/business/index.js';
import type { OrderBatchBaseView, OrderBatchDraft, PurchaseRowView } from '../../../shared/business/index.js';
import { OperationsRepository } from '../ledger/repository.js';
import { batchScheduleText, readBatchSchedule } from './batch-schedule.js';
import { readPurchaseLineDocument } from '../ledger/ledger.js';

const fail = (message: string, status = 400): never => {
  throw new AppError(message, status);
};

/** 订货单上的行从哪些采购单取：采购单号、下单日期、明细，加上算不算待到货要看的状态和归档 */
type SourcePurchase = Parameters<typeof purchaseLinesOf>[0][number] & { baseStatus: string; archived: boolean };

const memberRow = rows.order_batch_purchases.pick({ batch_id: true, purchase_id: true });
const batchIdRow = rows.order_batches.pick({ id: true });

/** 订货单详情里的一行：合成的行加上这一行是哪种纸板、来自哪几张采购单、每张还差多少 */
function batchRowView({ lines, ...r }: ReturnType<typeof batchRows>[number]) {
  const first = lines[0];
  return {
    ...r,
    // 这一行是哪种纸板（合成一行的明细实物都一样）：AI 识别的送货单按它对订货单（shared/business/arrival-draft.ts）
    board: {
      name: first.name,
      specification: first.specification ?? '',
      length: first.length ?? null,
      width: first.width ?? null,
      height: first.height ?? null,
      dimensionUnit: first.dimensionUnit ?? null,
      material: first.material ?? '',
      flute: first.flute ?? '',
    },
    purchaseNumbers: [...new Set(lines.map((l) => l.purchaseNumber))],
    // 按采购单先后，每条还差多少；登记到货窗口据此显示会分到哪几张采购单
    parts: lines.map((l) => ({
      purchaseNumber: l.purchaseNumber,
      remainingUnits: Math.max(0, l.quantityUnits - l.receivedUnits),
    })),
  };
}

/** 采购单按下单日期、编号排 */
const byOrderDate = (a: PurchaseRowView, b: PurchaseRowView) => a.orderDate.localeCompare(b.orderDate) || a.id - b.id;

/**
 * 订货批次：发给供应商的一份订货单。批次里是同一家供应商的一张或几张采购单；
 * 还差多少由采购明细的已到货缓存派生，批次本身只存采购单清单和到货安排。
 * 读出来的是基本视图，按它登记的到货单由单据流转补（server/flow/stock-views.ts 的 batch）。
 */
export class OrderBatchService {
  private readonly repo: OperationsRepository;
  constructor(readonly store: Store) {
    this.repo = new OperationsRepository(store);
  }
  /** 订货单那一行；不在了是 undefined */
  private head(id: number) {
    return one(this.store.db, rows.order_batches, 'SELECT * FROM order_batches WHERE id=?', id);
  }
  /** 采购单所在的批次编号；不在批次里返回 null。 */
  batchIdOf(purchaseId: number) {
    return one(this.store.db, memberRow, 'SELECT batch_id,purchase_id FROM order_batch_purchases WHERE purchase_id=?', purchaseId)?.batch_id ?? null;
  }
  /**
   * 采购单换了供应商：移出原来的订货单，不能留在别家的订货单里（批次按自己的供应商建到货单）。
   * 订货单空了、也没有按它登记过的到货（hasArrivals，调用方从单据流转算好），就一起删掉。
   */
  detach(purchaseId: number, actor: Actor, hasArrivals: boolean) {
    const batchId = this.batchIdOf(purchaseId);
    if (batchId === null) return;
    // 改之前的订货单（号、版本、到货安排），审计按它记前后，和删除采购单时那条（deletion.ts 的 auditBatchDetach）同一种写法
    const old = this.head(batchId);
    // 订货单成员表的外键指着它，读不到是库坏了
    if (!old) throw new Error('订货单 ' + batchId + ' 里挂着采购单 ' + purchaseId + '，订货单却读不出来');
    const purchaseNumber = one(this.store.db, rows.purchases.pick({ number: true }), 'SELECT number FROM purchases WHERE id=?', purchaseId)?.number ?? '',
      scheduleBefore = readBatchSchedule(old.schedule, batchId);
    this.store.db.prepare('DELETE FROM order_batch_purchases WHERE purchase_id=?').run(purchaseId);
    const empty = !this.memberIds(batchId).length && !hasArrivals;
    const scheduleAfter = empty ? [] : this.dropDetachedRows(batchId, scheduleBefore);
    if (empty) this.store.db.prepare('DELETE FROM order_batches WHERE id=?').run(batchId);
    const removed = scheduleBefore.length - scheduleAfter.length;
    audit(this.store, actor, {
      action: 'detach',
      entity: 'order_batches',
      id: batchId,
      document: {
        purchaseId,
        purchaseNumber,
        deleted: empty,
        before: scheduleBefore,
        after: scheduleAfter,
        version: { before: old.version, after: empty ? null : old.version + 1 },
        reason:
          '采购单' +
          (purchaseNumber ? ' ' + purchaseNumber : '') +
          ' 换了供应商，移出订货单 ' +
          old.number +
          (empty
            ? '；订货单里没有别的采购单了，一起删掉'
            : '：' + (removed > 0 ? '到货安排去掉只属于它的 ' + removed + ' 行，' : '') + '版本号加一'),
      },
    });
  }
  /**
   * 订货单还留着：到货安排里只属于移出去的采购单的行一起去掉（剩下的采购单明细里已经没有这一行），
   * 和删掉其中一张采购单时同一个做法（deletion.ts 的 after 规划）。版本号加一，打开着的到货安排窗口保存时提示刷新。
   * 返回改后的安排。
   */
  private dropDetachedRows(batchId: number, schedule: ScheduleEntry[]) {
    const keys = new Set(
      many(
        this.store.db,
        rows.purchase_lines.pick({ id: true, document: true }),
        'SELECT id,document FROM purchase_lines WHERE purchase_id IN (SELECT purchase_id FROM order_batch_purchases WHERE batch_id=?)',
        batchId,
      ).map((l) => batchRowKey(readPurchaseLineDocument(l.document, l.id))),
    );
    const kept = schedule.filter((e) => keys.has(e.rowKey));
    this.store.db
      .prepare('UPDATE order_batches SET schedule=?,version=version+1,updated_at=? WHERE id=?')
      .run(batchScheduleText(kept, '订货单 ' + batchId), new Date().toISOString(), batchId);
    return kept;
  }
  memberIds(batchId: number) {
    return many(this.store.db, memberRow, 'SELECT batch_id,purchase_id FROM order_batch_purchases WHERE batch_id=? ORDER BY purchase_id', batchId).map(
      (r) => r.purchase_id,
    );
  }
  /** 订货单上的行：只算已订货、没归档的采购单；已取消的采购单列出来但不算待到货。 */
  sourceLines(purchases: readonly SourcePurchase[]): BatchSourceLine[] {
    return purchaseLinesOf(purchases.filter((p) => p.baseStatus === '已订货' && !p.archived));
  }
  /** 几张采购单合成一份订货单：必须是同一家供应商（订货单按供应商建到货单）。 */
  requireOneSupplier(purchases: { supplierId: number }[]) {
    if (new Set(purchases.map((p) => p.supplierId)).size > 1)
      fail('只能把同一家供应商的采购单合在一份订货单里。');
  }
  /** 还没导出时的预览：给导出窗口看合并后的行。几张采购单必须是同一家供应商。 */
  draft(purchaseIds: number[], who: Actor | null | undefined): OrderBatchDraft {
    requirePermission(who, 'business:edit');
    let ids = [...new Set(purchaseIds)];
    if (!ids.length) fail('请先选采购单。');
    // 已经在订货单里的采购单：打开它所在的整份订货单
    const owners = new Set(ids.map((id) => this.batchIdOf(id))),
      [owner] = owners;
    if (owners.size === 1 && owner !== null) ids = this.memberIds(owner);
    else if ([...owners].some((o) => o !== null))
      fail('这些采购单里有的已经在别的订货单里了，已订货的只能按原来那份订货单重新导出。', 409);
    const purchases = this.repo.purchases(false, ids);
    if (purchases.length !== ids.length) fail('有采购单不存在或已归档，请刷新后重选。', 404);
    this.requireOneSupplier(purchases);
    if (purchases.some((p) => p.baseStatus === '已取消')) fail('已取消的采购单不能再订货。');
    const existing = this.batchIdOf(ids[0]);
    const batch = existing !== null ? this.view(existing) : null;
    // 还没订货的采购单也要能预览合并后的样子
    const lines = purchaseLinesOf(purchases);
    return {
      supplierId: purchases[0].supplierId,
      supplierName: purchases[0].supplierName,
      purchases: purchases.sort(byOrderDate).map((p) => ({
        id: p.id,
        number: p.number,
        version: p.version,
        status: p.businessStatus,
        customerOrderNumber: p.customerOrderNumber,
        expectedDate: p.expectedDate,
      })),
      rows: batchRows(
        lines,
        batch?.schedule ?? defaultSchedule(lines, (id) => purchases.find((p) => p.id === id)?.expectedDate),
        today(),
      ).map(({ lines: _, ...r }) => r),
      batch: batch && { id: batch.id, number: batch.number, version: batch.version },
    };
  }
  /** 批次详情：采购单、合并后的行（含到货安排和每段还差多少）；到货单由单据流转补 */
  view(id: number): OrderBatchBaseView {
    const row = this.head(id) ?? fail('订货单不存在或已删除。', 404);
    const purchases = this.repo.purchases(true, this.memberIds(id)),
      schedule = readBatchSchedule(row.schedule, id),
      rows = batchRows(this.sourceLines(purchases), schedule, today());
    return {
      id: row.id,
      number: row.number,
      supplierId: row.supplier_id,
      supplierName: purchases[0]?.supplierName || '',
      orderDate: row.order_date,
      notes: row.notes,
      version: row.version,
      schedule,
      purchases: purchases
        .sort(byOrderDate)
        .map((p) => ({ id: p.id, number: p.number, status: p.status, customerOrderNumber: p.customerOrderNumber })),
      rows: rows.map(batchRowView),
      progress: batchProgress(rows),
    };
  }
  /**
   * 还没到齐的订货单（到货页的“待到货”、今日页、助手 order_batch.list）。先在库里圈出还有没到齐明细
   * （已订货的采购单、已到货缓存小于订购数）的订货单，再逐份组装，不把到齐了的也组装一遍。
   * 可以只看一家供应商、只看某张采购单所在的那份。
   */
  open(filter: { supplierId?: number; purchaseId?: number } = {}) {
    return many(
      this.store.db,
      batchIdRow,
      'SELECT id FROM order_batches WHERE id IN (SELECT b.batch_id FROM order_batch_purchases b JOIN purchases p ON p.id=b.purchase_id' +
        " JOIN purchase_lines l ON l.purchase_id=p.id WHERE p.status='已订货' AND l.received_units<l.quantity_units)" +
        (filter.supplierId ? ' AND supplier_id=?' : '') +
        (filter.purchaseId ? ' AND id IN (SELECT batch_id FROM order_batch_purchases WHERE purchase_id=?)' : '') +
        ' ORDER BY order_date DESC,id DESC',
      ...[filter.supplierId, filter.purchaseId].filter((x): x is number => x !== undefined),
    )
      .map((r) => this.view(r.id))
      .filter((b) => b.progress.state !== '已到齐' && b.rows.length > 0);
  }
  /**
   * 几张合并的订货单号：DG-日期-两位序号，序号按天从流水号计数（number_sequences）里取。
   * 号要先印在订货单上、过后才落库，所以分成“看”和“占”：这里只看不占（预览、排版用），
   * 生成了导出记录才占（reserveNumber）；没交付的导出也占着号，重新导出拿新号。
   */
  nextNumber(date = today()) {
    const day = date.replaceAll('-', '');
    return 'DG-' + day + '-' + String(peekSequence(this.store, 'DG-' + day)).padStart(2, '0');
  }
  /**
   * 把预览时看到的订货单号真正占住。单据导出在保存导出记录的同一个保存点里调：
   * 排版期间这个号已经被别的订货单占走（另一份导出，或手工建的批次），就拒绝，让这份重新导出，纸上不会印出重号。
   */
  reserveNumber(number: string) {
    const m = /^DG-(\d{8})-(\d+)$/.exec(number);
    if (!m) return fail('订货单号格式不对：' + number, 500);
    // 先看再占（同步执行，中间不会被插队）：不是这个号就不占，不管调用方有没有事务都不留下多占的号
    if (peekSequence(this.store, 'DG-' + m[1]) !== Number(m[2]))
      fail('生成文件期间，订货单号 ' + number + ' 已被另一份订货单占用，请重新导出。', 409);
    takeSequence(this.store, 'DG-' + m[1]);
  }
  /** 直接占一个今天的订货单号（不经导出、手工把几张采购单一起建批次时用）；要在事务里调 */
  private takeNumber() {
    const day = today().replaceAll('-', '');
    return 'DG-' + day + '-' + String(takeSequence(this.store, 'DG-' + day)).padStart(2, '0');
  }
  /**
   * 建批次（导出交付完成、或手工把采购单改成已订货时）。这些采购单已经在同一个批次里就直接返回那个批次
   * （给了订货单号而批次的号不是它时报错）；部分采购单已属于别的批次时报错。
   */
  create(
    purchaseIds: number[],
    who: Actor | null | undefined,
    options: { number?: string; exportId?: string; schedule?: ScheduleEntry[] } = {},
  ) {
    const actor = requirePermission(who, 'business:edit');
    return inSavepoint(this.store.db, () => {
      const ids = [...new Set(purchaseIds)];
      const owners = new Set(ids.map((id) => this.batchIdOf(id))),
        [owner] = owners;
      if (owners.size === 1 && owner !== null && this.memberIds(owner).length === ids.length) {
        // 带着订货单号来建（导出交付完成），这几张却已按另一个号订了货：不能悄悄沿用别的号，
        // 不然纸上那个号在系统里查不到。单据导出交付前已经拦过，这里再守一道
        const existing = this.view(owner);
        if (options.number && options.number !== existing.number)
          fail('这几张采购单已按订货单 ' + existing.number + ' 订货，这份文件作废，请不要发给供应商。', 409);
        return existing;
      }
      if ([...owners].some((o) => o !== null))
        fail('有采购单已经在别的订货单里了。', 409);
      const purchases = this.repo.purchases(true, ids);
      if (purchases.length !== ids.length) fail('采购单不存在。', 404);
      this.requireOneSupplier(purchases);
      return this.view(this.insertBatch(ids, purchases, actor, options));
    });
  }
  /** 写一份新订货单和它的采购单清单，记审计，返回编号 */
  private insertBatch(ids: number[], purchases: PurchaseRowView[], actor: Actor, options: { number?: string; exportId?: string; schedule?: ScheduleEntry[] }) {
    // 给了号的（导出交付）不再占：号在生成导出记录时已经占过；几张一起手工建的这里直接占一个。
    // 一张采购单的订货单用采购单号；这个号已经被它原来的订货单占着（换了供应商，原订货单上有到货留着）就另占一个
    const own = ids.length === 1 && !exists(this.store.db, 'SELECT 1 FROM order_batches WHERE number=?', purchases[0].number);
    const number = options.number || (own ? purchases[0].number : this.takeNumber());
    // 没给到货安排就按采购单上的预计到货日期排
    const schedule =
      options.schedule ??
      defaultSchedule(this.sourceLines(purchases.map((p) => ({ ...p, baseStatus: '已订货' }))), (pid) =>
        purchases.find((p) => p.id === pid)?.expectedDate,
      );
    const at = new Date().toISOString();
    const id = Number(
      this.store.db
        .prepare(
          'INSERT INTO order_batches(number,supplier_id,order_date,schedule,notes,export_id,version,actor_id,actor_name,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)',
        )
        .run(number, purchases[0].supplierId, today(), batchScheduleText(schedule, '新订货单 ' + number), '', options.exportId ?? null, actor.id, actor.name, at, at)
        .lastInsertRowid,
    );
    const add = this.store.db.prepare('INSERT INTO order_batch_purchases(batch_id,purchase_id) VALUES(?,?)');
    for (const p of ids) add.run(id, p);
    audit(this.store, actor, {
      action: 'create',
      entity: 'order_batches',
      id,
      document: { number, purchaseIds: ids, exportId: options.exportId ?? null },
    });
    return id;
  }
  /** 已订货但还没有批次的采购单（功能上线前订的）：登记到货时补建一个只含它的批次。 */
  ensureFor(purchaseId: number, who: Actor | null | undefined) {
    const existing = this.batchIdOf(purchaseId);
    if (existing !== null) return this.view(existing);
    const purchase = this.repo.purchases(false, purchaseId)[0];
    if (!purchase) fail('采购单不存在或已归档。', 404);
    if (purchase.baseStatus !== '已订货') fail('采购单还是待订货，先导出订货单。');
    return this.create([purchaseId], who);
  }
  /** 改到货安排：每行拆成几段“数量 + 截止日期（可空）”。不动采购单和库存。 */
  saveSchedule(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      v = batchScheduleSchema.parse(raw);
    return inSavepoint(this.store.db, () => {
      const before = this.view(id);
      const entries = toScheduleEntries(v.schedule),
        text = batchScheduleText(entries, '订货单 ' + id);
      // 同样的安排再交一次（双击、网络重试、助手续办）原样返回，不报“已更新”
      if (before.version !== v.expectedVersion) {
        if (this.head(id)?.schedule === text) return before;
        fail('订货单已更新，请刷新后再改。', 409);
      }
      for (const e of entries) {
        const row = before.rows.find((r) => r.key === e.rowKey);
        if (!row) fail('到货安排里有一行不在这份订货单里，请刷新后重填。');
      }
      for (const row of before.rows) {
        const sum = entries.filter((e) => e.rowKey === row.key).reduce((n, e) => n + e.quantityUnits, 0);
        if (sum > row.orderedUnits)
          fail(row.name + ' 安排的数量合计 ' + quantityString(sum) + ' ' + row.unit + '，比订货的 ' + quantityString(row.orderedUnits) + ' ' + row.unit + ' 多。');
      }
      this.store.db
        .prepare('UPDATE order_batches SET schedule=?,version=version+1,updated_at=? WHERE id=?')
        .run(text, new Date().toISOString(), id);
      audit(this.store, actor, {
        action: 'schedule',
        entity: 'order_batches',
        id,
        document: { before: before.schedule, after: entries },
      });
      return this.view(id);
    });
  }
}
