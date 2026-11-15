import type { Store } from './db.js';
import { rows } from './schema/rows.js';
import { one } from './sql.js';

const lastRow = rows.number_sequences.pick({ last: true });

/**
 * 按天的流水号计数（number_sequences）：scope 是号段名加日期（例如 DG-20261112），last 是这个号段已经发到几号。
 * 表归基础，别的模块取号都调这里，不直接写这张表。初始化（清空业务数据）不清这张表，单号不回头。
 * “看”和“占”分开：要先把号印出来、过后才落库的（订货单号印在导出文件上），预览只看不占，落库时再占。
 */

/** 这个号段下一个号是几（只看不占，预览用） */
export function peekSequence(store: Store, scope: string) {
  const row = one(store.db, lastRow, 'SELECT last FROM number_sequences WHERE scope=?', scope);
  return (row ? row.last : 0) + 1;
}

/** 占一个号并返回。要在调用方的事务里调：事务退回，号也退回 */
export function takeSequence(store: Store, scope: string) {
  const row = one(
    store.db,
    lastRow,
    'INSERT INTO number_sequences(scope,last,updated_at) VALUES(?,1,?) ON CONFLICT(scope) DO UPDATE SET last=last+1,updated_at=excluded.updated_at RETURNING last',
    scope,
    new Date().toISOString(),
  );
  // 插入或加一总会返回这一行；没返回说明 SQL 写错了
  if (!row) throw new Error('取号没有返回号码：' + scope);
  return row.last;
}
