/** 窗口的订单一组：月度台账的“接单”（server/finance/monthly-sql.ts）按下单日期读一段时间里接的订单。 */
import type { DatabaseSync } from 'node:sqlite';
import { uncountedOrderStatuses } from '../../../shared/core/index.js';
import { many, rows } from '../../core/index.js';

const ordered = rows.orders.pick({ id: true, number: true, order_date: true, customer_name: true, total_cents: true, status: true });

/**
 * 下单日期在 from 到 to（含两头）的订单：编号、订单号、下单日期、客户名、金额（分）、状态。
 * 待确认、已取消的不算（uncountedOrderStatuses，和今日页、经营概况同一份清单），已归档的照样算。
 */
function between(db: DatabaseSync, from: string, to: string) {
  return many(
    db,
    ordered,
    `SELECT id,number,order_date,customer_name,total_cents,status FROM orders
      WHERE order_date BETWEEN ? AND ? AND status NOT IN (SELECT value FROM json_each(?)) ORDER BY id`,
    from,
    to,
    JSON.stringify(uncountedOrderStatuses),
  );
}

export const orders = { between };
