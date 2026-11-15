import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import { many, one, previewDigest, rehearse, requirePermission, rows } from '../core/index.js';
import { rawStockKey, type FlowDocView, type FlowPreview } from '../../shared/business/index.js';
import { fail, newItemOf, type FlowCommands, type StockChange } from './base.js';
import { validateFlow } from './validate.js';

/*
 * 核对窗口：确认前先出一份预览（库存怎么变、提示）和预览摘要（server/core/preview-digest.ts）；
 * 确认时在写入的事务里按当前数据重算同一份核对内容（examine），摘要对不上就拒绝。
 */

/**
 * 到货行没选库存品：核对入库时入的是采购明细关联的那个，或按查重键（raw_key）对上的已有原材料，都没有才新建。
 * 把这个对象（编号、版本号、归档标记，或“将新建”）也放进摘要：预览之后有人新建了一样的、它有出入库、
 * 改了名或归档、恢复，确认时都报“已变化”。只看单据原样（validate 会给行补上采购明细关联的库存品），预览和确认取法一样。
 */
function lineStocks(flow: FlowCommands, doc: FlowDocView<'arrival'>) {
  const db = flow.store.db,
    snap: unknown[] = [];
  for (const l of doc.lines) {
    const linked = l.purchaseLineId
      ? one(db, rows.purchase_lines.pick({ stock_item_id: true }), 'SELECT stock_item_id FROM purchase_lines WHERE id=?', l.purchaseLineId)?.stock_item_id
      : null;
    if (linked != null) {
      snap.push(['line-stock', linked, versionOf(flow, 'stock_items', linked), flow.store.archived('stock_items', linked)]);
    } else if (!l.stockId) {
      const key = rawStockKey(l.item),
        found = one(db, rows.stock_items.pick({ id: true, version: true }), 'SELECT id,version FROM stock_items WHERE raw_key=?', key);
      snap.push(['line-raw', key, found ? found.id : null, found?.version ?? null, found ? flow.store.archived('stock_items', found.id) : null]);
    }
  }
  return snap;
}
/** 一条档案现在的版本号（档案没了是 undefined，摘要里记成 null） */
const versionOf = (flow: FlowCommands, table: string, id: number) =>
  one(flow.store.db, z.object({ version: z.number() }), 'SELECT version FROM ' + table + ' WHERE id=?', id)?.version;
/** 单据关联表的哪一列指向哪张表（按这个先后放进摘要） */
const refTables: readonly [keyof z.output<typeof rows.flow_refs>, string][] = [
  ['customer_id', 'customers'],
  ['supplier_id', 'suppliers'],
  ['product_id', 'products'],
  ['order_id', 'orders'],
  ['purchase_id', 'purchases'],
  ['stock_id', 'stock_items'],
  ['task_id', 'flow_documents'],
];
/** 单据和它关联的档案：各自的版本号、归档标记，到货行要入的库存品，来源原件的哈希（摘要的依据之一） */
function snapshot(flow: FlowCommands, doc: FlowDocView) {
  const refs = many(flow.store.db, rows.flow_refs, 'SELECT * FROM flow_refs WHERE document_id=?', doc.id),
    snap: unknown[] = [];
  for (const r of refs)
    for (const [k, t] of refTables) {
      const id = r[k];
      if (id) snap.push([t, id, versionOf(flow, t, id), flow.store.archived(t, id)]);
    }
  if (doc.kind === 'arrival') snap.push(...lineStocks(flow, doc));
  const source = doc.kind === 'arrival' && doc.sourceId
    ? one(flow.store.db, rows.flow_sources.pick({ hash: true, bytes: true }), 'SELECT hash,bytes FROM flow_sources WHERE id=?', doc.sourceId)
    : null;
  if (
    source &&
    createHash('sha256')
      .update(source.bytes)
      .digest('hex') !== source.hash
  )
    fail('来源原件校验失败。');
  return {
    id: doc.id,
    version: doc.version,
    document: doc,
    snap,
    sourceHash: source?.hash || null,
  };
}
/** 待核对的单据才能确认 */
export function requireDraft(doc: FlowDocView) {
  if (doc.status !== 'draft' || doc.archived) fail('只有待核对的单据可以确认。', 409);
}

