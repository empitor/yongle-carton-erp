import { movementTypeLabel } from './movement-filters.js';

/**
 * 成品库存按“每次完工”分批：一笔有效的完工入库就是一批，仓库不用另外登记。
 * 送货不指定发哪一批，每批“估计还剩多少”是按流水推出来的，规则（和库存结余同一个顺序：created_at，再按 seq）：
 * - 冲销流水（flow_reversal，source_id 是原单据号）和原单据在这个库存品上的流水加起来正好抵消时，成对去掉，
 *   等于这张单据没发生过：被撤销的完工不算一批，被撤销的送货等于没发过；
 * - 完工入库（flow_production 入库，且完工单还有效）算一批；成品库存里别的入库（手工入库、盘点盘盈、系统维护、
 *   配不上原单的冲销退回等）各算一条“其他入库”，不混进完工批次；
 * - 送货出库先扣“生产任务挂着同一张订单”的批次（先做的先扣），不够再按先做先发扣全部（含其他入库）；
 * - 其他出库（手工出库、盘点盘亏、系统维护、配不上原单的冲销扣回等）按先做先发扣；
 * - “先做的”按完工日期（其他入库按流水日期）从早到晚，同一天再按登记先后：流水仍按入账顺序一笔一笔处理
 *   （和库存结余一致），只是每次出库在“当时已经入库的批次”里挑先扣哪批时按日期，补录一张日期更早的完工也算先做的；
 * - 出库时前面已经扣光了（成对去掉一次撤销的完工后，当时的批次可能不够），欠着的数从之后入库的批次里先扣。
 *
 * 删单据时选了“库存不动”：被删单据的流水（连同它的冲销流水）来源被改成“系统维护”、不再挂单据号
 * （server/flow/deletion.ts），改写前的来源留在修订记录里（stock_movement_revisions.before_document）。
 * 调用方把改写前的来源放在 restored 里：配对时先按现在的来源配（和以前完全一样）；配不上，再把改写前属于
 * 同一张单据的流水算进来配，“原单流水合计 = −冲销流水”的同样成对去掉。只删了、没撤销过的完工单只有一笔入库
 * 被改成系统维护，没有冲销可配，照旧列为“其他入库 · 系统维护”。
 *
 * 撤销后重新登记：一次被撤销（已成对去掉）的完工，由“重新登记的那次完工”顶替，推算时新的那批站到被撤销那批的位置，
 * 挑先扣哪批时也按被撤销那批的完工日期算（显示的日期、单号、数量、备注都是新的那张，列表排序也按新的那张自己的日期），
 * 这样中间那些给同一订单的送货先扣的是它，不会扣到别的订单的批次上。谁顶替谁：
 *   1. 更正替代单优先：有效完工单的 correctionOf 指向这次被撤销的完工，就由它顶替；
 *   2. 同一个生产任务：被撤销的完工按入库先后，每张最多被“在它之后登记、还没顶替过别人”的最早一张同任务有效完工顶替，
 *      不管这张是在撤销之前还是之后登记的（先登记对的、再撤销错的，是常见的操作顺序）。
 *      同一任务本来就有两次正常完工、其中一次后来被撤销又没重登时，后一次会顶替前一次的位置：送货原来扣的是被撤销那批，
 *      现在扣它，等于“那批货其实是后一次做的”，合计不变。
 * 顶替只会把一笔入库往前挪，任何时刻的结余只多不少，所以各批剩余之和仍等于实际库存；没有撤销重登的情况结果不变。
 *
 * 管理员直接改了单条流水，弄得“原单数量和冲销数量对不上”时，这对流水不再成对去掉：原单那笔照常算一批或一次出库，
 * 冲销那笔算“其他入库/出库”，合计仍然对得上实际库存，只是批次显示不那么准，可以接受。
 *
 * 数量都是千分之一的整数，不用浮点。各批剩余之和与实际库存的差额放在 unmatchedUnits：
 * 按上面的规则，只有流水本身结余为负（数据库不允许）时才会不为 0，这里只兜底、不硬凑。
 */

export type BatchMovement = {
  id: string;
  /** 登记顺序（stock_movements.seq） */
  seq: number;
  createdAt: string;
  date: string;
  /** 千分之一为单位的整数 */
  delta: number;
  action: string;
  sourceKind: string;
  sourceId: string | null;
  orderId: number | null;
  /** 来源被改写成“系统维护”的流水，改写前的来源（修订记录里的 before_document）；只用于配对冲销 */
  restored?: { sourceKind: string; sourceId: string } | null;
};

