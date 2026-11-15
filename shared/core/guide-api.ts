/*
 * 使用手册的接口表（服务端 server/core/user-manual.ts，“使用说明”页读它）。表的写法见 api-table.ts。
 */

/** 手册的一节：二级标题和正文（三级标题留在正文里） */
type ManualSection = { title: string; body: string };
/** 整份手册：一级标题、第一节之前的引言、按二级标题切开的各节 */
export type UserManual = { title: string; intro: string; sections: ManualSection[] };

export type GuideApi = {
  /** 登录后都能看（出纳也能看）；每次现读，回答不缓存 */
  'GET /guide': { response: UserManual };
};
