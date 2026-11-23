import { flowKinds } from '../../shared/core/index';
import { deletionListedRow as listedRow, deletionMeasure as measure, deletionModuleTable as tableOf, deletionSummaryLabel as summaryLabel, deletionTableLabel as tableLabel, deletionTally as tally, flowNames, movementWord, recordNames, stockWord, type DeletionImpactRow } from '../../shared/business/index';

/**
 * 删除影响清单怎么给人看（页面删除窗口和助手的删除确认卡片共用，组件在 DeletionImpact.tsx）。
 * 只按删除预览给的数据排版：每行的表、单据类型、名字、删还是解除关联、解除的是哪种关联，
 * 以及服务器补的只读显示标记（不进删除范围摘要）：
 * - direction：库存流水是入库还是出库；
 * - partOf：这一行并进哪条业务记录、不单列（单号就是被删采购单号的订货单、订货单里的成员行并进采购单；
 *   到货单也在清单里的“到货记录”并进到货单）；
 * - keptBatch：订货单里去掉的那张采购单所在的订货单号，订货单没被整张删掉时要列“订货单 DG-… 保留，去掉这张采购单”；
 *   订货单这一行本身（到货安排去掉只属于这张采购单的行、版本号加一）也带它，并进那一条；
 * - removedMovements：保留下来的单据去掉的是哪种流水（入库、出库、两种都有），右边按它说“去掉已删的入库流水”。
 */
type ImpactRow = DeletionImpactRow;
export type DeletionPlanView = {
  impact?: ImpactRow[];
  selection?: { module?: string; items?: readonly { id?: unknown }[] };
};


/**
 * 库存品按仓库叫（成品库存 / 原材料库存，shared/business/lifecycle/deletion-words.ts），和清单左边、库存说明同一个叫法：
 * 看清单里会删除的库存品是哪种；selected 时只看选中的那几个。
 */
function stockName(plan: DeletionPlanView, selected: boolean) {
  const ids = new Set((plan.selection?.items || []).map((i) => i.id));
  const kinds = (plan.impact || [])
    .filter(
      (r) => r.table === 'stock_items' && r.action === 'delete' && (!selected || ids.has(r.id)),
    )
    .map((r) => String(r.kind ?? ''));
  return stockWord([...new Set(kinds)]);
}

/** 删的是什么：用在“不再挂这张采购单”里。选中的是这一类时说“这张…”，否则说“删掉的…” */
function target(plan: DeletionPlanView, table: string, kind?: string) {
  const module = plan.selection?.module,
    count = plan.selection?.items?.length || 0;
  const selectedTable = module && module in flowNames ? 'flow_documents' : module;
  const selected = selectedTable === table && (table !== 'flow_documents' || module === kind);
  const flowKind = flowKinds.find((k) => k === kind);
  const name =
    table === 'flow_documents'
      ? (flowKind && flowNames[flowKind]) || '单据'
      : table === 'stock_items'
        ? stockName(plan, selected)
        : tableLabel({ table });
  if (selected && count === 1) return '这' + measure(table) + name;
  if (selected) return '这些' + name;
  return '删掉的' + name;
}

type KeptPhrase = (plan: DeletionPlanView, r: ImpactRow) => string;
const unlinkPurchase: KeptPhrase = (plan) => '不再挂' + target(plan, 'purchases');
const unlinkStock: KeptPhrase = (plan) => '不再对应' + target(plan, 'stock_items');
// 和流水列表里这种流水的叫法一致（shared/business/operations/movement-filters.ts 的“系统维护”）
const keptAsMaintenance: KeptPhrase = () => '改成系统维护流水，库存数量不动';

/** 解除的字段 → 右边怎么说（按解除的是哪种关联说）；没列的字段说“去掉单据里对删掉记录的引用” */
const keptPhrases = new Map<string, KeptPhrase>([
  ['parent_product_id', (plan) => '不再附属于' + target(plan, 'products')],
  [
    'customer_order_id',
    (plan, r) =>
      ['purchases', 'purchase_lines'].includes(r.table)
        ? '不再记给' + target(plan, 'orders') + '订料'
        : r.table === 'stock_movements'
          ? '不再记在' + target(plan, 'orders') + '名下'
          : '不再关联' + target(plan, 'orders'),
  ],
  [
    'order_id',
    (plan, r) =>
      r.table === 'flow_documents' && r.kind === 'task'
        ? '不再记给' + target(plan, 'orders') + '生产'
        : '不再关联' + target(plan, 'orders'),
  ],
  ['purchase_line_id', unlinkPurchase],
  ['purchase_id', unlinkPurchase],
  ['stock_id', unlinkStock],
  ['stock_item_id', unlinkStock],
  ['product_id', (plan) => '不再对应' + target(plan, 'products')],
  ['customer_id', (plan, r) => (r.table === 'products' ? '变成没定客户' : '不再关联' + target(plan, 'customers'))],
  ['supplier_id', (plan) => '不再关联' + target(plan, 'suppliers')],
  ['task_id', (plan) => '不再挂' + target(plan, 'flow_documents', 'task')],
  ['source_id', keptAsMaintenance],
  ['source_kind', keptAsMaintenance],
  // 按这张单据被删的流水方向说（服务器标的 removedMovements），和清单左边“入库流水 / 出库流水”同一个词
  [
    'movements',
    (_plan, r) =>
      '去掉已删的' +
      movementWord({ in: r.removedMovements === 'out' ? 0 : 1, out: r.removedMovements === 'in' ? 0 : 1 }),
  ],
  ['order_batch_id', () => '不再属于删掉的订货单'],
  ['schedule', (plan) => '到货安排去掉' + target(plan, 'purchases') + '的行'],
  ['correction_of', () => '不再关联更正的原单'],
  ['replaced_by', () => '不再关联替代它的单据'],
]);