/** 有效（已确认）的完工单：生产任务挂着的订单；taskId、correctionOf 用来判断它是不是顶替被撤销的那次完工 */
type BatchProduction = { orderIds: readonly number[]; taskId?: number | null; correctionOf?: string | null };

type BatchEntry = {
  /** 入库那笔流水的编号 */
  movementId: string;
  /** batch：一次有效的完工入库；other：其他入库 */
  kind: 'batch' | 'other';
  /** 完工单号（数据库编号的字符串）；其他入库没有 */
  sourceId: string | null;
  date: string;
  /** 其他入库的类型，例如“手动入库”“盘点盘盈”“系统维护” */
  label: string;
  inUnits: number;
  remainingUnits: number;
  /** 推算顺序，越大越晚 */
  position: number;
};

type StockBatchResult = {
  entries: BatchEntry[];
  /** 流水合计，也就是实际库存 */
  balanceUnits: number;
  /** 各批估计剩余之和 */
  remainingUnits: number;
  /** 实际库存 − 各批剩余之和；正常是 0 */
  unmatchedUnits: number;
};

const ordered = (a: BatchMovement, b: BatchMovement) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.seq - b.seq;

/** 流水的来源；restored 为真时，来源被改写成系统维护的流水用改写前的来源 */
const sourceOf = (m: BatchMovement, restored: boolean) =>
  restored && m.restored ? m.restored : m.sourceId != null ? { sourceKind: m.sourceKind, sourceId: m.sourceId } : null;

/** 原单据的一笔流水和它（按现在或改写前的）来源种类 */
type Original = { m: BatchMovement; kind: string };

/** 原单据的流水按单据号分组；restored 为真时算上来源被改写成系统维护、改写前属于这张单据的 */
function originalsBySource(sorted: readonly BatchMovement[], restored: boolean) {
  const map = new Map<string, Original[]>();
  for (const m of sorted) {
    const s = sourceOf(m, restored);
    if (!s || !s.sourceKind.startsWith('flow_') || s.sourceKind === 'flow_reversal') continue;
    const list = map.get(s.sourceId) || [];
    list.push({ m, kind: s.sourceKind });
    map.set(s.sourceId, list);
  }
  return map;
}

/** 冲销流水和它抵掉的原单据流水（同一库存品），返回要去掉的流水编号。 */
function pairedReversals(sorted: BatchMovement[]) {
  // actual 只按现在的来源；all 再算上改写成系统维护之前的来源
  const actual = originalsBySource(sorted, false),
    all = originalsBySource(sorted, true);
  const dropped = new Set<string>();
  const pair = (r: BatchMovement, candidates: Original[] | undefined) => {
    const originals = (candidates || []).filter(({ m }) => !dropped.has(m.id) && ordered(m, r) < 0);
    // 原单据的流水都是同一种来源（单据号在单据表里唯一），这里再按来源分一次，防止编号撞上别的来源
    const kinds = new Set(originals.map((o) => o.kind));
    if (!originals.length || kinds.size !== 1) return false;
    if (originals.reduce((n, { m }) => n + m.delta, 0) !== -r.delta) return false;
    dropped.add(r.id);
    for (const { m } of originals) dropped.add(m.id);
    return true;
  };
  for (const r of sorted) {
    // 先按现在的来源配，和以前完全一样；配不上再算上改写成系统维护之前的来源
    const now = sourceOf(r, false);
    if (now?.sourceKind === 'flow_reversal' && pair(r, actual.get(now.sourceId))) continue;
    const before = sourceOf(r, true);
    if (before?.sourceKind === 'flow_reversal') pair(r, all.get(before.sourceId));
  }
  return dropped;
}

/** 一笔完工入库：来源是完工单、数量为正、挂着单据号 */
type Completion = BatchMovement & { sourceId: string };
const isCompletion = (m: BatchMovement): m is Completion =>
  m.sourceKind === 'flow_production' && m.delta > 0 && m.sourceId != null;
/** 被撤销的完工：入库那笔在推算顺序里的位置、完工日期、生产任务 */
type Undone = { sourceId: string; at: number; date: string; taskId: number | null };
/** 有效完工的入库：那笔流水、位置、完工单 */
type Valid = { m: Completion; at: number; p: BatchProduction };

