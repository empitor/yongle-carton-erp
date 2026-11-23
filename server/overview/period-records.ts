import { sales } from '../sales/index.js';
import { trackOrders } from '../orders/index.js';
import { z } from 'zod';
import { many, type Store } from '../core/index.js';
import { FlowService } from '../flow/index.js';

/*
 * 按日期统计时要算上的已归档记录（今日页“本月接单”、经营概况、助手的经营概况）：归档只是把办完的收起来，
 * 这段时间的统计照算；已归档的会越积越多，所以先按下单（采购）日期在 SQL 里圈出这段时间的编号，再按编号批量组装，
 * 不把全部历史读出来再筛。没归档的照旧整批读（实时的待办、待到货要用全部没归档的）。
 */

/** 日期范围（YYYY-MM-DD，两头都含；不写是不限） */
export type DateRange = { start?: string; end?: string };

const idRow = z.object({ id: z.number() });

/** 某类记录的归档编号（Store 的归档读法），写成 JSON 数组给 SQL 的 json_each(?) 用 */
export const archivedIdsJson = (store: Store, entity: string) => JSON.stringify([...store.archivedIds(entity)]);

/** 这段时间里已归档的订单或采购单编号（两张表的日期列都叫 order_date，归档登记的种类名和表名一样） */
function archivedInRange(store: Store, table: 'orders' | 'purchases', range: DateRange) {
  return many(
    store.db,
    idRow,
    `SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR order_date>=?) AND (? IS NULL OR order_date<=?)`,
    archivedIdsJson(store, table),
    range.start ?? null,
    range.start ?? null,
    range.end ?? null,
    range.end ?? null,
  ).map((r) => r.id);
}

/** 订单：current 是全部没归档的，archived 是这段时间里已归档的 */
export function periodOrders(store: Store, range: DateRange) {
  const current = sales(store).orders();
  const archived = sales(store).ordersByIds(archivedInRange(store, 'orders', range), true);
  const tracked = trackOrders(store, [...current, ...archived]);
  return { current: tracked.slice(0, current.length), archived: tracked.slice(current.length) };
}

/** 采购单：current 是全部没归档的，archived 是这段时间里已归档的 */
export function periodPurchases(store: Store, range: DateRange) {
  const views = new FlowService(store).views;
  return { current: views.purchases(), archived: views.purchases(true, archivedInRange(store, 'purchases', range)) };
}
