import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import { many, rows } from '../core/index.js';
import type { FlowDocument, FlowDocuments, FlowDocView, FlowKind, stockImpactSchema } from '../../shared/business/index.js';
import { MAX_STOCK_UNITS, quantityString, today } from '../../shared/core/index.js';
import { fail, type FlowCommands, type StockChange } from './base.js';
import { movement } from './confirm.js';

/*
 * 更正和撤销共用的库存部分：原单名下的流水按库存品合计、库存不够扣时的说法、更正的净影响和冲回流水的写法，
 * 外加各种单据的更正方案要实现的接口（CorrectionKind）。核心在 correction.ts。
 *
 * 冲回按“每个库存品合计一笔”写（和撤销一样），不按行：一张送货单两行出同一个成品时，按行冲回会让成品批次配不上、
 * 成本计算找不到原出库；同一事务里先记加库存的、再记减库存的，库存已发光时替代出库才不会被逐笔“不能负库存”拦下。
 */

/** 能更正的单据：到货、送货、完工（生产任务不动库存、不进财务，不进更正） */
export type CorrectableKind = Exclude<FlowKind, 'task'>;

/** 每个库存品更正前后（预览和提交结果里的样子，结构在 shared/business/flow-correction-views.ts） */
type StockImpact = z.output<typeof stockImpactSchema>;

/** 每种更正的预览输入都有的：核对时的版本号、更正原因（shared/business/flow-correction.ts） */
export type CorrectionHead = { expectedVersion: number; reason: string };

/** 提交更正的输入：请求号、预览时拿到的摘要，去掉这两项的预览输入（摘要按它算），和提交的原样（请求的摘要按它算） */
export type CorrectionCommit<I> = { requestId: string; previewDigest: string; input: I; full: object };

/** 一种更正的提交输入怎么读：commit 是预览输入加上请求号、预览摘要的结构（correctionCommit(预览输入)），核对后拆开 */
export function commitInput<T extends { requestId: string; previewDigest: string }>(commit: z.ZodType<T>) {
  return (raw: unknown) => {
    const full = commit.parse(raw);
    const { requestId, previewDigest, ...input } = full;
    return { requestId, previewDigest, input, full };
  };
}

/** 一种单据的更正方案（只读）：替代单内容、它的库存变化、预览里种类自己的内容 */
export type KindPlan<K extends CorrectableKind, V extends object, D> = {
  /** 替代单内容：按单据格式规整、明细补全；更正关系和沿用的系统字段由核心加 */
  document: FlowDocument<K>;
  /** 替代单的单据日期 */
  date: string;
  /** 替代单的库存变化（每一笔都照单据核对的规则算） */
  changes: StockChange[];
  warnings: string[];
  /** 预览里这种单据自己的内容（到货的采购影响、送货的订单影响、完工的任务影响……） */
  view: V;
  /** 要算进预览摘要的、这种单据自己的东西（关联采购单的版本等） */
  digest?: unknown;
  /** 收尾和核验要用的，种类自己留着 */
  data: D;
};

/** 写完替代单、流水、原单以后交给种类收尾的上下文 */
export type CorrectionContext<K extends CorrectableKind, V extends object, D> = {
  flow: FlowCommands;
  actor: Actor;
  at: string;
  requestId: string;
  reason: string;
  /** 原单视图（flow.get） */
  original: FlowDocView<K>;
  replacementId: number;
  replacementNumber: string;
  plan: KindPlan<K, V, D> & { stockImpact: StockImpact[] };
  movements: { replacement: string[]; reversal: string[] };
};

/**
 * 一种单据的更正：K 是单据种类，I 是预览输入，V、D 是方案里这种单据自己的预览内容和收尾要用的，R 是提交结果里这种单据多带的内容
 */