/** 被撤销的完工：入库那笔已经和冲销成对去掉（冲销那笔也去掉了）；每张单据取第一笔 */
function undoneCompletions(
  sorted: readonly BatchMovement[],
  dropped: ReadonlySet<string>,
  reversed: ReadonlyMap<string, { taskId: number | null }>,
) {
  const undone: Undone[] = [];
  sorted.forEach((m, at) => {
    if (!isCompletion(m) || !dropped.has(m.id) || undone.some((u) => u.sourceId === m.sourceId)) return;
    const task = reversed.get(m.sourceId);
    if (!task) return;
    if (!sorted.some((r) => r.sourceKind === 'flow_reversal' && r.sourceId === m.sourceId && dropped.has(r.id))) return;
    undone.push({ sourceId: m.sourceId, at, date: m.date, taskId: task.taskId });
  });
  return undone;
}

/** 有效完工的入库（每张单据取第一笔） */
function validCompletions(
  sorted: readonly BatchMovement[],
  dropped: ReadonlySet<string>,
  production: ReadonlyMap<string, BatchProduction>,
) {
  const valid: Valid[] = [];
  sorted.forEach((m, at) => {
    if (!isCompletion(m) || dropped.has(m.id) || valid.some((v) => v.m.sourceId === m.sourceId)) return;
    const p = production.get(m.sourceId);
    if (p) valid.push({ m, at, p });
  });
  return valid;
}

/**
 * 撤销后重新登记：返回“顶替的那笔入库的流水编号 → 被撤销那笔入库在推算顺序里的位置和它的完工日期”。规则见文件开头。
 * reversed：已撤销的完工单 → 它的生产任务（库里查得到的才有；删掉的单据不在里面，也就不参与顶替）。
 */
function replacements(
  sorted: BatchMovement[],
  dropped: ReadonlySet<string>,
  production: ReadonlyMap<string, BatchProduction>,
  reversed: ReadonlyMap<string, { taskId: number | null }>,
) {
  const moved = new Map<string, { at: number; date: string }>();
  if (!reversed.size) return moved;
  const undone = undoneCompletions(sorted, dropped, reversed);
  if (!undone.length) return moved;
  const valid = validCompletions(sorted, dropped, production);
  const used = new Set<string>(),
    taken = new Set<string>();
  const replace = (v: Valid, u: Undone) => {
    moved.set(v.m.id, { at: u.at, date: u.date });
    used.add(v.m.sourceId);
    taken.add(u.sourceId);
  };
  // 1. 更正替代单优先
  for (const v of valid) {
    const u = v.p.correctionOf == null ? undefined : undone.find((x) => x.sourceId === String(v.p.correctionOf));
    if (u && !taken.has(u.sourceId) && !used.has(v.m.sourceId) && u.at < v.at) replace(v, u);
  }
  // 2. 同一个生产任务：在被撤销那张之后登记、还没顶替过别人的最早一张（撤销之前、之后登记的都算）
  for (const u of undone) {
    if (taken.has(u.sourceId) || u.taskId == null) continue;
    const v = valid.find((x) => !used.has(x.m.sourceId) && x.p.taskId === u.taskId && x.at > u.at);
    if (v) replace(v, u);
  }
  return moved;
}

function otherLabel(m: BatchMovement) {
  if (m.action === 'adjust') return m.delta < 0 ? '盘点盘亏' : '盘点盘盈';
  return movementTypeLabel({ source_kind: m.sourceKind, kind: 'finished', action: m.action, delta_units: m.delta });
}

/** 已经入库的一批和它排先后用的日期（顶替的按被撤销那批的完工日期） */
type Pooled = { e: BatchEntry; date: string };

/** 按“先做的先发”的先后放进已入库的批次：日期从早到晚，同一天按登记先后 */
function enqueue(pool: Pooled[], e: BatchEntry, date: string) {
  let i = pool.length;
  while (i > 0 && (pool[i - 1].date > date || (pool[i - 1].date === date && pool[i - 1].e.position > e.position))) i--;
  pool.splice(i, 0, { e, date });
}

/** 从这批扣掉最多 need，返回还差多少 */
function take(e: BatchEntry, need: number) {
  const n = Math.min(need, e.remainingUnits);
  e.remainingUnits -= n;
  return need - n;
}

/** 一笔入库记成一批：有效完工单的完工入库是完工批次，别的是其他入库 */
function entryOf(m: BatchMovement, position: number, production: ReadonlyMap<string, BatchProduction>): BatchEntry {
  const isBatch = m.sourceKind === 'flow_production' && m.sourceId != null && production.has(m.sourceId);
  return {
    movementId: m.id,
    kind: isBatch ? 'batch' : 'other',
    sourceId: isBatch ? m.sourceId : null,
    date: m.date,
    label: isBatch ? '完工入库' : otherLabel(m),
    inUnits: m.delta,
    remainingUnits: m.delta,
    position,
  };
}

