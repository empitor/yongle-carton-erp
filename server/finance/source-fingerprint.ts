import { createHash } from 'node:crypto';
import { isRecord } from '../../shared/core/index.js';

/**
 * 进事件快照的单据内容：单号以单据表的单号列为准。库里的单据内容（document）不存单号，
 * 补进快照给财务各处显示；来源指纹按单据内容算（去掉纯说明字段，见 sourceHash），不含这里补的单号。
 */
export const withNumber = <T extends object>(doc: T, number: string | null): T =>
  number ? { ...doc, number } : doc;
/**
 * 来源指纹的规则：只包含财务口径用得到的内容。财务（含月末成本计算）不读、变了也不会让任何金额、数量、
 * 往来对象、日期、状态变化的字段，都不算进指纹；只改这些，版本号变了也不新增、替换、改动财务事件。
 * 事件快照照旧存整份单据（“有差异”的改前改后对比、单号显示都从快照读）。
 *
 * 送货、到货、完工单 document 顶层不算的：
 * - 纯说明：notes（单据备注、批次备注）、address、contact、phone（送货地址联系人）、plannedTime、actualTime（时间段）、
 *   overdeliveryReason、allowOverdelivery（超量送货的批准和原因）、operator（完工操作人员：成本按库存流水算，不按人）。
 * - 计划和对方单号：plannedDate（计划日；进财务的都是已确认单据）、reference（供应商送货单号：
 *   财务的单号按单据表的单号列补，只在没有单号时才退用它，送货、到货、完工单都有单号）。
 * - 单据日期：date（和单据表的日期列一样，指纹另从列取）。
 * - 经办记录：confirmedBy、shippedBy、deliveredBy（谁确认、出库、送达，只记人名）；shippedAt（出库时刻，
 *   日期就是单据日期列，已算进指纹）；deliveredAt（送达日期：送货单出库就记收入，送达不改金额、往来和日期）；
 *   correctionReason、correctedAt（到货更正的原因和时刻）；reversal、cancellation（冲销、取消的原因、人、时刻和
 *   流水编号：状态另从列取）。
 * - 别处的编号：sourceId（原始文件）、orderBatchId（订货批次：批次删掉时会从单据里去掉）、movements（库存流水编号：
 *   成本按流水表算，不读这份编号）、taskId、productName（完工单挂的生产任务和产品名：成本按流水算）。
 * 送货明细不算的：notes（明细备注）、specification、orderNumber、externalPurchaseOrder、customerProductCode
 * （抄的订单资料，财务按 orderId、orderLineId、productId 认）、length、width、height、dimensionUnit（成品尺寸：
 * 送货按只计价）、material、flute（出库核对时抄的产品材质、楞型，只印在送货单上）、amountExact（按数量和单价算出来的，
 * 财务自己算）。
 * 到货明细不算的：notes、differenceReason（差异原因）、statedQuantity、statedArea（对方单据上写的原文数量、面积：
 * 到货金额按入库数量和规格尺寸算，见到货计价和 purchaseLineAmount）、rejectedQuantity（不合格数，由实收和合格数定）、
 * area、amount（按实收算的面积、金额，财务按入库数量自己算）、purchaseId、purchaseNumber、supplierName（抄的采购单
 * 资料，财务按 purchaseLineId 认、往来单位按表头）。明细的 item（纸板资料）只算 name、unit、length、width、
 * dimensionUnit（品名给人看，单位和长宽算面积），规格说明、材质、楞型、高、备注不算。
 * 完工单的产品、成品库存、良品和报废数量、领料都算：它们决定库存流水，月末成本按流水算，改了要重新算成本。
 * 盘点流水（stock）不算的：reason（流水备注，成本计算只拿来显示）。
 * 其余字段都算：数量、单价、计价依据、税率（明细）、往来单位和名称、明细的库存品、订单、产品和品名、
 * 更正和替代关系、确认时间（决定收入确认口径）等。
 */
const flowTop = [
  'notes', 'address', 'contact', 'phone', 'plannedTime', 'actualTime', 'overdeliveryReason', 'allowOverdelivery', 'operator',
  'plannedDate', 'reference', 'date',
  'confirmedBy', 'shippedAt', 'shippedBy', 'deliveredAt', 'deliveredBy', 'correctionReason', 'correctedAt', 'reversal', 'cancellation',
  'sourceId', 'orderBatchId', 'movements', 'taskId', 'productName',
];
const outsideFinance: Record<string, { top: string[]; line: string[]; itemKeeps?: string[] }> = {
  delivery: {
    top: flowTop,
    line: [
      'notes', 'specification', 'orderNumber', 'externalPurchaseOrder', 'customerProductCode',
      'length', 'width', 'height', 'dimensionUnit', 'material', 'flute', 'amountExact',
    ],
  },
  arrival: {
    top: flowTop,
    line: [
      'notes', 'differenceReason', 'statedQuantity', 'statedArea', 'rejectedQuantity',
      'area', 'amount', 'purchaseId', 'purchaseNumber', 'supplierName',
    ],
    itemKeeps: ['name', 'unit', 'length', 'width', 'dimensionUnit'],
  },
  production: { top: flowTop, line: [] },
  stock: { top: ['reason'], line: [] },
};

/** 去掉这些键的副本 */
const without = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
/** 只留这些键（有的才留）的副本 */
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));

/**
 * 按键名排好序的副本。单据确认时和管理员编辑时整份重写 document，键的先后不一样（内容完全相同），
 * 直接 JSON.stringify 算出来的指纹就不同；排好序再算，只看内容。
 */
const sortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item: unknown) => sortedKeys(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
};

/** 一行明细去掉不算的字段；到货明细的纸板资料只留算的那几项 */
const lineContent = (line: unknown, rule: { line: string[]; itemKeeps?: string[] }) => {
  if (!isRecord(line)) return line;
  const copy = without(line, rule.line);
  if (rule.itemKeeps && isRecord(copy.item)) copy.item = only(copy.item, rule.itemKeeps);
  return copy;
};

/** 指纹用的单据内容：去掉上面不算的字段，键按名字排好。 */
const financialContent = (kind: string, doc: unknown) => {
  const rule = Object.hasOwn(outsideFinance, kind) ? outsideFinance[kind] : undefined;
  if (!rule || !isRecord(doc)) return doc;
  const out = without(doc, rule.top);
  if (Array.isArray(out.lines)) out.lines = out.lines.map((line: unknown) => lineContent(line, rule));
  return sortedKeys(out);
};
/** 来源指纹：状态、日期和财务用得到的单据内容的 sha256。判断“来源变没变”只看它。 */
export const sourceHash = (source: { kind: string; status: string; date: string }, doc: unknown) =>
  createHash('sha256')
    .update(JSON.stringify({ status: source.status, date: source.date, doc: financialContent(source.kind, doc) }))
    .digest('hex');
