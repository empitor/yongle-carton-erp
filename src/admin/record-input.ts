import { dataManagementFieldName } from '../../shared/business/index';
import { costCents, costYuan, errorMessage, legacyCents, plainPrice, priceFromCents, samePrice, type ApiJson } from '../../shared/core/index';
import { isJsonList, isJsonObject, type JsonObject } from './record-types';
// 数据管理编辑窗里的金额换算：库里存分、编辑窗里按元填；采购、到货明细的单价没改就交回原文。
/** 订单的预估成本：几项都没填就是没有预估成本（存 null） */
const costKeys = ['material', 'processing', 'waste', 'other', 'basis'] as const;
type CostKey = (typeof costKeys)[number];
const blankCosts = (): JsonObject => Object.fromEntries(costKeys.map((k) => [k, k === 'basis' ? '' : null]));
const costsBlank = (costs: JsonObject) =>
  costKeys.every((k) => {
    const v = costs[k];
    return v == null || (typeof v === 'string' && !v.trim());
  });

/** 单价的分 → 给人看的元，整数乘 100 用 BigInt，不用浮点；按全站单价写法（100 → “1.00”，279 → “2.79”） */
const yuanOfCents = (cents: ApiJson | undefined) =>
  cents == null || cents === ''
    ? ''
    : Number.isSafeInteger(Number(cents))
      ? plainPrice(priceFromCents(Number(cents)))
      : String(cents);
/** 单价给人看的写法：有精确价按精确价（全站单价写法：至少两位、最多四位，尾零去掉），没有按分换成元，都没有是空 */
const shownPrice = (exact: ApiJson | undefined, cents: ApiJson | undefined) =>
  typeof exact === 'string' && exact.trim() ? plainPrice(exact.trim()) : cents == null ? '' : yuanOfCents(cents);
/** 填的单价（元，最多四位小数，已去掉首尾空白）对应的分：和保存时同一个换算（legacyCents，四舍五入到分）；空着或格式不对返回 null，留给校验去拦 */
function centsOfPrice(exact: string) {
  if (!exact) return null;
  try {
    return legacyCents(exact);
  } catch {
    return null;
  }
}
/**
 * 填的预估成本（元）→ 分；空着是 null。格式不对、超上限由 costCents 说明真正的原因（小数位、上限分开提示），
 * 不交给服务端报“金额（分）必须是整数”。
 */
function centsOfYuan(value: ApiJson | undefined) {
  const text = value == null ? '' : String(value).trim();
  return text ? costCents(text) : null;
}

/**
 * 编辑窗里填的内容没法提交（预估成本写了三位小数这类）：fields 按字段路径（“costs.material”）记每一格的原因，
 * 编辑窗把原因写在那一格下面、把光标放过去；message 是几条连起来的整句，给不认字段的地方看。
 */
export class RecordInputError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super(
      Object.entries(fields)
        .map(([path, reason]) => {
          const [parent, key] = path.includes('.') ? path.split('.') : ['', path];
          return dataManagementFieldName(key, parent) + '：' + reason;
        })
        .join('；') + '。',
    );
  }
}
/** 按“上一层.字段”取编辑中内容里的值（编辑窗对比哪一格改过了，改过的那格不再标错） */
export const valueAt = (input: ApiJson | undefined, path: string) =>
  path
    .split('.')
    .reduce<ApiJson | undefined>(
      (v, k) => (isJsonObject(v) ? v[k] : isJsonList(v) ? v[Number(k)] : undefined),
      input,
    );

/** 采购单、到货单明细的单价是元的文字，库里原样存（2.7600 这种） */
const textPriceModules = new Set(['purchases', 'arrival']);
/** 明细逐项换一下（不是对象的项原样留着）；不是数组原样交回 */
const mapLines = (lines: ApiJson | undefined, change: (line: JsonObject) => JsonObject) =>
  isJsonList(lines) ? lines.map((l) => (isJsonObject(l) ? change(l) : l)) : lines;
/** 预估成本放进编辑窗：没有成本摊开成空的几项；有成本的几项从分换成元，依据原样 */
const editableCosts = (costs: ApiJson | undefined): JsonObject =>
  isJsonObject(costs)
    ? Object.fromEntries(
        costKeys.map((k) => {
          const v = costs[k];
          return [k, k === 'basis' ? (v ?? '') : v == null ? null : costYuan(v)];
        }),
      )
    : blankCosts();
/** 产品的参考单价放进编辑窗：只给一个“元”的格子 */
function editableProduct(value: JsonObject): JsonObject {
  if (value.priceExact != null) return { ...value, priceExact: shownPrice(value.priceExact, value.priceCents) };
  if (!Object.hasOwn(value, 'priceCents')) return { ...value, priceExact: '' };
  // 排在“分”后面（“分”在编辑窗里不显示）；分是 0 就是没定价，留空
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]): [string, ApiJson | undefined][] =>
      k === 'priceCents' ? [[k, v], ['priceExact', Number(v) > 0 ? yuanOfCents(v) : '']] : [[k, v]],
    ),
  );
}
/**
 * 放进编辑窗的内容（金额都换成元，保存时 submittedInput 换回去，库里怎么存不变）：
 * - 产品的参考单价、订单明细的单价只给一个“元”的格子：有精确价按精确价，没有按分换成元；没定价的产品是空的，
 *   填了就按它定价（保存规则见 shared/core/precision.ts 的 priceEdit，空着保存还是没定价）；
 * - 没有预估成本的订单（新建模板里也是 null）摊开成空的几项成本，和有成本的订单一样填，不显示成一个文本框；
 *   有成本的几项从分换成元；
 * - 采购单、到货单明细的单价按全站单价写法显示（2.7600 → 2.76），保存时数值没改的还原原文（submittedInput）。
 */