/** 一笔出库从已入库的批次里扣：送货先扣挂着同一张订单的完工批次，再按先后扣全部；返回扣不到的数 */
function spend(pool: readonly Pooled[], m: BatchMovement, orderSets: ReadonlyMap<string, ReadonlySet<number>>) {
  let need = -m.delta;
  const orderId = m.sourceKind === 'flow_delivery' ? m.orderId : null;
  if (orderId != null)
    for (const { e } of pool) {
      if (!need) break;
      if (e.kind === 'batch' && e.remainingUnits > 0 && e.sourceId != null && orderSets.get(e.sourceId)?.has(orderId))
        need = take(e, need);
    }
  for (const { e } of pool) {
    if (!need) break;
    if (e.remainingUnits > 0) need = take(e, need);
  }
  return need;
}

/**
 * 推算一个成品库存品的批次。production：有效（已确认）的完工单 → 它的生产任务挂着的订单；
 * 不在里面的完工入库（单据已撤销又没配上冲销、单据找不到）算“其他入库”。
 * reversed：已撤销的完工单 → 生产任务，判断撤销后重新登记的顶替关系用（不传就不顶替）。
 */
export function stockBatches(
  movements: readonly BatchMovement[],
  production: ReadonlyMap<string, BatchProduction>,
  reversed: ReadonlyMap<string, { taskId: number | null }> = new Map(),
): StockBatchResult {
  const sorted = [...movements].sort(ordered);
  const dropped = pairedReversals(sorted);
  // 推算顺序：顶替的那笔入库挪到被撤销那笔的位置（被撤销那笔本身已经去掉了）；position 仍是自己的登记先后
  const moved = replacements(sorted, dropped, production, reversed);
  const steps = sorted
    .map((m, position) => ({ m, position, at: moved.get(m.id)?.at ?? position }))
    .sort((a, b) => a.at - b.at || a.position - b.position);
  const entries: BatchEntry[] = [];
  const pool: Pooled[] = [];
  const orderSets = new Map<string, Set<number>>();
  for (const [id, p] of production) orderSets.set(id, new Set(p.orderIds));
  let debt = 0,
    balance = 0;
  for (const { m, position } of steps) {
    balance += m.delta;
    if (dropped.has(m.id) || !m.delta) continue;
    if (m.delta < 0) {
      debt += spend(pool, m, orderSets);
      continue;
    }
    const entry = entryOf(m, position, production);
    // 之前欠着的出库从这批先扣
    const pay = Math.min(debt, entry.remainingUnits);
    entry.remainingUnits -= pay;
    debt -= pay;
    entries.push(entry);
    enqueue(pool, entry, moved.get(m.id)?.date ?? m.date);
  }
  const remaining = entries.reduce((n, e) => n + e.remainingUnits, 0);
  return { entries, balanceUnits: balance, remainingUnits: remaining, unmatchedUnits: balance - remaining };
}

/** 接口返回给界面的一批（server/flow/stock-batches.ts 组装）。数量都已换成文字，单位成品“只”、原材料“张”。 */
export type StockBatchView = {
  key: string;
  kind: 'batch' | 'other';
  date: string;
  /** 其他入库的类型；完工批次是“完工入库” */
  label: string;
  inQuantity: string;
  remaining: string;
  remainingUnits: number;
  /** 完工单（数据库编号和单号）；其他入库为空 */
  documentId: number | null;
  number: string | null;
  /** 完工单的版本号，改批次备注时带上（POST /api/flow/:id/info）；其他入库为空 */
  documentVersion: number | null;
  taskId: number | null;
  taskNumber: string | null;
  orders: { id: number; number: string; customerName: string }[];
  /** 用料：纸板名称和实际用量（张）；材质、楞型有才给（判断这批料好坏最关键），尺寸名称里已经有，不另给 */
  materials: { stockId: number; name: string; material: string; flute: string; quantity: string }[];
  /** 完工批次是完工单上的实际操作人；其他入库是登记那笔流水的人 */
  operator: string;
  notes: string;
  /** 其他入库的原因：那笔流水的备注（出入库窗口里填的用途、盘点原因）；完工批次为空 */
  reason: string;
};

export type StockBatchesResponse = {
  stockItemId: number;
  unit: string;
  balance: string;
  /** 还有货的全部批次，新的在前 */
  open: StockBatchView[];
  /** 已发完的批次，新的在前；默认只给最近 20 个 */
  depleted: StockBatchView[];
  depletedTotal: number;
  /** 实际库存和各批剩余之和对不上的数（只），0 表示对得上 */
  unmatchedUnits: number;
  unmatched: string;
};
