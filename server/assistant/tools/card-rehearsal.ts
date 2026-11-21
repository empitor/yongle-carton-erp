// 出卡片前在回滚点里按确认后同一个执行函数试一遍，记下这一步动了哪些业务记录、库存净变了多少（card-summary.ts 用）。
// 不按命令一个个写特例：在业务表上临时挂触发器，凡是新加、改写、删掉的行都记下来，试完连触发器一起回滚。
// 子表的行（订单明细、采购明细、订货单里的采购单、唛头、归档标记）算到它所属的那条记录上；库存流水按库存品算净变化，
// 新加、原地改写、删掉的流水都算进去（数据管理改已出库的单据会改写或删掉原来的流水）。
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import { AppError, many, rehearse } from '../../core/index.js';
import { type ToolContext } from './context.js';
import { isRecord } from '../../../shared/core/index.js';
import { flowEntityPrefix } from '../../../shared/business/index.js';

/** 一条被动到的业务记录：module 和卡片、修改历史用的模块名一致（单据用 kind） */
export type Touched = { module: string; id: number };
/** 触发器交来的一行（列名 → 值） */
type Row = Record<string, unknown>;
/** 这一行记到哪条记录上；编号照原样取出来，下面只收安全整数 */
type Owner = { module: string; id: unknown };

/** 记下改动的业务表 → 记到哪条记录上 */
const tables: Record<string, (row: Row) => Owner | null> = {
  customers: (r) => ({ module: 'customers', id: r.id }),
  suppliers: (r) => ({ module: 'suppliers', id: r.id }),
  products: (r) => ({ module: 'products', id: r.id }),
  stock_items: (r) => ({ module: 'stock_items', id: r.id }),
  orders: (r) => ({ module: 'orders', id: r.id }),
  order_lines: (r) => ({ module: 'orders', id: r.order_id }),
  purchases: (r) => ({ module: 'purchases', id: r.id }),
  purchase_lines: (r) => ({ module: 'purchases', id: r.purchase_id }),
  flow_documents: (r) => ({ module: String(r.kind), id: r.id }),
  purchase_returns: (r) => ({ module: 'purchase_return', id: r.id }),
  order_batches: (r) => ({ module: 'order_batch', id: r.id }),
  order_batch_purchases: (r) => ({ module: 'order_batch', id: r.batch_id }),
  inbox_items: (r) => ({ module: 'inbox', id: r.id }),
  product_marks: (r) => ({ module: 'products', id: r.product_id }),
  record_lifecycle: (r) => {
    const entity = String(r.entity);
    return { module: entity.startsWith(flowEntityPrefix) ? entity.slice(flowEntityPrefix.length) : entity, id: r.record_id };
  },
  stock_movements: () => null,
};

/** 盯着的业务表（tests/assistant-card-lines.test.ts 核对：业务库里每张表要么在这里，要么写明为什么不用盯） */
export const rehearsedTables = (): string[] => Object.keys(tables);

/** 触发器每次交来的：哪张表、改前、改后（json_object 拼的 JSON 文字；新加的没有改前、删掉的没有改后） */
type LogRow = { tbl: SQLOutputValue; old: SQLOutputValue; new: SQLOutputValue };
/** 每个库连接上一份记录：触发器调 card_log() 把改动交给这里（不建临时表，试完触发器跟着回滚） */
const logs = new WeakMap<DatabaseSync, { rows: LogRow[] }>();
const events: [string, string, string][] = [['INSERT', 'NULL', 'NEW'], ['UPDATE', 'OLD', 'NEW'], ['DELETE', 'OLD', 'NULL']];
const columnName = z.object({ name: z.string() });
function installLog(store: Store) {
  const db = store.db;
  let log = logs.get(db);
  if (!log) {
    const holder: { rows: LogRow[] } = { rows: [] };
    db.function('card_log', (tbl, old, next) => {
      holder.rows.push({ tbl, old, new: next });
      return null;
    });
    logs.set(db, holder);
    log = holder;
  }
  log.rows = [];
  for (const table of Object.keys(tables)) {
    const cols = many(db, columnName, 'SELECT name FROM pragma_table_info(?)', table).map((r) => r.name);
    const row = (side: string) => (side === 'NULL' ? 'NULL' : 'json_object(' + cols.map((c) => `'${c}',${side}."${c}"`).join(',') + ')');
    for (const [event, old, next] of events)
      db.exec(`CREATE TEMP TRIGGER card_${table}_${event[0]} AFTER ${event} ON main.${table} BEGIN SELECT card_log('${table}',${row(old)},${row(next)}); END;`);
  }
  return log;
}

export const PROMISE_REFUSED = '这条命令要等执行结果，不能先在回滚点里试一遍出卡片；要登记成流程类卡片（chat/workflow-cards.ts）。';

/** 触发器交来的一侧：json_object 拼的一行；没有（新加的改前、删掉的改后）是 null */
const sideOf = (v: SQLOutputValue): Row | null => {
  if (!v) return null;
  const parsed: unknown = JSON.parse(String(v));
  return isRecord(parsed) ? parsed : null;
};
const isThenable = (v: unknown) => !!v && (typeof v === 'object' || typeof v === 'function') && 'then' in v && typeof v.then === 'function';
/**
 * 试执行里拿到的是要等的结果（Promise）：拒绝。回滚之后它接着写的会真的落库、没人确认过，这类命令要登记成流程类卡片。
 * 试执行的函数自己返回的结果在这里查；包在里面调的执行函数（出卡片时的 ctx.tools.commit）由调用方拿它的返回值来查。
 */
export function refuseAsync(result: unknown) {
  if (isThenable(result)) throw new AppError(PROMISE_REFUSED, 500);
}

/** 把触发器记下的改动归到记录上（去重，按先后），库存流水按库存品算净变化 */
function collect(rows: LogRow[]) {
  const touched = new Map<string, Touched>(),
    stock = new Map<number, number>();
  for (const r of rows) {
    const before = sideOf(r.old),
      after = sideOf(r.new);
    if (r.tbl === 'stock_movements') {
      for (const [row, sign] of [[after, 1], [before, -1]] as const)
        if (row) stock.set(Number(row.item_id), (stock.get(Number(row.item_id)) ?? 0) + sign * Number(row.delta_units));
      continue;
    }
    for (const row of [before, after]) {
      const t = row && tables[String(r.tbl)](row);
      if (t && Number.isSafeInteger(Number(t.id))) touched.set(t.module + ':' + String(t.id), { module: t.module, id: Number(t.id) });
    }
  }
  return { touched: [...touched.values()], stock: [...stock].filter(([, delta]) => delta).map(([item, delta]) => ({ item, delta })) };
}

/**
 * 在回滚点里跑 job，返回它的结果、动到的记录（去重，按先后）和每个库存品的净变化（千分之一的单位，和余额同一个口径）。
 * read：试执行完、回滚之前读每条动到的记录改后的样子（删掉了就是 undefined）。
 */
export function rehearseChanges<T, R>(ctx: ToolContext, job: () => T, read: (t: Touched) => R) {
  return rehearse(ctx.store.db, () => {
    // 要等的函数（返回 Promise）不能试：回滚之后它接着写的会真的落库、没人确认过。这类命令要登记成流程类卡片
    if (job.constructor.name === 'AsyncFunction') throw new AppError(PROMISE_REFUSED, 500);
    const log = installLog(ctx.store);
    const result = job();
    refuseAsync(result);
    const { touched, stock } = collect(log.rows);
    const changes = touched.map((t) => ({ ...t, after: read(t) }));
    return { result, changes, stock };
  });
}