export type CorrectionKind<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object> = {
  kind: K;
  /** 单据叫法（话里用）：到货单、送货单、完工单 */
  name: string;
  /** 能更正的状态的叫法：只能更正有效的…… */
  effective: string;
  /** 预览输入（shared/business/flow-correction.ts） */
  schema: z.ZodType<I>;
  /** 提交输入（commitInput(correctionCommit(预览输入))） */
  commit(raw: unknown): CorrectionCommit<I>;
  /** 提交结果里这种单据多带的内容（finish 的 result）：同一请求号重发时按它读回上次的结果 */
  result: z.ZodType<R>;
  /** 谁能更正（业务编辑权限核心已经查过） */
  allow(actor: Actor): void;
  /** 原单按它的内容应有的库存变化，按库存品合计（千分整数）；和原单名下的流水对账 */
  stocked(stored: FlowDocument<K>): Map<number, number>;
  plan(flow: FlowCommands, original: FlowDocView<K>, stored: FlowDocument<K>, input: I, actor: Actor): KindPlan<K, V, D>;
  /** 替代单写库之前（到货：新加的行没选库存品的，对上已有的或新建） */
  prepare?(flow: FlowCommands, plan: KindPlan<K, V, D>, actor: Actor, number: string): void;
  /** 替代单沿用原单的系统字段（确认人、出库送达记录这些） */
  inherit(flow: FlowCommands, stored: FlowDocument<K>, plan: KindPlan<K, V, D>, actor: Actor, at: string): Partial<FlowDocuments[K]>;
  /** 写完单据和流水以后：种类自己的收尾和读回核验（对不上就抛错，整笔回滚），返回摘要、结果里多带的内容、审计的前后 */
  finish(ctx: CorrectionContext<K, V, D>): { summary: string; result: R; audit?: { before: unknown; after: unknown } };
};

const signed = (units: number) => (units < 0 ? '-' : '+') + quantityString(Math.abs(units));

/** 原单名下的库存流水按库存品合计（千分整数，入库为正）：撤销、更正冲回都按它，一个库存品一笔 */
export function sourceTotals(flow: FlowCommands, kind: FlowKind, id: number) {
  const totals = new Map<number, number>();
  for (const r of many(
    flow.store.db,
    rows.stock_movements.pick({ item_id: true, delta_units: true }),
    'SELECT item_id,delta_units FROM stock_movements WHERE source_kind=? AND source_id=?',
    'flow_' + kind,
    String(id),
  ))
    totals.set(r.item_id, (totals.get(r.item_id) || 0) + r.delta_units);
  return totals;
}

/** 两份按库存品的合计一样（0 和没有算一样） */
export function sameTotals(a: Map<number, number>, b: Map<number, number>) {
  return [...new Set([...a.keys(), ...b.keys()])].every((id) => (a.get(id) || 0) === (b.get(id) || 0));
}

/**
 * 库存不够扣时的说法（撤销、更正共用）：现有多少、要扣多少，再列最近用掉它的几笔出库
 * （备注开头就是单号“单号 · 用途”，手工出库的是人填的用途，不带内部编号）。action 是“撤销要扣回”“本次需扣减”这类。
 * stockId 来自流水或核对过的库存变化，库存品一定在。
 */
export function stockShortage(flow: FlowCommands, stockId: number, needUnits: number, action: string, hint = ''): never {
  const stock = flow.ops.repo.items(true, stockId)[0];
  const recent = many(
    flow.store.db,
    rows.stock_movements.pick({ notes: true }),
    "SELECT notes FROM stock_movements WHERE item_id=? AND delta_units<0 AND notes<>'' ORDER BY created_at DESC,id DESC LIMIT 5",
    stockId,
  ).map((r) => r.notes);
  return fail(
    stock.name + '库存不足：现有' + quantityString(stock.balanceUnits) + stock.unit + '，' + action + quantityString(needUnits) + stock.unit +
      '，不够扣。这批库存已经被后面的业务用掉了，请先撤销后面用掉它的单据' + hint +
      (recent.length ? '。最近的出库：' + recent.join('、') : '') + '。',
    409,
  );
}

