import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { AppError, many, parseStoredJson, rows } from '../../core/index.js';
import { purchaseLineDocumentSchema } from '../../../shared/business/index.js';
import { MAX_STOCK_UNITS } from '../../../shared/core/index.js';

/**
 * 库存流水、库存品和采购单的版本号、采购明细（内容、关联的库存品和客户订单、已到货），只由采购库存写，都在这个文件里。
 * 到货、送货、生产、退货、更正和管理员改数据（单据流转）要改这些，调这里的函数，不直接写这几张表。
 * 采购明细的增删改全部在这里（删除、初始化的语句登记在 deletion.ts），tests/module-table-owners.test.ts 会拦别的文件直接写。
 * 余额只由流水派生、不能为负（AGENTS.md）：写流水前调用方先按自己的说法检查并报错，这里再兜底检查一次；
 * 改写、删除已有流水前先用本文件末尾的 recordMovementRevision 留下原值（余额仍由当前流水派生，修订台账负责追溯）。
 */

/** 库存流水的动作（stock_movements.action）能存的全部值，和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const stockMovementActions = ['in', 'out', 'adjust', 'purchase'] as const;
const COLUMNS =
  'id,item_id,action,delta_units,before_units,after_units,source_kind,source_id,purchase_line_id,customer_order_id,date,notes,actor_id,actor_name,created_at';

type MovementInput = {
  stockId: number;
  /** in、out、purchase、adjust 等 */
  action: string;
  /** 以千分之一为单位的整数 */
  delta: number;
  before: number;
  after: number;
  sourceKind: string;
  sourceId: string | null;
  purchaseLineId?: number | null;
  orderId?: number | null;
  date: string;
  notes: string;
  actor: Actor;
};

/** 写一笔库存流水，返回流水号。库存品版本号由调用方用 touchStockItems 换。 */
export function insertMovement(store: Store, m: MovementInput): string {
  // 数量是 0 的流水只有盘点（adjust）能记，表示盘过了、数量没变（数据库也有这条约束）。别的出入库算出 0 就不该记：
  // 各处在调用前已经跳过（入库 0 的到货行、领退相抵的冲销等），这里再拦一道，给出说得清的原因
  if (!m.delta && m.action !== 'adjust')
    throw new AppError('这笔出入库的数量是 0，不记流水；只有盘点可以记“数量没变”。请核对单据上的数量。', 409);
  if (m.after < 0 || !Number.isSafeInteger(m.after) || m.after > MAX_STOCK_UNITS)
    throw new AppError('库存不足或数量超限，不能记这笔流水。', 409);
  const id = randomUUID();
  const values = [
    id,
    m.stockId,
    m.action,
    m.delta,
    m.before,
    m.after,
    m.sourceKind,
    m.sourceId,
    m.purchaseLineId ?? null,
    m.orderId ?? null,
    m.date,
    m.notes,
    m.actor.id,
    m.actor.name,
    new Date().toISOString(),
  ];
  store.db.prepare('INSERT INTO stock_movements(' + COLUMNS + ') VALUES(' + values.map(() => '?').join(',') + ')').run(...values);
  return id;
}

const balanceRow = rows.stock_movements.pick({ id: true, delta_units: true, before_units: true, after_units: true });
/**
 * 按入账顺序重算每个库存品流水的前后结余，只改对不上的。结余会变负时调 negative（由它报错，说清楚怎么办）。
 * 管理员直接改了单据、删了记录以后用。
 */
export function rebalanceMovements(store: Store, negative: (itemName: string) => never) {
  const db = store.db;
  for (const item of many(db, rows.stock_items.pick({ id: true, name: true }), 'SELECT id,name FROM stock_items')) {
    let balance = 0;
    for (const m of many(db, balanceRow, 'SELECT id,delta_units,before_units,after_units FROM stock_movements WHERE item_id=? ORDER BY created_at,rowid', item.id)) {
      const before = balance;
      balance += m.delta_units;
      if (!Number.isSafeInteger(balance) || balance < 0 || balance > MAX_STOCK_UNITS) negative(item.name);
      if (m.before_units !== before || m.after_units !== balance)
        db.prepare('UPDATE stock_movements SET before_units=?,after_units=? WHERE id=?').run(before, balance, m.id);
    }
  }
}

/** 采购明细删掉后，流水上对它的关联去掉 */
export function unlinkPurchaseLineMovements(store: Store, purchaseLineId: number) {
  store.db.prepare('UPDATE stock_movements SET purchase_line_id=NULL WHERE purchase_line_id=?').run(purchaseLineId);
}

