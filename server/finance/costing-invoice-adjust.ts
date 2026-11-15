import { proportion } from './amounts.js';
/**
 * 成本计算里的采购到票调差和红票冲减：按到货批次（财务事件）汇总，再按到货各行原暂估的占比分摊到库存品。
 * 每次成本计算都取“凭证已记账、发票日期不晚于本月末、到货不晚于本月末、以前的成本计算还没用过的”，
 * 用过的记进成本计算明细 details.applied，不会重复。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { many, rows } from '../core/index.js';
import { financeError } from './core.js';
import { readSnapshot, type EventSnapshot, type FinanceSourceLine } from './source-snapshot.js';
import { expectRow } from './finance-rows.js';

/** 按到货批次（财务事件）汇总的到票调差和红票冲减。 */
export type InvoiceAdjustments = {
  /** 涉及的到货事件：日期和快照 */
  events: Map<number, { date: string; snapshot: EventSnapshot }>;
  /** 以前的成本计算已经调过的累计 */
  prior: Map<number, number>;
  /** 这次要调的 */
  delta: Map<number, number>;
  /** 这次要调的各笔，算完记进成本计算明细 */
  keys: Map<number, string[]>;
};

const blueFrom = `FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
    JOIN fin_vouchers v ON v.id=i.voucher_id
    JOIN fin_obligations o ON o.id=l.obligation_id JOIN fin_events e ON e.id=o.event_id
    WHERE i.direction='purchase' AND i.date<=? AND e.date<=? AND v.status='posted' AND l.estimate_cents IS NOT NULL`;
const redFrom = `FROM fin_invoices r JOIN fin_vouchers v ON v.id=r.voucher_id
    JOIN fin_invoice_links l ON l.invoice_id=r.original_id
    JOIN fin_obligations o ON o.id=l.obligation_id JOIN fin_events e ON e.id=o.event_id
    WHERE r.direction='purchase' AND r.status='red' AND r.date<=? AND e.date<=? AND v.status='posted'
    AND l.estimate_cents IS NOT NULL`;
/** 这一笔（k）已被以前的成本计算用过（SQL 条件） */
const done = `(k IN (SELECT a.value FROM fin_period_jobs j,json_each(j.details,'$.applied') a WHERE j.kind='costing'))`;

/** 一笔调差：哪一笔（b:发票:往来、r:红票:往来）、哪个到货事件、多少分 */
type AdjustmentPart = { k: string; event: number; amount: number };

/** 有还没用过的到票调差或红票冲减的到货事件 */
function pendingEvents(db: DatabaseSync, end: string) {
  return many(
    db,
    z.object({ event: z.number() }),
    `SELECT DISTINCT event FROM (
        SELECT 'b:'||l.invoice_id||':'||l.obligation_id AS k,o.event_id AS event ${blueFrom}
        UNION ALL SELECT 'r:'||r.id||':'||l.obligation_id,o.event_id ${redFrom}
      ) WHERE NOT ${done}`,
    end,
    end,
    end,
    end,
  ).map((r) => r.event);
}

/** 这些到货事件的到票调差（发票不含税额减去转回的暂估），带上是不是已被以前的成本计算用过 */
function blueParts(db: DatabaseSync, end: string, list: string) {
  return many(
    db,
    z.object({ k: z.string(), event: z.number(), amount: z.number(), applied: z.number() }),
    `SELECT k,event,amount,${done} AS applied FROM (
        SELECT 'b:'||l.invoice_id||':'||l.obligation_id AS k,o.event_id AS event,l.net_cents-l.estimate_cents AS amount
        ${blueFrom} AND o.event_id IN (SELECT value FROM json_each(?)))`,
    end,
    end,
    list,
  );
}

/** 红票一张：不含税额、原蓝票、原蓝票价税合计，和同一张蓝票编号在前的红票不含税额累计 */
const redRow = z.object({
  id: rows.fin_invoices.shape.id,
  net: rows.fin_invoices.shape.net,
  original_id: z.number(),
  gross: rows.fin_invoices.shape.gross,
  before_net: z.number(),
});
const blueLink = rows.fin_invoice_links
  .pick({ obligation_id: true, amount_cents: true, estimate_cents: true })
  .extend({ event_id: rows.fin_obligations.shape.event_id, event_date: rows.fin_events.shape.date.nullable() });

/**
 * 红票按原蓝票累计分摊：同一张蓝票编号在前的红票累计，和加上这张后的累计，各按蓝票各关联的价税金额占比分摊一次，
 * 两次的差就是这张红票落到各批到货的金额，每笔都是整数分，合计正好等于红票额，结果和确认先后无关。
 * 红票冲减应付（red-invoices.ts）也是按蓝票关联占比累计分摊，但那边分摊的是价税合计，这里是不含税额，
 * 所以两边落到同一批到货的分不一定相同，各自的合计都对。
 */
