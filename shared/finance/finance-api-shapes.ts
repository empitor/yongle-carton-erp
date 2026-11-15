// 归前端财务-甲。财务接口表各块（finance-api-*.ts，总表 finance-api.ts）共用的写法。
import type { ApiJson } from '../core/index.js';

/** 一个 JSON 对象：一条记录、一页列表、一张报表、一次办完的结果（结构还没写准的先这样写） */
export type Data = { readonly [key: string]: ApiJson | undefined };
/** 规则还在服务端的正文：页面填的内容加防重复的请求号 requestId */
export type Body = Data;
/** 不带查询参数的读 */
export type Read = { response: Data };

/** 财务列表的翻页参数（服务端 server/finance/query.ts 的 pageSql：第几页、每页几条（最多 200）、先新还是先旧） */
export type Paging = { page?: number; pageSize?: number; sort?: 'newest' | 'recent' | 'oldest' };
/** 财务列表的一页：这页的行、第几页、每页几条、筛出来一共几条 */
export type Page<Row> = { rows: Row[]; page: number; pageSize: number; filteredRecords: number };