/** 库存品版本号加一：库存变了，别处打开的库存编辑窗会提示已变化 */
export function touchStockItems(store: Store, ids: Iterable<number>) {
  const stmt = store.db.prepare('UPDATE stock_items SET version=version+1 WHERE id=?');
  for (const id of ids) stmt.run(id);
}

/** 采购单版本号加一（到货、更正、管理员改数据以后）；给 at 时同时改更新时间 */
export function touchPurchases(store: Store, ids: Iterable<number>, at?: string) {
  const stmt =
    at === undefined
      ? store.db.prepare('UPDATE purchases SET version=version+1 WHERE id=?')
      : store.db.prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?');
  for (const id of ids) at === undefined ? stmt.run(id) : stmt.run(at, id);
}

/** 采购明细关联的库存品（到货登记时补上、库存品不再是原材料时去掉） */
export function setPurchaseLineStock(store: Store, purchaseLineId: number, stockId: number | null) {
  store.db.prepare('UPDATE purchase_lines SET stock_item_id=? WHERE id=?').run(stockId, purchaseLineId);
}

/*
 * 采购明细存进 document 的内容按共用的 purchaseLineDocumentSchema（shared/business，单据流转的只读窗口给财务解析采购明细也用它）。
 * 关联的库存品、数量、已到货和这一行关联的客户订单存在列里（客户订单是真外键，订单删了由数据库和删除规则管），
 * 不在 JSON 里重复存；读的时候由 purchase-rows.ts 拼回，对外的对象形状不变。写和读都按这一份。
 */
/** 读一行采购明细的 document 列：对不上按库里的数据报（StoredDataError，回 500、记日志） */
export const readPurchaseLineDocument = (text: string, lineId: number) =>
  parseStoredJson(purchaseLineDocumentSchema, text, 'purchase_lines.document（采购明细 ' + lineId + '）');
/** 写的时候收的内容：带了 customerOrderId 也行，它只存在列里，这里去掉 */
const writablePurchaseLine = purchaseLineDocumentSchema.extend({ customerOrderId: z.unknown().optional() });

/**
 * 要写进 document 列的文字：写之前按结构核对。对不上是服务端自己拼错了内容，
 * 按服务端错误报（出错处理回 500、写进日志），不当成“输入不对”。which 说明是哪一行。
 */
function purchaseLineDocument(document: unknown, which: string) {
  const checked = writablePurchaseLine.safeParse(document);
  if (!checked.success)
    throw new Error('采购明细内容不合库里的结构，没有写入（' + which + '）：' + z.prettifyError(checked.error), {
      cause: checked.error,
    });
  const { customerOrderId: _order, ...rest } = checked.data;
  return JSON.stringify(rest);
}

type PurchaseLineInput = {
  stockItemId: number | null;
  /** 这一行给哪张订单订的料；null 跟采购单头走 */
  customerOrderId: number | null;
  /** 以千分之一为单位的整数 */
  quantityUnits: number;
  /** 名称、规格、单位、单价、计价方式、备注等；里面带了 customerOrderId 也不会存进 JSON */
  document: unknown;
};

/** 新增一行采购明细，返回明细编号 */
export function insertPurchaseLine(store: Store, purchaseId: number, line: PurchaseLineInput): number {
  const document = purchaseLineDocument(line.document, '采购单 ' + purchaseId + ' 新加的明细');
  return Number(
    store.db
      .prepare('INSERT INTO purchase_lines(purchase_id,stock_item_id,customer_order_id,quantity_units,document) VALUES(?,?,?,?,?)')
      .run(purchaseId, line.stockItemId, line.customerOrderId, line.quantityUnits, document)
      .lastInsertRowid,
  );
}

/** 改一行采购明细的内容、数量和关联订单；给了 stockItemId 才改关联的库存品（已有到货时库存品不动） */
export function updatePurchaseLine(
  store: Store,
  purchaseId: number,
  purchaseLineId: number,
  line: Omit<PurchaseLineInput, 'stockItemId'> & { stockItemId?: number | null },
) {
  const document = purchaseLineDocument(line.document, '采购明细 ' + purchaseLineId);
  if (line.stockItemId === undefined)
    store.db
      .prepare('UPDATE purchase_lines SET customer_order_id=?,quantity_units=?,document=? WHERE id=? AND purchase_id=?')
      .run(line.customerOrderId, line.quantityUnits, document, purchaseLineId, purchaseId);
  else
    store.db
      .prepare('UPDATE purchase_lines SET stock_item_id=?,customer_order_id=?,quantity_units=?,document=? WHERE id=? AND purchase_id=?')
      .run(line.stockItemId, line.customerOrderId, line.quantityUnits, document, purchaseLineId, purchaseId);
}

