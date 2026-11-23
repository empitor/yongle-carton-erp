// 由 scripts/schema-rows.ts 按建表生成（npm run schema:dump），不要手改；tests/schema-evolution.test.ts 核对它和建表一致。
import type { z } from 'zod';
import { businessRows } from './rows/business-db.js';
import { financeRows } from './rows/finance-db.js';
import { configRows } from './rows/config-db.js';

/**
 * 每张表的行结构，按表名取（rows.customers）。别名、联表、聚合在调用处用 rows.x.pick({…}).extend({…}) 组；
 * 读库用 server/core/storage/sqlite/sql.ts 的 one、many。
 */
export const rows = { ...businessRows, ...financeRows, ...configRows };
/** 每张表一行的类型：Rows['customers'] */
export type Rows = { [K in keyof typeof rows]: z.infer<(typeof rows)[K]> };
