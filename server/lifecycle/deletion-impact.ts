import type { z } from 'zod';
import type { DeletionGraph, DeletionRow as Row } from '../core/index.js';
import { deletionLabel } from '../core/index.js';
import { flowEntity, flowEntityPrefix, flowKinds, flowNames, movementSource, type impactRowSchema } from '../../shared/business/index.js';
import { quantityString } from '../../shared/core/index.js';
import type { InventoryEffectInput } from './deletion-summary.js';

/*
 * 删除预览里给人看的部分（只读，不进范围摘要、不参与删除）：影响清单每一行叫什么、怎么并排显示，
 * 和“库存怎么变”那段话要的数（文字在 deletion-summary.ts 拼）。删除范围由 deletion-plan.ts 的 planDeletion 定。
 */

type ImpactRow = z.infer<typeof impactRowSchema>;

type Deletion = { table: string; row: Row };
/** 只解除关联的一行：value 是要改的列和新值 */
type Update = { table: string; row: Row; value: Record<string, unknown> };

/** 删除涉及的行（列都是任意值）里的一列是文字就交出来，不是交 undefined */
export const textOf = (value: unknown) => (typeof value === 'string' ? value : undefined);
/** 清单里一行的编号：有 id 列用它，没有的（关联表）用 rowid */
function rowId(r: Row): number | string {
  const id: unknown = r.id;
  return typeof id === 'number' || typeof id === 'string' ? id : r.__rowid;
}
/** 单据种类的叫法（“到货记录”……），不是单据种类的叫“单据” */
function flowName(kind: unknown) {
  const known = flowKinds.find((k) => k === kind);
  return known ? flowNames[known] : '单据';
}
/** 选了哪些（shared/business/deletion-request.ts 的 deletionSelection 解析后的样子），这里只用到这两项 */
type DeletionSelection = { items: { id: number }[]; inventoryPolicy: 'preserve' | 'recalculate' };

/**
 * 影响清单：要删的、只解除关联的每一行。documentFields 是单据 JSON 里解除的是哪种关联（按 rowid 记），
 * 清单按这个名字显示，不笼统写“单据内关联”。
 */
export function impactList(
  g: Pick<DeletionGraph, 'byId' | 'gone'>,
  deletions: Deletion[],
  updates: Update[],
  documentFields: Map<string, Map<number, Set<string>>>,
): ImpactRow[] {
  // 影响清单里每行叫什么：单号、名称，没有的按表的主人登记的叫法（库存流水是“哪种货 出/入 多少”）。
  // 都没有的不拿内部编号（flow-1-1、自增号）充数，写“没有单号”；新表要在主人的 deletion.ts 登记叫法
  const label = (t: string, r: Row) =>
    textOf(r.number) || textOf(r.name) || deletionLabel(t, r, g) || '没有单号';
  const { byId, gone } = g;
  // 只给界面显示用的标记（不进范围摘要）：库存流水是入库还是出库，清单顶部按它汇总“入库流水 N 笔”；
  // 只有一张采购单的订货单，单号就是这张被删采购单的单号，对人来说就是这张采购单，界面并进采购单不另列
  const deletedPurchaseNumbers = new Set(
    deletions.filter((d) => d.table === 'purchases').map((d) => textOf(d.row.number)),
  );
  // 订货单里去掉的那张采购单：订货单没被整张删掉（里面还有别的采购单）时，界面要列“订货单 DG-… 保留，去掉这张采购单”
  const keptBatch = (r: Row) => {
    const batch = byId('order_batches').get(r.batch_id);
    return batch && !gone('order_batches', batch) ? { keptBatch: String(batch.number) } : {};
  };
  // 保留下来的单据去掉了哪种流水（被删流水里来源是这张单据的）：清单右边按方向说“去掉已删的入库流水”
  const removedMovements = (r: Row): 'in' | 'out' | 'both' | undefined => {
    const own = deletions.filter(
      (d) =>
        d.table === 'stock_movements' &&
        String(d.row.source_kind).startsWith(flowEntityPrefix) &&
        Number(d.row.source_id) === Number(r.id),
    );
    if (!own.length) return undefined;
    const out = own.some((d) => Number(d.row.delta_units) < 0),
      into = own.some((d) => Number(d.row.delta_units) >= 0);
    return out && into ? 'both' : out ? 'out' : 'in';
  };
  type Display = { direction?: 'in' | 'out'; partOf?: string; keptBatch?: string; removedMovements?: 'in' | 'out' | 'both' };
  const display = (t: string, r: Row, action: 'delete' | 'detach'): Display => ({
    ...(t === 'stock_movements' ? { direction: Number(r.delta_units) < 0 ? 'out' : 'in' } : {}),
    ...(t === 'order_batches' && action === 'delete' && deletedPurchaseNumbers.has(textOf(r.number)) ? { partOf: 'purchases' } : {}),
    // 订货单保留、只去掉了这次删的采购单（operations/deletion.ts 同时把到货安排里只属于它的行去掉、版本号加一）：
    // 界面已经按成员行列了“订货单 DG-… 保留，去掉这张采购单”，这一行并进那一条，不另列、不算进内部关联条数
    ...(t === 'order_batches' && action === 'detach' ? { partOf: 'order_batch_purchases', keptBatch: String(r.number) } : {}),
    ...(t === 'order_batch_purchases' ? { partOf: 'purchases', ...keptBatch(r) } : {}),
    ...(t === 'flow_documents' && action === 'detach' && removedMovements(r) ? { removedMovements: removedMovements(r) } : {}),
  });
  return [
    ...deletions.map(({ table: t, row: r }): ImpactRow => ({
      table: t,
      id: rowId(r),
      name: label(t, r),
      action: 'delete',
      kind: textOf(r.kind),
      ...display(t, r, 'delete'),
    })),
    ...updates.map(({ table: t, row: r, value }): ImpactRow => {
      const inDocument = documentFields.get(t)?.get(r.__rowid);
      return {
        table: t,
        id: rowId(r),
        name: label(t, r),
        action: 'detach',
        // 和会删除的一样带上单据类型：界面按它叫“到货单”“生产任务”，不笼统写“业务单据”
        kind: textOf(r.kind),
        ...display(t, r, 'detach'),
        fields: [...new Set(Object.keys(value).flatMap((k) => (k === 'document' && inDocument ? [...inDocument] : [k])))],
      };
    }),
  ];
}

