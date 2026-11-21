import { FINISHED_UNIT, RAW_UNIT } from '../../shared/core/index.js';
import { plainPrice } from '../../shared/core/index.js';
import { priceText, sizeText } from '../../shared/business/index.js';
import type { FinanceSourceDocument, FinanceSourceLine } from './source-snapshot.js';
import { readSnapshot } from './source-snapshot.js';
import type { DatabaseSync } from 'node:sqlite';
import { centsText } from '../../shared/core/index.js';
import { one, rows } from '../core/index.js';
import { taxBasis } from './event-evaluate.js';

/**
 * “有差异”的业务单据改了什么：把改之前（原来那张凭证依据的内容）和改之后的单据逐项比，只列变了的、
 * 和财务有关的项（往来单位、日期、金额、增减行，到货明细原地会变的几项），用中文叫法，
 * 数量带单位（只、张），单价带“元/只”“元/张”“元/m²”。
 * 备注、地址这类说明不列（快照的财务口径里没有它们，来源指纹也不算，见 shared/business/finance-source.ts）。只读，供详情展示。
 *
 * 单据生效以后，明细的数量、单价、税率、改挂订单或采购明细都要更正，出一张替代单（另一条来源，不在这里比）；
 * 同一张单据的明细原地会变的只有：到货明细的纸板资料（管理员改库存品时跟着对齐，flow/maintenance-cascade.ts 的
 * alignStock：品名、按面积计价时的长宽）和采购关联（管理员删改采购明细时解除，写成“对应采购单”）。
 * 送货单改订单时只会删行、拆单（business/order-edit-cascade.ts），留下的行原样不动，所以送货单只列增减的行。
 */
type EventChange = { label: string; before: string; after: string };

/**
 * 一边的内容。amount 是记进往来的金额（送货含税、到货不含税）；缺税率时它只是理论金额（不含税）。
 * taxPending 为 true 表示这一边还缺税率，theoretical 是这一边的理论金额（不含税），两边口径不同时拿它比。
 */
type Side = {
  doc: FinanceSourceDocument;
  date: string | null;
  amount: number | null;
  taxPending?: boolean;
  theoretical?: number | null;
};
type Line = FinanceSourceLine;
type Keyed = Map<string, { line: Line; index: number }>;

/** “有差异”往前找原来那张凭证依据的内容时，最多沿着“上一条”找几步（一张单改几十次才会碰到） */
export const PREVIOUS_CHAIN_MAX = 50;

const text = (value: unknown) => (value == null || value === '' ? '—' : String(value));
const cents = (value: number | null) => (value == null ? '—' : centsText(value) + ' 元');
/** 数量的单位：送货明细是“只”，到货明细是纸板的“张” */
const unitOf = (line: Line) => line.unit ?? line.item?.unit ?? '';
const withUnit = (quantity: unknown, line: Line) => {
  const t = text(quantity);
  const unit = unitOf(line);
  return t === '—' || !unit ? t : t + ' ' + unit;
};

/** 明细行对得上的依据：送货按订单明细，到货按采购明细或库存品，都没有按行号 */
const lineKey = (kind: string, line: Line, index: number) =>
  kind === 'delivery'
    ? line.orderLineId != null
      ? 'o' + String(line.orderLineId)
      : 'i' + index
    : line.purchaseLineId != null
      ? 'p' + String(line.purchaseLineId)
      : line.stockId != null
        ? 's' + String(line.stockId)
        : 'i' + index;
const nameOf = (line: Line) => line.item?.name ?? line.productName;
const lineName = (line: Line, index: number) => {
  const name = nameOf(line);
  return '第 ' + (index + 1) + ' 行' + (name ? '（' + name + '）' : '');
};