/** 只改一行采购明细关联的客户订单（已有到货后明细内容不能动，订单关联仍可改） */
export function setPurchaseLineOrder(store: Store, purchaseId: number, purchaseLineId: number, orderId: number | null) {
  store.db
    .prepare('UPDATE purchase_lines SET customer_order_id=? WHERE id=? AND purchase_id=?')
    .run(orderId, purchaseLineId, purchaseId);
}

/** 删采购明细：给明细编号删这一行，不给就删这张采购单的全部明细（没有到货时整批重写用） */
export function deletePurchaseLines(store: Store, purchaseId: number, purchaseLineId?: number) {
  if (purchaseLineId === undefined) store.db.prepare('DELETE FROM purchase_lines WHERE purchase_id=?').run(purchaseId);
  else store.db.prepare('DELETE FROM purchase_lines WHERE id=? AND purchase_id=?').run(purchaseLineId, purchaseId);
}

/** 采购明细的内容（库存品改了名称、规格等，跟着对齐）；关联的客户订单在列里，这里不动 */
export function updatePurchaseLineDocument(store: Store, purchaseLineId: number, document: unknown) {
  store.db
    .prepare('UPDATE purchase_lines SET document=? WHERE id=?')
    .run(purchaseLineDocument(document, '采购明细 ' + purchaseLineId), purchaseLineId);
}

/** 采购明细的已到货清零（明细和到货解除关联以后） */
export function resetPurchaseLineReceived(store: Store, purchaseLineId: number) {
  store.db.prepare('UPDATE purchase_lines SET received_units=0 WHERE id=?').run(purchaseLineId);
}

/** 采购明细的已到货缓存（按有效到货重算以后写回） */
export function setPurchaseLineReceived(store: Store, purchaseLineId: number, receivedUnits: number) {
  store.db.prepare('UPDATE purchase_lines SET received_units=? WHERE id=?').run(receivedUnits, purchaseLineId);
}

/** 订货单版本号加一（按订货单登记到货以后） */
export function touchOrderBatch(store: Store, id: number, at: string) {
  store.db.prepare('UPDATE order_batches SET version=version+1,updated_at=? WHERE id=?').run(at, id);
}

/**
 * 流水改挂到另一张单据、另一张订单名下（拆分送货单时，拆出去的出库跟着新单据走；调用方先留修订记录）。
 * sourceId 给 null：不再挂在任何单据上（改订单删了明细，那一行的出库改成独立的“系统维护”流水）。
 * notes 给了就一起换备注（备注开头是原单据的单号，改挂到新单后换成新单的）；不给就不动
 */
export function relinkMovement(
  store: Store,
  id: string,
  to: { sourceKind: string; sourceId: string | null; orderId: number | null; notes?: string },
) {
  store.db
    .prepare('UPDATE stock_movements SET source_kind=?,source_id=?,customer_order_id=?,notes=coalesce(?,notes) WHERE id=?')
    .run(to.sourceKind, to.sourceId, to.orderId, to.notes ?? null, id);
}

/**
 * 改写、删除一笔流水前留下原值（before）和要改成的值（after，删除时是 null）。存的是流水那一行的列和值（库里读出来的只有文字、数字、空），
 * 读回来按共用的 movementColumnsSchema（shared/business/operations-stored.ts，movements.ts 的 movementRevisions）。
 */
export function recordMovementRevision(
  store: Store,
  actor: { id: string; name: string },
  reason: string,
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
) {
  const { __rowid, _rowid, ...original } = before;
  store.db
    .prepare(
      'INSERT INTO stock_movement_revisions(movement_id,item_id,at,actor_id,actor_name,reason,before_document,after_document) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      String(before.id),
      Number(before.item_id),
      new Date().toISOString(),
      actor.id,
      actor.name,
      reason,
      JSON.stringify(original),
      after ? JSON.stringify(after) : null,
    );
}

/**
 * 别的模块（单据流转写到货、送货、生产、退货、更正和管理员连带，业务总览改订单连带）要改流水、库存品和采购单版本号、
 * 采购明细时用的写函数，收成一个对象从入口给出去；采购库存自己的文件直接引上面的函数。
 */
export const stockLedger = {
  insertMovement,
  rebalanceMovements,
  recordMovementRevision,
  relinkMovement,
  unlinkPurchaseLineMovements,
  touchStockItems,
  touchPurchases,
  touchOrderBatch,
  setPurchaseLineStock,
  setPurchaseLineReceived,
  resetPurchaseLineReceived,
  readPurchaseLineDocument,
  updatePurchaseLineDocument,
};