// “假装业务变了”：财务测试要的业务单据、库存流水、采购退货、库存品的改动都从这里造（虚构数据、内存库）。
// 写入走表主人自己的写法：单据经 server/flow/documents/document-store.ts，流水修订经采购库存入口的 stockLedger，
// 删除走删除规则登记的语句（server/core/deletion-rules.ts）。没有现成写法、只能写 SQL 的几处都在这个文件里，各自写明为什么。
// 业务改了表，只改这一个文件。
// 删除规则（单据、采购退货；库存流水、库存品）在单据流转、采购库存各自的 deletion.ts 里登记：
// 测试引这两个模块都走入口（tests/module-test-entries.test.ts），入口加载时就登记了
import '../server/flow/index.js';
import { stockLedger } from '../server/operations/index.js';
import type { SQLOutputValue } from 'node:sqlite';
import type { Actor, DeletionContext, Store } from '../server/core/index.js';
import { deletionRemove, deletionUpdate, nextAutoId, one, rows } from '../server/core/index.js';
import { flowColumns, writeFlowDocument } from '../server/flow/documents/document-store.js';
import { documentOf, storedDocument } from '../server/flow/documents/read.js';
import { flowDocumentContent, flowDocumentSchema, type FlowKind } from '../shared/business/index.js';
import { actor as defaultActor } from './actor-fixture.js';

/** 造单据时内容里决定镜像列的几项（计划日、送达、订货单、更正关系；单据表的镜像列由 flowColumns 从这些算） */
export type MirroredFields = Omit<Parameters<typeof flowColumns>[0], 'kind'>;

/** 删除规则要的上下文：谁、什么时候（这里只删单行，没有连带的“改过的行”） */
const deletionContext = (who: Actor): DeletionContext => ({ actor: who, at: new Date().toISOString(), mark: {}, updated: () => [] });

/** 库里一行（带 rowid，删除规则按 rowid 写），查不到让测试失败 */
function tableRow(store: Store, table: 'stock_movements' | 'stock_items' | 'purchase_returns', id: SQLOutputValue) {
  const row = store.db.prepare('SELECT rowid AS __rowid,* FROM ' + table + ' WHERE id=?').get(id);
  if (!row) throw new Error('测试数据：' + table + ' 里没有 ' + String(id));
  return { ...row, __rowid: Number(row.__rowid) };
}