/**
 * 预览里“库存怎么变”那段话要的数（只读，只用来写说明，见 deletion-summary.ts）：
 * 被删库存品自己的流水（own）、按库存处理方式处理的流水（choice，来自哪些被删的单据）、只解除关联保留的流水（kept）。
 * choice 的笔数和规划时数的 inventoryChoice 是同一批：一起删时是被删流水里不属于被删库存品的，
 * 保留时是改了来源（source_kind）的那些。
 */
export function inventoryFigures(
  selection: DeletionSelection,
  table: string,
  deletions: Deletion[],
  updates: Update[],
  g: Pick<DeletionGraph, 'ids' | 'byId' | 'rows'>,
): Omit<InventoryEffectInput, 'module' | 'count' | 'policy'> {
  const deletedItems = g.ids('stock_items'),
    { byId, rows } = g;
  const moves = deletions.filter((d) => d.table === 'stock_movements').map((d) => d.row),
    patched = updates.filter((u) => u.table === 'stock_movements');
  const own = moves.filter((m) => deletedItems.has(m.item_id));
  const choice =
    selection.inventoryPolicy === 'preserve'
      ? patched.filter((u) => Object.hasOwn(u.value, 'source_kind')).map((u) => u.row)
      : moves.filter((m) => !deletedItems.has(m.item_id));
  const kept = patched.filter((u) => !Object.hasOwn(u.value, 'source_kind'));
  const selected = new Set(table === 'flow_documents' ? selection.items.map((i) => i.id) : []);
  let selectedHit = false;
  const docs = new Map<string, { measure: string; ids: Set<number> }>();
  const add = (name: string, measure: string, id: number) => {
    const entry = docs.get(name) ?? { measure, ids: new Set<number>() };
    entry.ids.add(id);
    docs.set(name, entry);
  };
  for (const m of choice) {
    const kind = String(m.source_kind),
      id = Number(m.source_id);
    if (kind === movementSource.purchaseReturn) add('采购退货', '笔', id);
    else if (selected.has(id)) selectedHit = true;
    else {
      const docKind: unknown =
        kind === movementSource.reversal ? byId('flow_documents').get(id)?.kind : flowKinds.find((k) => flowEntity(k) === kind);
      add(flowName(docKind), '张', id);
    }
  }
  const keptDocs = new Map<string, number>();
  if (kept.length)
    for (const u of updates)
      if (u.table === 'flow_documents' && u.row.kind !== 'task') {
        const name = flowName(u.row.kind);
        keptDocs.set(name, (keptDocs.get(name) || 0) + 1);
      }
  // 流水分入库、出库数：说明里的叫法和清单逐条的一致（全是入库就叫“入库流水”）
  const directions = (list: Row[]) => ({
    in: list.filter((m) => Number(m.delta_units) >= 0).length,
    out: list.filter((m) => Number(m.delta_units) < 0).length,
  });
  // 被删的库存品现在还有多少（余额由流水合计，删之前的样子）：大于 0 的写进说明，删掉后这些库存就没有了
  const deletedStock = deletions.filter((d) => d.table === 'stock_items').map((d) => d.row);
  const balances = new Map<number, number>();
  if (deletedStock.length)
    for (const m of rows('stock_movements'))
      if (deletedItems.has(m.item_id)) {
        const itemId = Number(m.item_id);
        balances.set(itemId, (balances.get(itemId) || 0) + Number(m.delta_units));
      }
  // 删的就是库存品时：选中的这几个是成品还是原材料，说明里按它叫“这个原材料库存”（和清单、现存数量那句一致）
  const chosen = new Set(table === 'stock_items' ? selection.items.map((i) => i.id) : []);
  return {
    subjectKinds: [...new Set(deletedStock.filter((item) => chosen.has(Number(item.id))).map((item) => String(item.kind ?? '')))],
    stockLeft: deletedStock.flatMap((item) => {
      const left = balances.get(Number(item.id)) || 0;
      return left > 0
        ? [{ name: String(item.name ?? ''), kind: String(item.kind ?? ''), quantity: quantityString(left), unit: String(item.unit ?? '') }]
        : [];
    }),
    own: own.length,
    ownDirections: directions(own),
    ownItems: new Set(own.map((m) => Number(m.item_id))).size,
    ownItemKinds: [...new Set(own.map((m) => String(byId('stock_items').get(m.item_id)?.kind ?? '')))],
    choice: choice.length,
    choiceDirections: directions(choice),
    choiceDocs: {
      selected: selectedHit,
      others: [...docs].map(([name, d]) => ({ name, count: d.ids.size, measure: d.measure })),
    },
    kept: kept.length,
    keptDirections: directions(kept.map((u) => u.row)),
    keptDocs: [...keptDocs].map(([name, count]) => ({ name, count })),
  };
}