/**
 * 核对的摘要：预览和确认各调一次，算法只有这一份。核对窗上的库存变化、提示都由单据和这些关联档案的当前状态算出
 * （库存每动一笔库存品就换版本号），所以对 snapshot 算。要在校验之前取：validate 会给到货行补上采购明细关联的库存品；
 * 确认时先比摘要再校验，预览以后库存被用掉的报“已变化”，不报库存不足。
 */
export function examine(flow: FlowCommands, doc: FlowDocView) {
  const snap = snapshot(flow, doc);
  return { snap, previewDigest: previewDigest(snap) };
}

/** 核对预览：只读（在预演里算、算完撤回），返回核对内容和 previewDigest，确认时带回来（回答的结构在 shared/business/flow-views.ts） */
export function preview(flow: FlowCommands, id: number, who: Actor | null | undefined): FlowPreview {
  const actor = requirePermission(who, 'business:edit');
  return rehearse(flow.store.db, () => {
    const doc = flow.get(id);
    requireDraft(doc);
    const { snap, previewDigest } = examine(flow, doc),
      plan = validateFlow(flow, doc, actor, true, { excludingId: id });
    describeChanges(flow, plan.changes);
    // plan.document 是补全明细后的单据视图（到货、送货的明细换成核对补全的）
    return { previewDigest, ...plan, sourceHash: snap.sourceHash };
  });
}
/**
 * 核对窗口“库存怎么变”的每一行：入到哪个库存品、现在多少、核对后多少（currentUnits、afterUnits）。
 * 只读，不建、不恢复库存品。到货行没选库存品的，和实际入库同一个判断（OperationsService.rawStockMatch）：
 * 有一样的原材料（归档的也算）就是入到已有的那个（target，已归档的核对入库时自动恢复），没有才是新建；
 * 同一张单里几行没选、规格一样的，后面的行和第一行入同一个新建的（sameNewAs 是第几行）。
 * 几行入同一个库存品时，按先后累计：后一行的“现在”就是前一行的“核对后”。完工的成品库存在保存时已经按产品对应好（新建、恢复都在那时），这里照常读。
 */
function describeChanges(flow: FlowCommands, changes: StockChange[]) {
  const ids = changes.flatMap((c) => (c.stockId ? [c.stockId] : []));
  const balances = new Map<number, number>(flow.ops.repo.items(true, ids).map((i) => [i.id, i.balanceUnits]));
  const running = new Map<string, number>(),
    firstNew = new Map<string, number>();
  changes.forEach((c, index) => {
    const { key, current } = c.stockId
      ? { key: 's' + c.stockId, current: balances.get(c.stockId) ?? 0 }
      : newLineTarget(flow, c, index, firstNew);
    // 同一库存品的后几行：“现在”接着上一行核对后的数写，每一行都是 现在 + 变化 = 核对后
    c.currentUnits = running.get(key) ?? current;
    c.afterUnits = c.currentUnits + c.deltaUnits;
    running.set(key, c.afterUnits);
  });
}
/**
 * 到货行没选库存品：有一样的原材料就是入到它（记进 target），没有就是新建；同一张单里规格一样的后几行和第一行入同一个新建的
 * （sameNewAs 记第几行）。返回累计用的键和“现在”的数
 */
function newLineTarget(flow: FlowCommands, c: StockChange, index: number, firstNew: Map<string, number>) {
  const match = flow.ops.rawStockMatch(newItemOf(c));
  if (match) {
    c.target = { id: match.id, name: match.name, archived: match.archived };
    return { key: 's' + match.id, current: match.balanceUnits };
  }
  const newKey = rawStockKey(newItemOf(c)),
    first = firstNew.get(newKey);
  if (first === undefined) firstNew.set(newKey, index);
  else c.sameNewAs = first + 1;
  return { key: 'n' + newKey, current: 0 };
}