/** 新增、删掉的行写一句它的数量和单价：送货按送货数量、单价“元/只”，到货按入库数量、单价按计价方式 */
function brief(kind: string, line: Line) {
  if (kind === 'delivery') {
    const exact = line.unitPriceExact ?? line.unitPrice;
    const price =
      exact == null || exact === '' ? '—' : priceText(plainPrice(exact, 2), 'quantity', unitOf(line) || FINISHED_UNIT);
    return '数量 ' + withUnit(line.quantity, line) + '，单价 ' + price;
  }
  const price =
    line.unitPrice == null || line.unitPrice === ''
      ? '—'
      : priceText(line.unitPrice, line.priceBasis, unitOf(line) || RAW_UNIT);
  return '数量 ' + withUnit(line.stockedQuantity ?? line.quantity, line) + '，单价 ' + price;
}

/** 到货明细同一行比的几项：品名，按面积计价时纸板的长宽（金额跟着长宽走；按张计价不用比） */
function arrivalLineFields(line: Line): [string, string][] {
  const fields: [string, string][] = [['品名', text(nameOf(line))]];
  if (line.priceBasis === 'area') {
    const board = line.item;
    const size = { length: board?.length ?? null, width: board?.width ?? null, height: null, dimensionUnit: board?.dimensionUnit ?? null };
    fields.push(['长宽', text(sizeText(size))]);
  }
  return fields;
}

/**
 * 同一张单据里几行对应同一个键（到货两行是同一种纸板、都没关联采购明细时，按库存品对应就是同一个键）：
 * 按出现的先后再编号（第几次出现），不然后一行会盖掉前一行，改了其中一行也列不出来。
 */
const keyed = (kind: string, side: Side): Keyed => {
  const seen = new Map<string, number>();
  return new Map(
    (side.doc.lines ?? []).map((line, index) => {
      const base = lineKey(kind, line, index);
      const nth = seen.get(base) ?? 0;
      seen.set(base, nth + 1);
      return [base + '#' + nth, { line, index }] as const;
    }),
  );
};

/**
 * 按键对不上的到货行（解除了采购关联，键从采购明细换成库存品）：同一品名的一新一旧当成同一行，
 * 先找同一位置的，再找同品名的第一行
 */
function pairMoved(was: Keyed, now: Keyed) {
  const removed = [...was].filter(([key]) => !now.has(key)).map(([, v]) => v);
  const pairOf = new Map<number, { line: Line; index: number }>();
  for (const [key, { line, index }] of now) {
    if (was.has(key)) continue;
    const name = text(nameOf(line));
    const candidates = removed.filter((r) => text(nameOf(r.line)) === name);
    const match = candidates.find((r) => r.index === index) ?? candidates[0];
    if (!match) continue;
    pairOf.set(index, match);
    removed.splice(removed.indexOf(match), 1);
  }
  return { pairOf, removed };
}

const added = (kind: string, line: Line, index: number): EventChange => ({
  label: lineName(line, index) + '：新增',
  before: '—',
  after: brief(kind, line),
});
const dropped = (kind: string, line: Line, index: number): EventChange => ({
  label: lineName(line, index) + '：删掉了',
  before: brief(kind, line),
  after: '—',
});

/** 送货单的明细变化：只列新增、删掉的行（同一行原地不会变，见文件开头） */
function deliveryLineChanges(before: Side, after: Side, out: EventChange[]) {
  const was = keyed('delivery', before),
    now = keyed('delivery', after);
  for (const [key, { line, index }] of now) if (!was.has(key)) out.push(added('delivery', line, index));
  for (const [key, { line, index }] of was) if (!now.has(key)) out.push(dropped('delivery', line, index));
}

