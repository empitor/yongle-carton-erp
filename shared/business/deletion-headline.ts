/**
 * 删除确认的那一句话（“删除供应商和它的 2 张采购单、1 张到货单”）和它用到的清单规则，只写这一份：
 * 页面删除窗口、助手核对区的按钮（src/recordkit/deletion-impact.ts）和助手删除卡片的标题
 * （server/assistant/tools/records-lifecycle.ts）都用这里，数字都是同一份删除预览列出的条数。叫法在 deletion-words.ts。
 */
import { flowKinds, isFlowKind, type FlowKind } from './physical-flow.js';
import { recordNames } from './labels.js';
import { deletionMeasure as measure, deletionTableLabel, stockWord } from './deletion-words.js';

/** 删除预览影响清单里的一行（服务器 DatabaseMaintenanceService.preview 给的） */
export type DeletionImpactRow = {
  table: string;
  id?: unknown;
  name: string;
  action: string;
  kind?: string;
  fields?: string[];
  direction?: 'in' | 'out';
  partOf?: string;
  keptBatch?: string;
  removedMovements?: 'in' | 'out' | 'both';
};

/**
 * 不逐条列给人看、只在末尾说一共几条的：实现细节的关联表。订货单里的成员行（order_batch_purchases）也算：
 * 它跟着采购单删，订货单还留着时由 keptBatch 另列一条“订货单 DG-… 保留，去掉这张采购单”。
 */
export const deletionInternalTables = new Set([
  'flow_refs',
  'flow_receipt_keys',
  'flow_file_uses',
  'operation_requests',
  'order_batch_purchases',
]);
/** 这一行要不要逐条列出来：内部关联不列；服务器标了 partOf 的并进所属业务记录不单列。 */
export const deletionListedRow = (r: DeletionImpactRow) => !deletionInternalTables.has(r.table) && !r.partOf;

/** 汇总里的叫法：流水分入库、出库 */
export const deletionSummaryLabel = (r: DeletionImpactRow) =>
  r.table === 'stock_movements'
    ? r.direction === 'out'
      ? '出库流水'
      : r.direction === 'in'
        ? '入库流水'
        : '出入库流水'
    : deletionTableLabel(r);

/** 按出现顺序数每一类有几条：[叫法, { 条数, 量词 }] */
export function deletionTally(rows: DeletionImpactRow[]) {
  const counts = new Map<string, { count: number; measure: string }>();
  for (const r of rows) {
    const label = deletionSummaryLabel(r);
    const entry = counts.get(label) ?? { count: 0, measure: measure(r.table) };
    entry.count++;
    counts.set(label, entry);
  }
  return [...counts];
}

/** 删除模块对应的表：单据类在单据表里 */
export const deletionModuleTable = (module: string) => (isFlowKind(module) ? 'flow_documents' : module);

/** 标题只说连带的档案和单据：明细是主单据的一部分，库存流水在清单里逐笔列、并让按钮用警示样式 */
const partTables = new Set(['order_lines', 'purchase_lines', 'stock_movements']);
/** 标题里先说档案，再按业务先后说单据：订单、采购单、订货单，然后生产任务、完工、到货、送货 */
const headlineOrder = ['products', 'stock_items', 'orders', 'purchases', 'order_batches', 'flow_documents'];
/** 单据的先后：每种单据都要排上（少一种编译报错） */
const flowRank: Record<FlowKind, number> = { task: 0, production: 1, arrival: 2, delivery: 3 };
const headlineRank = (r: DeletionImpactRow) => {
  const t = headlineOrder.indexOf(r.table);
  const kind = String(r.kind ?? '');
  return (t < 0 ? headlineOrder.length : t) * flowKinds.length + (isFlowKind(kind) ? flowRank[kind] : 0);
};
const documentTables = new Set(['orders', 'purchases', 'flow_documents']);

/**
 * 删除确认的标题和主按钮：删的是什么，连带删掉几张什么单据，数字就是删除预览列出的条数（不自己数）。
 * 例：“删除供应商和它的 12 张采购单、8 张到货单”。label 是单条删除时这条记录的单号或名字（助手卡片标题带上，
 * “删除供应商 虚构纸业和它的……”）。alarming：会删到库存流水、连带删到单据，或选中的单据已经生效，
 * 这时主按钮用警示样式、默认焦点放在“取消”。
 */
export function deletionHeadline(
  module: string,
  rows: { id?: unknown; status?: unknown }[],
  impact: DeletionImpactRow[],
  label?: string,
) {
  const selectedTable = deletionModuleTable(module),
    ids = new Set(rows.map((r) => r.id));
  const own = (r: DeletionImpactRow) =>
    r.table === selectedTable && (r.table !== 'flow_documents' || r.kind === module) && ids.has(r.id);
  const deleted = impact.filter((r) => r.action === 'delete' && deletionListedRow(r));
  const extra = deleted
    .filter((r) => !own(r) && !partTables.has(r.table))
    .sort((a, b) => headlineRank(a) - headlineRank(b));
  const noun =
    module === 'stock_items'
      ? stockWord([...new Set(deleted.filter(own).map((r) => String(r.kind ?? '')))])
      : recordNames[module] || '记录';
  const head =
    rows.length === 1
      ? '删除' + noun + (label ? ' ' + label : '')
      : '删除 ' + rows.length + ' ' + measure(selectedTable) + noun;
  const title = extra.length
    ? head +
      '和' +
      (rows.length === 1 ? '它' : '它们') +
      '的 ' +
      deletionTally(extra)
        .map(([name, t]) => t.count + ' ' + t.measure + name)
        .join('、')
    : head;
  // 预览不带连带单据的状态，连带删到订单、采购单、单据就按可能已确认处理
  const alarming =
    impact.some((r) => r.action === 'delete' && r.table === 'stock_movements') ||
    extra.some((r) => documentTables.has(r.table)) ||
    (selectedTable === 'flow_documents' && rows.some((r) => r.status !== 'draft'));
  return { title, alarming };
}
