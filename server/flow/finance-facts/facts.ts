/**
 * 财务从业务拿数据的只读窗口：财务只经 server/flow/index.ts 引这一个对象和这里导出的类型，不调业务服务、不直接读业务表。
 * 按组分文件，每组一个文件；读库的函数第一个参数是数据库连接，只交出数据，不交出 Store、连接、服务对象；
 * 不碰库的纯函数（来源原文解析成财务口径的 sources.read）也只收数据、交数据。
 * 只读由检查守着：目录里一处写 SQL 都不许有（tests/module-table-owners.test.ts 的 readOnlyPaths），
 * 不碰 prepare、exec、run 这些能写的入口、读库只走 server/core 的读函数（eslint.config.js），
 * 每个函数各跑一遍库不变、回的都是数据（tests/finance-facts-parties.test.ts）。
 */
import { orders } from './orders.js';
import { parties } from './parties.js';
import { sources, type SourceHead as Head, type SourceText as Text } from './sources.js';

export const financeFacts = { parties, sources, orders };
/** 一条来源：种类、编号、版本、状态、单据日期（sources.heads） */
export type SourceHead = Head;
/** 一条来源的原文：加上单号、更新时间、内容原文（sources.texts，交给 sources.read 解析） */
export type SourceText = Text;
