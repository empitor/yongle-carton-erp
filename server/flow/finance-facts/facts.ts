/**
 * 财务从业务拿数据的只读窗口：财务只经 server/flow/index.ts 引这一个对象，不调业务服务、不直接读业务表。
 * 按组分文件，每组一个文件；函数只读（第一个参数是数据库连接），只交出数据，不交出 Store、连接、服务对象。
 * 只读由检查守着：目录里一处写 SQL 都不许有（tests/module-table-owners.test.ts 的 readOnlyPaths），
 * 不碰 prepare、exec、run 这些能写的入口、读库只走 server/core 的读函数（eslint.config.js），
 * 每个函数各跑一遍库不变、回的都是数据（tests/finance-facts-parties.test.ts）。
 */
import { parties } from './parties.js';

export const financeFacts = { parties };