/** 单据：直接造一张已确认的、改内容、撤销、删除 */
function documentChanges(store: Store, who: Actor) {
  /** 照库里的单据结构核对内容，带上种类（种类在行上，不进 JSON） */
  const checked = (kind: FlowKind, content: Record<string, unknown>) => flowDocumentSchema(kind).parse(content);
  return {
    /**
     * 直接造一张已确认的单据：单据日期写进内容，按库里的单据结构核对后存核对过的内容，镜像列由 flowColumns 从内容算。
     * 编号不给按自增，单号不给是 FICT-编号；at 是建立、更新时间（不给是单据日期）。
     * 只能写 SQL：document-store 的 insertFlowDocument 自己定编号和单号，测试要指定的编号、断言里写着 FICT-1 这样的单号。
     * 不写 flow_refs：财务测试的单据挂着不存在的订单、库存品（订单 1、库存品 2），关联表有外键，写了就报错。
     */
    confirmed(kind: FlowKind, date: string, content: Record<string, unknown>, options: { id?: number; number?: string; at?: string } = {}) {
      const doc = checked(kind, { ...content, date }),
        id = options.id ?? nextAutoId(store.db, 'flow_documents'),
        at = options.at ?? date,
        c = flowColumns(doc);
      store.db
        .prepare(
          `INSERT INTO flow_documents(id,kind,number,date,status,planned_date,delivered_at,order_batch_id,correction_of,replaced_by,document,actor_id,actor_name,created_at,updated_at)
          VALUES(?,?,?,?,'confirmed',?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, kind, options.number ?? 'FICT-' + id, date, c.planned_date, c.delivered_at, c.order_batch_id, c.correction_of, c.replaced_by,
          JSON.stringify(flowDocumentContent(doc)), who.id, who.name, at, at);
      return id;
    },
    /** 改单据内容里的一项（path 是 JSON 路径，值按 JSON 写），经 document-store 整份写回，版本号加一 */
    edit(id: number, path: string, value: unknown) {
      const row = one(
        store.db,
        rows.flow_documents.pick({ id: true, number: true, kind: true, document: true }),
        'SELECT id,number,kind,json_set(document,?,json(?)) AS document FROM flow_documents WHERE id=?',
        path,
        JSON.stringify(value),
        id,
      );
      if (!row) throw new Error('测试数据：没有单据 ' + id);
      writeFlowDocument(store, id, documentOf(row));
    },
    /** 整份换掉单据内容（按库里的单据结构核对），经 document-store 写回，版本号加一 */
    rewrite(id: number, content: Record<string, unknown>) {
      writeFlowDocument(store, id, checked(storedDocument(store, id).kind, content));
    },
    /** 单据撤销了：只改状态和版本（经 document-store），不写冲回流水；要真实冲回流水的走 FlowService 的撤销、更正 */
    reverse(id: number) {
      writeFlowDocument(store, id, storedDocument(store, id), { status: 'reversed' });
    },
    /** 单据被物理删除：走删除规则登记的语句（只删这一张，不连带别的） */
    remove(id: number) {
      deletionRemove(store, deletionContext(who), 'flow_documents', { __rowid: id });
    },
  };
}

/** 库存流水、库存品、采购退货 */
function stockChanges(store: Store, who: Actor) {
  return {
    /** 库存流水被物理删除：走删除规则（留修订记录、库存品版本号加一） */
    removeMovements(ids: string[]) {
      for (const id of ids) deletionRemove(store, deletionContext(who), 'stock_movements', tableRow(store, 'stock_movements', id));
    },
    /**
     * 这张单据的冲销（或这张退货的撤销）发生在 date：把它的这类流水的日期挪过去（撤销、冲销都按今天记流水）。
     * 只能写 SQL：模拟的是“那天发生的”，不是改写流水，不留修订记录；采购库存没有改流水日期的写法。
     * 只挪入库（数量为正）的给 inbound: true（撤销退货只加回库存）。
     */
    moveMovements(source: { kind: 'flow_reversal' | 'purchase_return'; id: number }, date: string, inbound = false) {
      store.db
        .prepare('UPDATE stock_movements SET date=? WHERE source_kind=? AND source_id=?' + (inbound ? ' AND delta_units>0' : ''))
        .run(date, source.kind, String(source.id));
    },
    /**
     * 管理员改一条流水（数量 delta_units、说明 notes）：先经 ledger 的 recordMovementRevision 留修订记录。
     * 改值只能写 SQL：程序里没有直接改流水数量、说明的写法，这里造的是“管理员改过”的结果。
     */
    reviseMovement(id: string, patch: { delta_units?: number; notes?: string }) {
      const before = tableRow(store, 'stock_movements', id);
      stockLedger.recordMovementRevision(store, who, '虚构修订', before, { ...before, ...patch });
      if (patch.delta_units != null) store.db.prepare('UPDATE stock_movements SET delta_units=? WHERE id=?').run(patch.delta_units, id);
      if (patch.notes != null) store.db.prepare('UPDATE stock_movements SET notes=? WHERE id=?').run(patch.notes, id);
    },
    /**
     * 登记时间早于今天的流水（导入或脚本补的）：只能写 SQL，ledger 的 insertMovement 按现在记登记时间、编号随机。
     * 给的列原样写进去。
     */
    backdatedMovement(m: Record<'id' | 'action' | 'source_kind' | 'date' | 'notes' | 'created_at', string> & Record<'item_id' | 'delta_units' | 'before_units' | 'after_units', number>) {
      store.db
        .prepare(
          `INSERT INTO stock_movements(id,item_id,action,delta_units,before_units,after_units,source_kind,source_id,date,notes,actor_id,actor_name,created_at)
          VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?)`,
        )
        .run(m.id, m.item_id, m.action, m.delta_units, m.before_units, m.after_units, m.source_kind, m.date, m.notes, who.id, who.name, m.created_at);
    },
    /** 改库存品的类别、单位等列：走删除规则登记的写法（版本号加一），数据库约束照样拦 */
    stockItem(id: number, values: Partial<Record<'kind' | 'unit' | 'raw_key', string | null> & { product_id: number | null }>) {
      deletionUpdate(store, deletionContext(who), 'stock_items', tableRow(store, 'stock_items', id), values);
    },
    /** 退货的撤销记在 at（撤销按现在记）：只能写 SQL，单据流转没有改退货更新时间的写法 */
    returnReversedAt(id: number, at: string) {
      store.db.prepare('UPDATE purchase_returns SET updated_at=? WHERE id=?').run(at, id);
    },
    /**
     * 直接造一张已确认的采购退货（编号自增）：只能写 SQL，PurchaseReturns 要真实的到货和库存，
     * 财务测试的到货单是直接造的、挂的库存品不存在。
     */
    purchaseReturn(r: { number: string; arrivalId: number; date: string; document: unknown; at: string }) {
      store.db
        .prepare(
          `INSERT INTO purchase_returns(number,arrival_id,date,status,document,actor_id,actor_name,created_at,updated_at)
          VALUES(?,?,?,'confirmed',?,?,?,?,?)`,
        )
        .run(r.number, r.arrivalId, r.date, JSON.stringify(r.document), who.id, who.name, r.at, r.at);
    },
  };
}

/**
 * 有人直接改了库：把单据或采购退货内容里的一项改成任意值（可以不合结构），版本号不动。
 * 只能写 SQL：程序的任何写法都会先核对结构，存不出读不出来的内容；测“读不出来的单据”和“在库里原处改好”要它。
 */
function tamper(store: Store, table: 'flow_documents' | 'purchase_returns', id: number, path: string, value: unknown) {
  store.db.prepare('UPDATE ' + table + ' SET document=json_set(document,?,json(?)) WHERE id=?').run(path, JSON.stringify(value), id);
}

/** 财务测试“假装业务变了”的全部写法；who 是经手人（不给是虚构管理员） */
export function businessChanges(store: Store, who: Actor = defaultActor) {
  return {
    ...documentChanges(store, who),
    ...stockChanges(store, who),
    tamper: (table: 'flow_documents' | 'purchase_returns', id: number, path: string, value: unknown) =>
      tamper(store, table, id, path, value),
  };
}