/** 解除关联的一行：保留下来，右边写不再关联什么（按解除的字段说） */
function keptNote(plan: DeletionPlanView, r: ImpactRow) {
  const phrases = (r.fields || []).map((f) => keptPhrases.get(f)?.(plan, r) ?? '去掉单据里对删掉记录的引用');
  const unique = [...new Set(phrases)];
  return '保留，' + (unique.length ? unique.join('，') : '只解除关联');
}

/** 会删除的一行右边的说明：只有订货单（里面的采购单都删了，整张一起删）要说为什么 */
function deletedNote(r: ImpactRow) {
  if (r.table === 'order_batches') return '订货单里已经没有采购单，一起删掉';
  return '';
}

/**
 * 订货单里去掉了采购单、订货单本身还留着（里面还有别的采购单）：按订货单一张一条，
 * 写“保留，去掉这张采购单（订货单里还有别的采购单）”。
 */
function keptBatches(plan: DeletionPlanView): ImpactLine[] {
  const counts = new Map<string, number>();
  for (const r of plan.impact || [])
    if (r.table === 'order_batch_purchases' && r.action === 'delete' && r.keptBatch)
      counts.set(r.keptBatch, (counts.get(r.keptBatch) || 0) + 1);
  return [...counts].map(([name, count]) => ({
    kind: '订货单',
    name,
    note:
      '保留，去掉' +
      (count === 1 ? target(plan, 'purchases') : '其中 ' + count + ' 张采购单') +
      '（订货单里还有别的采购单）',
  }));
}

export type ImpactLine = { kind: string; name: string; note: string };
type ImpactView = {
  summary: string;
  deleted: ImpactLine[];
  kept: ImpactLine[];
  /** 不逐条列出的内部关联条数 */
  hidden: number;
};


/**
 * 删除影响清单的版式：顶部一句按类别汇总，下面逐条列会删除的、保留只解除关联的，末尾说另有几条内部关联。
 * 汇总里的数字就是逐条列出的条数（“会删除 N”的 N 只数用户认识的记录）。
 */
export function deletionImpactView(plan: DeletionPlanView): ImpactView {
  const impact = plan.impact || [];
  const listed = impact.filter(listedRow);
  const deletedRows = listed.filter((r) => r.action === 'delete'),
    keptRows = listed.filter((r) => r.action !== 'delete');
  // 左边的叫法和汇总一致：流水按方向叫“入库流水 / 出库流水”
  const line = (r: ImpactRow, note: string): ImpactLine => ({
    kind: summaryLabel(r),
    name: r.name,
    note,
  });
  const deleted = deletedRows.map((r) => line(r, deletedNote(r))),
    keptLines = keptRows.map((r) => line(r, keptNote(plan, r))),
    batches = keptBatches(plan);
  const parts: string[] = [];
  if (deletedRows.length)
    parts.push(
      '将删除 ' +
        tally(deletedRows)
          .map(([label, t]) => t.count + ' ' + t.measure + label)
          .join('、'),
    );
  if (keptRows.length) {
    const notes = [...new Set(keptLines.map((k) => k.note))];
    parts.push(
      tally(keptRows)
        .map(([label, t]) => label + ' ' + t.count + ' ' + t.measure)
        .join('、') +
        // 都是同一种解除时直接说是什么；不一样的看下面逐条
        (notes.length === 1 ? notes[0] : '保留，只解除和删掉记录的关联（见下）'),
    );
  }
  // 订货单还留着、只是去掉了这张采购单：汇总里也说出来（“订货单 DG-… 保留，去掉这张采购单”）
  for (const b of batches) parts.push(b.kind + ' ' + b.name + ' ' + b.note.replace(/（.*）$/, ''));
  const kept = [...keptLines, ...batches];
  // 列成订货单那一条的成员行、订货单本身那一行（去掉安排行、版本号加一）不再算进“系统内部的关联记录”
  const surfaced = impact.filter(
    (r) =>
      r.keptBatch &&
      ((r.table === 'order_batch_purchases' && r.action === 'delete') ||
        (r.table === 'order_batches' && r.action !== 'delete')),
  ).length;
  return {
    summary: parts.length ? parts.join('；') + '。' : '',
    deleted,
    kept,
    hidden: impact.length - listed.length - surfaced,
  };
}

/**
 * 删完以后页面提示的那句（不带句号，调用方再接库存怎么处理）：说清删了谁、连带删了几条。
 * 连带的条数和清单“会删除 N”同一个口径（只数用户认识的记录），减去选中的这几条。
 */
export function deletionDoneMessage(
  module: string,
  rows: readonly { id?: unknown; number?: unknown; name?: unknown }[],
  impact: ImpactRow[],
) {
  const listed = deletionImpactView({ impact, selection: { module, items: rows } }).deleted.length;
  const extra = Math.max(0, listed - rows.length);
  // 删的是库存品时按仓库叫“原材料库存”“成品库存”，和窗口里的清单、说明一致
  const noun =
    module === 'stock_items'
      ? stockWord([
          ...new Set(
            impact
              .filter((r) => r.table === 'stock_items' && r.action === 'delete')
              .map((r) => String(r.kind ?? '')),
          ),
        ])
      : recordNames[module] || '记录';
  const one = rows.length === 1 ? rows[0] : null;
  const head = one
    ? one.number
      ? '已删除' + noun + ' ' + String(one.number)
      : one.name
        ? '已删除' + noun + '“' + String(one.name) + '”'
        : '已删除这' + measure(tableOf(module)) + noun
    : '已删除 ' + rows.length + ' ' + measure(tableOf(module)) + noun;
  return head + (extra ? '，连带 ' + extra + ' 条记录一起删除' : '');
}