export function editableInput(module: string, input: JsonObject): JsonObject {
  const value = structuredClone(input);
  if (module === 'orders')
    return {
      ...value,
      // 库里没存金额结算、税率、含税口径的订单照实显示空值格子，方便编辑补填
      roundingPolicy: value.roundingPolicy ?? null,
      taxRate: value.taxRate ?? null,
      taxMode: value.taxMode ?? null,
      costs: editableCosts(value.costs),
      lines: mapLines(value.lines, (l) => ({
        ...l,
        taxRate: l.taxRate ?? null,
        taxMode: l.taxMode ?? null,
        unitPriceExact: shownPrice(l.unitPriceExact, l.unitPriceCents),
      })),
    };
  if (textPriceModules.has(module) && isJsonList(value.lines))
    return {
      ...value,
      lines: mapLines(value.lines, (l) =>
        typeof l.unitPrice === 'string' && /^\d+(\.\d+)?$/.test(l.unitPrice.trim())
          ? { ...l, unitPrice: plainPrice(l.unitPrice.trim()) }
          : l,
      ),
    };
  return module === 'products' ? editableProduct(value) : value;
}

/**
 * 采购单、到货单明细的单价：编辑窗里显示的是去掉尾零的写法（2.76），数值没改的行交回库里原来的文字（2.7600），
 * 免得只是显示写法不同就把单据内容改了（到货单的财务指纹按单据原文算，写法变了会被当成“单据改过了”）。
 * 按明细编号对行，没编号的按位置对；改了数值的照填的交。
 */
function keptPriceText(lines: ApiJson | undefined, before: ApiJson | undefined) {
  if (!isJsonList(lines) || !isJsonList(before)) return lines;
  return lines.map((l, i) => {
    if (!isJsonObject(l) || typeof l.unitPrice !== 'string') return l;
    const old = l.id != null ? before.find((b) => isJsonObject(b) && b.id === l.id) : before[i];
    return isJsonObject(old) &&
      typeof old.unitPrice === 'string' &&
      old.unitPrice !== l.unitPrice &&
      samePrice(l.unitPrice, old.unitPrice)
      ? { ...l, unitPrice: old.unitPrice }
      : l;
  });
}
/** 订单明细交回去：单价按填的“元”算出“分”；元空着就把分也清空；格式不对的原样交，由校验提示 */
function submittedLine(l: JsonObject): JsonObject {
  if (!Object.hasOwn(l, 'unitPriceExact')) return l;
  const raw = l.unitPriceExact,
    text = typeof raw === 'string' ? raw.trim() : raw;
  if (text == null || text === '') return { ...l, unitPriceExact: '', unitPriceCents: null };
  const cents = typeof text === 'string' ? centsOfPrice(text) : null;
  return cents == null ? l : { ...l, unitPriceExact: text, unitPriceCents: cents };
}
/** 预估成本的一项交回去：依据原样，金额按元换成分；格式不对的把原因记进 wrong（按字段路径） */
function submittedCost(k: CostKey, costs: JsonObject, wrong: Record<string, string>): [CostKey, ApiJson | undefined] {
  if (k === 'basis') return [k, costs[k]];
  try {
    return [k, centsOfYuan(costs[k])];
  } catch (e) {
    wrong['costs.' + k] = errorMessage(e);
    return [k, null];
  }
}
/**
 * 交给服务端的内容：
 * - 产品参考单价、订单明细单价按填的“元”算出“分”一起交（和保存时同一个换算，两头对得上）；
 *   产品的元空着按没定价存；订单明细的元空着就把分也清空，由校验提示“请填写单价”；格式不对的原样交，由校验提示；
 * - 订单的预估成本几项都空着就按没有预估成本（null）存；填了的按元换成分，填了一部分的照样提交，由校验提示缺哪项；
 *   金额结算“未填写”的不交。
 * 金额格式不对（成本写了三位小数这类）抛出 RecordInputError（每一格的原因分开记），不提交。
 */
export function submittedInput(module: string, input: JsonObject, original?: JsonObject): JsonObject {
  if (textPriceModules.has(module))
    return isJsonList(input.lines) ? { ...input, lines: keptPriceText(input.lines, original?.lines) } : input;
  if (module === 'products') {
    const exact = typeof input.priceExact === 'string' ? input.priceExact.trim() : '',
      cents = centsOfPrice(exact);
    return cents == null ? input : { ...input, priceExact: exact, priceCents: cents };
  }
  if (module !== 'orders') return input;
  const lines = mapLines(input.lines, submittedLine);
  // 几项金额格式不对的一起说（每一格写在那一格下面），不只说第一项
  const wrong: Record<string, string> = {},
    given = input.costs;
  const costs =
    isJsonObject(given) && !costsBlank(given)
      ? Object.fromEntries(costKeys.map((k) => submittedCost(k, given, wrong)))
      : null;
  if (Object.keys(wrong).length) throw new RecordInputError(wrong);
  // 金额结算是“未填写”就不交这一格：没动它的保存不写它；单价有不足一分的尾数时由服务端报错让人选
  const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'roundingPolicy' || v != null));
  return { ...rest, lines, costs };
}