/** 到货单的明细变化：对上的行比品名、长宽（解除了采购关联的写“对应采购单”），新增、删掉的各写一句 */
function arrivalLineChanges(before: Side, after: Side, out: EventChange[]) {
  const push = (label: string, a: string, b: string) => {
    if (a !== b) out.push({ label, before: a, after: b });
  };
  const was = keyed('arrival', before),
    now = keyed('arrival', after);
  // 解除采购关联的写成这一行的变化（对应采购单从…改成…），不拆成“新增”“删掉了”两行
  const { pairOf, removed } = pairMoved(was, now);
  const purchaseOf = (line: Line) => text(line.purchaseNumber ?? line.purchaseId);
  for (const [key, { line, index }] of now) {
    const old = was.get(key) ?? pairOf.get(index);
    if (!old) {
      out.push(added('arrival', line, index));
      continue;
    }
    const name = lineName(line, index);
    if (!was.has(key)) push(name + '：对应采购单', purchaseOf(old.line), purchaseOf(line));
    const oldFields = new Map(arrivalLineFields(old.line));
    for (const [label, value] of arrivalLineFields(line)) push(name + '：' + label, oldFields.get(label) ?? '—', value);
  }
  for (const { line, index } of removed) out.push(dropped('arrival', line, index));
}

export function eventChanges(
  kind: string,
  before: Side,
  after: Side,
  options: { compareAmount?: boolean } = {},
): EventChange[] {
  if (kind !== 'delivery' && kind !== 'arrival') return [];
  const out: EventChange[] = [];
  const push = (label: string, a: string, b: string) => {
    if (a !== b) out.push({ label, before: a, after: b });
  };
  const party = (doc: Side['doc']) =>
    text(kind === 'delivery' ? (doc.customerName ?? doc.customerId) : (doc.supplierName ?? doc.supplierId));
  push(kind === 'delivery' ? '客户' : '供应商', party(before.doc), party(after.doc));
  push('日期', text(before.date), text(after.date));
  // 单据已撤销、被替代时没有金额（不是金额被清空），不比。
  // 一边补过税率、另一边还缺税率时，记进往来的金额口径不同（含税金额对没税率的理论金额），直接比会像少了一截税：
  // 两边都按理论金额（不含税）比，项目名写明口径
  if (options.compareAmount !== false) {
    if (!!before.taxPending !== !!after.taxPending && before.theoretical != null && after.theoretical != null)
      push('理论金额（不含税，一边还缺税率）', cents(before.theoretical), cents(after.theoretical));
    else push('金额', cents(before.amount), cents(after.amount));
  }
  if (kind === 'delivery') deliveryLineChanges(before, after, out);
  else arrivalLineChanges(before, after, out);
  return out;
}

/** 往前找原来那张凭证依据的那条事件：从 previousId 起沿着“上一条”找最近一条出过凭证的；都没有就是 previousId 这条 */
function basisEvent(db: DatabaseSync, previousId: number | null | undefined) {
  let basis: ReturnType<typeof findEvent> = undefined;
  let cursor = previousId;
  for (let depth = 0; cursor != null && depth < PREVIOUS_CHAIN_MAX; depth++) {
    const found = findEvent(db, cursor);
    if (!found) break;
    basis ??= found;
    if (found.voucher_id != null) return found;
    cursor = found.previous_event_id;
  }
  return basis;
}
const findEvent = (db: DatabaseSync, id: number) => one(db, rows.fin_events, 'SELECT * FROM fin_events WHERE id=?', id);

/**
 * 某条事件之后单据改了什么：改之前按原来那张凭证依据的内容算，从 previousId 这条起沿着“上一条”往前找最近一条出过凭证的；
 * 都没有就比 previousId 这条。
 * 金额：事件类型是冲销那一种（delivery.reversed、arrival.corrected）时，单据已撤销、被替代的没有金额（after.amount 是 null），
 * 不比，免得显示成“金额 … → —”像是金额被清空了；有效的更正单有金额（同步时记在事件的 document_cents），照样比。
 */
export function eventChangesSince(
  db: DatabaseSync,
  previousId: number | null | undefined,
  kind: string,
  eventType: string,
  after: Side,
) {
  const basis = basisEvent(db, previousId);
  if (!basis) return [];
  return eventChanges(
    kind,
    { doc: readSnapshot(basis).doc ?? {}, date: basis.date, amount: basis.amount_cents, ...taxBasis(basis) },
    after,
    { compareAmount: after.amount != null || !/\.(reversed|corrected)$/.test(eventType) },
  );
}
