import type { Actor } from '../core/index.js';
import { audit, many, requireLocalAdministrator, rows } from '../core/index.js';
import { sheetArea, purchaseLineAmount, type StockItemView } from '../../shared/business/index.js';
import {
  readPurchaseLineDocument,
  recordMovementRevision,
  resetPurchaseLineReceived,
  touchPurchases,
  unlinkPurchaseLineMovements,
  updatePurchaseLineDocument,
} from '../operations/index.js';
import type { ArrivalLine, FlowCommands } from './base.js';
import { writeFlowDocument } from './document-store.js';
import { storedDocuments } from './read.js';
import { readReturnDocument, returnDocumentText } from './return-document.js';

// 本机管理员直接改库存品、删采购明细时，已有单据要跟着改。采购库存经 operations/hooks.ts 调这两个函数，
// 由 FlowService 所在的模块登记进去（见 service.ts 末尾），采购库存不反过来引用单据流转。
// 改单据和同模块别处一样：取库里那份内容（read.ts 的 storedDocuments）改好整份写回（document-store.ts）。

/** 库存品里存进采购明细、到货明细的那份内容（名称、单位、规格、尺寸、材质、楞型、备注） */
function stockContent(s: StockItemView) {
  return {
    name: s.name,
    unit: s.unit,
    specification: s.specification,
    length: s.length,
    width: s.width,
    height: s.height,
    dimensionUnit: s.dimensionUnit,
    material: s.material,
    flute: s.flute,
    notes: s.notes,
  };
}

/** 关联表（flow_refs）这一列挂着这些编号的到货单：库里那份内容，不把全部单据读出来再筛 */
function linkedArrivals(flow: FlowCommands, column: 'stock_id' | 'purchase_line_id', ids: readonly number[]) {
  const documentIds = many(
    flow.store.db,
    rows.flow_refs.pick({ document_id: true }),
    'SELECT DISTINCT document_id FROM flow_refs WHERE ' + column + ' IN (SELECT value FROM json_each(?))',
    JSON.stringify(ids),
  ).map((r) => r.document_id);
  return storedDocuments(flow.store, documentIds).flatMap(({ id, document }) => (document.kind === 'arrival' ? [{ id, document }] : []));
}

/** 到货明细换上库存品的新内容，面积、金额跟着重算 */
function alignedLine(l: ArrivalLine, content: ReturnType<typeof stockContent>): ArrivalLine {
  const item = { ...l.item, ...content };
  return {
    ...l,
    item,
    area: sheetArea(item, l.quantity),
    amount: purchaseLineAmount({ ...item, quantity: l.quantity, unitPrice: l.unitPrice, priceBasis: l.priceBasis }),
  };
}

/**
 * 管理员改了库存品的名称、规格这类内容：采购明细和到货单明细里存的这份内容跟着对齐。
 * 种类、成品关联的产品到这里不会变：有出入库记录，或者被单据、采购明细引用的库存品，这两样谁都不许改
 * （OperationsService.saveItem 拦，本机管理员也一样），单位又跟着种类走（原材料“张”、成品“只”，数据库约束）。
 * 所以这里只对齐内容，不改数量、不动流水，也不碰完工单、送货单和生产任务的关联。
 */
export function alignStock(flow: FlowCommands, before: StockItemView, after: StockItemView, actor: Actor) {
  requireLocalAdministrator(actor);
  const content = stockContent(after);
  for (const line of many(
    flow.store.db,
    rows.purchase_lines.pick({ id: true, purchase_id: true, document: true }),
    'SELECT id,purchase_id,document FROM purchase_lines WHERE stock_item_id=?',
    after.id,
  )) {
    updatePurchaseLineDocument(flow.store, line.id, { ...readPurchaseLineDocument(line.document, line.id), ...content });
    touchPurchases(flow.store, [line.purchase_id]);
  }
  // 明细里存着库存品内容的只有到货单；完工单、送货单只记库存品编号，没有要对齐的
  for (const { id, document } of linkedArrivals(flow, 'stock_id', [after.id])) {
    if (!document.lines.some((l) => l.stockId === after.id)) continue;
    const lines = document.lines.map((l) => (l.stockId === after.id ? alignedLine(l, content) : l));
    writeFlowDocument(flow.store, id, { ...document, lines });
    flow.maintenanceReferences(id);
  }
  audit(flow.store, actor, {
    action: 'edit-related-stock',
    entity: 'stock_items',
    id: after.id,
    document: { before, after },
  });
}

/** 退货单里记的采购明细同样解除：明细编号以后可能被新明细重用，不能留着旧编号。 */
function detachReturns(flow: FlowCommands, detached: (lineId: number | null) => boolean, lineIds: readonly number[]) {
  const db = flow.store.db;
  for (const r of many(
    db,
    rows.purchase_returns.pick({ id: true, number: true, document: true }),
    "SELECT id,number,document FROM purchase_returns WHERE EXISTS(SELECT 1 FROM json_each(purchase_returns.document,'$.lines') l WHERE json_extract(l.value,'$.purchaseLineId') IN (SELECT value FROM json_each(?)))",
    JSON.stringify(lineIds),
  )) {
    const d = readReturnDocument(r),
      lines = d.lines.map((l) => (detached(l.purchaseLineId) ? { ...l, purchaseLineId: null } : l));
    db.prepare('UPDATE purchase_returns SET document=?,version=version+1,updated_at=? WHERE id=?').run(
      returnDocumentText({ ...d, lines }, '退货单 ' + r.id + '，单号 ' + r.number),
      new Date().toISOString(),
      r.id,
    );
  }
}

/** 管理员删掉或改了采购明细：挂在这些明细上的到货单解除关联，已到货重算。 */
export function detachPurchaseLines(flow: FlowCommands, _purchaseId: number, lineIds: number[], actor: Actor) {
  if (!lineIds.length) return;
  requireLocalAdministrator(actor);
  const ids = new Set(lineIds),
    db = flow.store.db,
    detached = (lineId: number | null) => lineId !== null && ids.has(lineId);
  for (const { id, document } of linkedArrivals(flow, 'purchase_line_id', lineIds)) {
    if (!document.lines.some((l) => detached(l.purchaseLineId))) continue;
    const lines = document.lines.map((l) =>
      detached(l.purchaseLineId) ? { ...l, purchaseLineId: null, purchaseId: null, purchaseNumber: '' } : l,
    );
    writeFlowDocument(flow.store, id, { ...document, lines });
    flow.maintenanceReferences(id);
  }
  detachReturns(flow, detached, lineIds);
  for (const id of lineIds) {
    for (const m of many(db, rows.stock_movements, 'SELECT * FROM stock_movements WHERE purchase_line_id=?', id))
      recordMovementRevision(flow.store, actor, '解除采购关联', m, { purchase_line_id: null });
    unlinkPurchaseLineMovements(flow.store, id);
    db.prepare(
      'UPDATE flow_refs SET purchase_line_id=NULL,purchase_id=NULL WHERE purchase_line_id=?',
    ).run(id);
    resetPurchaseLineReceived(flow.store, id);
  }
}
