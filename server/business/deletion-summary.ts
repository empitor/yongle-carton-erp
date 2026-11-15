/**
 * 删除预览里给人看的“库存怎么变”那段话（DatabaseMaintenanceService.preview 的 inventoryEffect）。
 * 页面删除窗口和助手确认卡片都显示它。只写说明，不参与删除范围和核对。
 *
 * 出入库流水在一次删除里有三种去向，说明里分开说，数字和影响清单逐条列出的对得上：
 * - own：被删库存品自己的流水，库存品没了它们只能一起删（按外键，和库存处理方式无关）；
 * - choice：连带删掉的单据（到货、完工、送货、采购退货）在别的库存品上的流水，按“库存怎么处理”
 *   一起删掉重算（recalculate），或保留改成“系统维护”流水（preserve）；
 * - kept：只是解除关联、原样保留的流水（比如删采购单时到货入库的流水不再挂这张采购单）。
 * 流水的叫法和清单一致：同一组全是入库叫“入库流水”，全是出库叫“出库流水”，两种都有才叫“出入库流水”。
 * 被删库存品现在还有库存的，写明名称和数量（删掉后这些库存就没有了）。
 * 流水、库存品的叫法和“库存怎么处理”的选项文字只在 shared/business/deletion-words.ts 写一份，页面窗口和助手卡片共用。
 */
import {
  deletesDocuments,
  deletionMeasure,
  keepStockScope,
  movementWord,
  recordNames,
  stockWord,
  type Directions,
} from '../../shared/business/index.js';

/**
 * 删的是什么：“这张采购单”“这家供应商”“这 3 张送货单”。删的是库存品时按仓库叫：“这个原材料库存”“这个成品库存”，
 * 和清单、现存数量那句同一个叫法（kinds 是被删库存品的 kind）。
 */
function deletionSubject(module: string, count: number, kinds: readonly string[] = []) {
  const name = module === 'stock_items' ? stockWord(kinds) : recordNames[module] || '记录';
  return count === 1 ? '这' + deletionMeasure(module) + name : '这 ' + count + ' ' + deletionMeasure(module) + name;
}

export type InventoryEffectInput = {
  module: string;
  count: number;
  policy: 'preserve' | 'recalculate';
  /** 删的是库存品时：选中的这几个是成品还是原材料（说明里按它叫“这个原材料库存”） */
  subjectKinds?: string[];
  /** 被删库存品自己的流水笔数（分入库、出库），和这些库存品有几个、是成品还是原材料 */
  own: number;
  ownDirections?: Directions;
  ownItems: number;
  ownItemKinds?: string[];
  /** 按库存处理方式处理的流水笔数，和它们来自哪些被删的单据 */
  choice: number;
  choiceDirections?: Directions;
  choiceDocs: { selected: boolean; others: { name: string; count: number; measure: string }[] };
  /** 只解除关联、原样保留的流水笔数，和一起保留下来的单据 */
  kept: number;
  keptDirections?: Directions;
  keptDocs: { name: string; count: number }[];
  /** 被删的库存品里现在还有库存的（数量大于 0）：名称、成品还是原材料、现存数量和单位 */
  stockLeft?: { name: string; kind: string; quantity: string; unit: string }[];
};

const both: Directions = { in: 1, out: 1 };

/** 被删库存品现在还有库存的：名称和数量 */
function stockLeftPart(i: InventoryEffectInput) {
  const left = i.stockLeft || [];
  if (!left.length) return null;
  return (
    (i.module === 'stock_items' ? '' : '连带删掉的') +
    left.map((s) => stockWord([s.kind]) + '“' + s.name + '”现在还有 ' + s.quantity + (s.unit ? ' ' + s.unit : '')).join('，') +
    '，删掉后这些库存就没有了'
  );
}

/** 被删库存品自己的流水随库存品一起删 */
function ownPart(i: InventoryEffectInput, subject: string) {
  if (i.own <= 0) return null;
  const word = movementWord(i.ownDirections || both);
  if (i.module === 'stock_items') return subject + '的 ' + i.own + ' 笔' + word + '随' + (i.count > 1 ? '它们' : '它') + '一起删掉';
  const items = stockWord(i.ownItemKinds || []);
  return '连带删掉的 ' + i.ownItems + ' 个' + items + '的 ' + i.own + ' 笔' + word + '随' + items + '一起删掉';
}

/** 按“库存怎么处理”处理的流水：保留改成系统维护，或一起删掉重算 */
function choicePart(i: InventoryEffectInput, subject: string) {
  if (i.choice <= 0) return null;
  const others = i.choiceDocs.others.map((d) => d.count + ' ' + d.measure + d.name).join('、');
  const docs = [i.choiceDocs.selected ? subject : '', others ? '连带删掉的 ' + others : ''].filter(Boolean).join('和');
  const many = (i.choiceDocs.selected ? i.count : 0) + i.choiceDocs.others.reduce((n, d) => n + d.count, 0) > 1;
  // 被删库存品自己的流水已经单独说了：这里的都在别的库存品上
  const elsewhere = i.own > 0 ? '在别的库存品上' : '';
  const word = movementWord(i.choiceDirections || both);
  const effect =
    i.policy === 'preserve'
      ? keepStockScope(i.module) + '，库存数量不动：' + docs + elsewhere + '留下的 ' + i.choice + ' 笔' + word + '保留，改成“系统维护”流水'
      : '库存一起改回，当' + docs + '没发生过：' + (many ? '它们' : '它') + elsewhere + '的 ' + i.choice + ' 笔' + word +
        '一起删掉，' + (i.own > 0 ? '那些库存品的' : '') + '库存重新计算。改回后有库存会变负数（后面的单据已经用掉了）时删不了';
  return (i.own > 0 ? '另外，' : '') + effect;
}

/** 只解除关联、原样保留的流水和单据；前面已经说过别的（said）时用“另有”接上 */
function keptPart(i: InventoryEffectInput, subject: string, said: boolean) {
  if (i.kept <= 0) return null;
  const kept = [...i.keptDocs.map((d) => d.count + ' 张' + d.name), i.kept + ' 笔' + movementWord(i.keptDirections || both)].join('和 ');
  const tail =
    i.module === 'purchases' ? '只是不再挂' + subject : i.module === 'orders' ? '只是不再记在' + subject + '名下' : '只解除关联';
  return said ? '另有 ' + kept + '保留，' + tail : '库存数量不变：' + kept + '都保留，' + tail;
}

export function inventoryEffectText(i: InventoryEffectInput) {
  const subject = deletionSubject(i.module, i.count, i.subjectKinds);
  const parts = [stockLeftPart(i), ownPart(i, subject), choicePart(i, subject)].filter((p) => p !== null);
  const kept = keptPart(i, subject, parts.length > 0);
  if (kept !== null) parts.push(kept);
  if (!parts.length)
    return deletesDocuments(i.module) || ['purchases', 'stock_items'].includes(i.module)
      ? subject + '没有动过库存，删了不影响库存。'
      : '这次删除不涉及出入库流水，删了不影响库存。';
  return parts.join('。') + '。';
}