/**
 * 更正前后每个库存品：现有、更正后、净变化（替代单的变化 − 原单的合计）。按净变化查，更正后会变负就拒；
 * 到货新加的行还没有库存品的，只说会入多少。
 */
export function netStockImpact(flow: FlowCommands, totals: Map<number, number>, changes: StockChange[]): StockImpact[] {
  const wanted = new Map<number, number>();
  for (const c of changes) if (c.stockId) wanted.set(c.stockId, (wanted.get(c.stockId) || 0) + c.deltaUnits);
  const ids = [...new Set([...totals.keys(), ...wanted.keys()])],
    items = new Map(flow.ops.repo.items(true, ids).map((i) => [i.id, i]));
  const impact: StockImpact[] = ids.map((id) => {
    const it = items.get(id);
    if (!it) return fail('原单关联的库存品已不存在，请先核对关联记录。', 409);
    const deltaUnits = (wanted.get(id) || 0) - (totals.get(id) || 0),
      afterUnits = it.balanceUnits + deltaUnits;
    if (afterUnits < 0) stockShortage(flow, id, -deltaUnits, '本次需扣减');
    if (!Number.isSafeInteger(afterUnits) || afterUnits > MAX_STOCK_UNITS) fail('更正后库存数量超限。');
    return {
      stockId: id,
      name: it.name,
      unit: it.unit,
      version: it.version,
      deltaUnits,
      delta: signed(deltaUnits),
      before: it.quantity,
      after: quantityString(afterUnits),
    };
  });
  for (const c of changes)
    if (!c.stockId && c.deltaUnits)
      impact.push({ stockId: null, name: c.name, unit: c.unit, deltaUnits: c.deltaUnits, delta: signed(c.deltaUnits), before: null, after: null });
  return impact;
}

/** 替代单的一笔变化入哪个库存品：写流水之前都已对上（到货新加的行在 prepare 里对上已有的或新建），没有是数据不对 */
const stockOf = (c: StockChange) => c.stockId ?? fail('更正明细“' + c.name + '”没有对上库存品，请刷新后重新核对。', 409);

/**
 * 写更正的流水：原单按库存品合计各冲回一笔（来源 flow_reversal、原单编号、日期是今天），替代单按方案每笔照记
 * （来源 flow_<种类>、替代单编号、替代单日期）。先记所有加库存的、再记减库存的，中间不会被扣成负数。
 */
export function writeCorrectionMovements(
  flow: FlowCommands,
  v: {
    original: { id: number; kind: FlowKind; number: string };
    replacement: { id: number; number: string; date: string };
    totals: Map<number, number>;
    changes: StockChange[];
    reason: string;
    actor: Actor;
  },
) {
  const kind = v.original.kind,
    actor = v.actor,
    replacementDoc = { kind, id: v.replacement.id, number: v.replacement.number, date: v.replacement.date },
    reversalDoc = { kind, id: v.original.id, number: v.original.number, date: today() };
  const entries = [
    ...v.changes
      .filter((c) => c.deltaUnits)
      .map((c) => ({
        replacement: true,
        delta: c.deltaUnits,
        run: () =>
          movement(flow, {
            stockId: stockOf(c),
            delta: c.deltaUnits,
            doc: replacementDoc,
            actor,
            reason: '更正 ' + v.original.number + '：' + c.reason,
            lineId: c.purchaseLineId,
            orderId: c.orderId,
          }),
      })),
    ...[...v.totals]
      .filter(([, total]) => total)
      .map(([stockId, total]) => ({
        replacement: false,
        delta: -total,
        run: () => movement(flow, { stockId, delta: -total, doc: reversalDoc, actor, reason: '更正撤销：' + v.reason, sourceKind: 'flow_reversal' }),
      })),
  ];
  const ids = { replacement: [] as string[], reversal: [] as string[] };
  for (const e of [...entries.filter((e) => e.delta > 0), ...entries.filter((e) => e.delta < 0)])
    (e.replacement ? ids.replacement : ids.reversal).push(e.run());
  return ids;
}