function redParts(db: DatabaseSync, end: string, events: number[]): AdjustmentPart[] {
  const wanted = new Set(events);
  const reds = many(
    db,
    redRow,
    `SELECT r.id,r.net,r.original_id,b.gross,
        coalesce((SELECT sum(x.net) FROM fin_invoices x WHERE x.original_id=r.original_id
          AND x.status='red' AND x.id<r.id),0) AS before_net
      FROM fin_invoices r JOIN fin_invoices b ON b.id=r.original_id JOIN fin_vouchers v ON v.id=r.voucher_id
      WHERE r.direction='purchase' AND r.status='red' AND r.date<=? AND v.status='posted' AND EXISTS(
        SELECT 1 FROM fin_invoice_links l JOIN fin_obligations o ON o.id=l.obligation_id
        WHERE l.invoice_id=r.original_id AND o.event_id IN (SELECT value FROM json_each(?)))
      ORDER BY r.id`,
    end,
    JSON.stringify(events),
  );
  const parts: AdjustmentPart[] = [];
  for (const r of reds) {
    const before = -r.before_net,
      after = before - r.net;
    let cumulative = 0,
      usedBefore = 0,
      usedAfter = 0;
    const links = many(
      db,
      blueLink,
      `SELECT l.obligation_id,l.amount_cents,l.estimate_cents,o.event_id,e.date AS event_date
      FROM fin_invoice_links l JOIN fin_obligations o ON o.id=l.obligation_id LEFT JOIN fin_events e ON e.id=o.event_id
      WHERE l.invoice_id=? ORDER BY l.obligation_id`,
      r.original_id,
    );
    for (const l of links) {
      cumulative += l.amount_cents;
      const upBefore = proportion(before, cumulative, r.gross),
        upAfter = proportion(after, cumulative, r.gross);
      const released = upAfter - usedAfter - (upBefore - usedBefore);
      usedBefore = upBefore;
      usedAfter = upAfter;
      if (l.estimate_cents == null || l.event_id == null || !wanted.has(l.event_id) || String(l.event_date) > end)
        continue;
      parts.push({ k: 'r:' + r.id + ':' + l.obligation_id, event: l.event_id, amount: -released });
    }
  }
  return parts;
}

/** 这几笔里已被以前的成本计算用过的 */
function appliedKeys(db: DatabaseSync, keys: string[]) {
  const found = many(
    db,
    z.object({ k: z.string() }),
    `SELECT a.value AS k FROM fin_period_jobs j,json_each(j.details,'$.applied') a
          WHERE j.kind='costing' AND a.value IN (SELECT value FROM json_each(?))`,
    JSON.stringify(keys),
  );
  return new Set(found.map((r) => r.k));
}

/**
 * 采购到票调差（发票不含税额减去转回的暂估）和采购红票冲减，按到货批次汇总。
 * 每次成本计算都取“凭证已记账、发票日期不晚于本月末、到货不晚于本月末、以前的成本计算还没用过”的：
 * 晚记账或补录的，下个月自动作为跨期调差进库存，不会漏；用过的记进成本计算明细 details.applied，不会重复。
 * prior 是以前月份已经调过的累计，分摊和不能为负的检查都按累计口径。
 */
export function invoiceAdjustments(db: DatabaseSync, end: string, only?: Set<string>): InvoiceAdjustments {
  const events = pendingEvents(db, end);
  const result: InvoiceAdjustments = { events: new Map(), prior: new Map(), delta: new Map(), keys: new Map() };
  if (!events.length) return result;
  const list = JSON.stringify(events);
  const add = (event: number, key: string, amount: number, applied: boolean) => {
    // 结账检查按那次计算时的口径重算：那次没用到的（之后才记账的）留给以后月份，这里不算
    if (!applied && only && !only.has(key)) return;
    const target = applied ? result.prior : result.delta;
    target.set(event, (target.get(event) ?? 0) + amount);
    if (!applied) result.keys.set(event, [...(result.keys.get(event) ?? []), key]);
  };
  for (const r of blueParts(db, end, list)) add(r.event, r.k, r.amount, !!r.applied);
  const parts = redParts(db, end, events);
  if (parts.length) {
    const applied = appliedKeys(db, parts.map((p) => p.k));
    for (const p of parts) add(p.event, p.k, p.amount, applied.has(p.k));
  }
  const found = many(
    db,
    rows.fin_events.pick({ id: true, date: true, snapshot: true }),
    'SELECT id,date,snapshot FROM fin_events WHERE id IN (SELECT value FROM json_each(?))',
    list,
  );
  for (const e of found) result.events.set(e.id, { date: e.date, snapshot: readSnapshot(e) });
  return result;
}

// 按到货各行原暂估不含税额的占比分摊。按累计口径：先分摊以前月份已调的累计，再分摊加上这次后的累计，
// 两次的差就是这次落到各行的金额；全部冲完时每行正好回到 0，不留分摊尾差。
/** 分摊要的快照几项：到货明细，和原暂估的不含税总额、逐行不含税额 */
type ArrivalEstimate = {
  doc?: { lines?: FinanceSourceLine[] };
  money?: { net: number; lines: { net: number }[] } | null;
};
export function spreadAdjustment(snapshot: ArrivalEstimate, prior: number, delta: number) {
  const lines = expectRow(snapshot.doc?.lines, '到货财务事件快照的明细');
  const basis = Number(snapshot.money?.net);
  if (delta && (!basis || basis + prior + delta < 0))
    financeError('到票调差缺少有效的原暂估分摊金额。');
  const share = (total: number, cumulative: number) =>
    total ? Math.sign(total) * proportion(Math.abs(total), cumulative, basis) : 0;
  let cumulative = 0,
    sharedBefore = 0,
    sharedAfter = 0;
  return lines.map((line, i) => {
    const original = Number(snapshot.money?.lines[i]?.net ?? 0);
    cumulative += original;
    const upBefore = share(prior, cumulative),
      upAfter = share(prior + delta, cumulative);
    const adjusted = upAfter - sharedAfter,
      change = adjusted - (upBefore - sharedBefore);
    sharedBefore = upBefore;
    sharedAfter = upAfter;
    return { line, amount: original + adjusted, change };
  });
}
