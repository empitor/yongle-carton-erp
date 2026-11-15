/**
 * 建表里反复用到的 CHECK 片段，只拼 SQL 文字。各表文件用模板字符串套进去：CHECK(${isDate('order_date')})。
 * 写法都实测过（tests/schema-constraints.test.ts），改之前先看那边的用例。
 *
 * 约定：
 * - 业务日期存 YYYY-MM-DD，会计期间存 YYYY-MM，都加格式约束。
 * - 时间戳（created_at、updated_at、at 这类）存 ISO 文本，不加格式约束。
 * - 可以为空的列写 x IS NULL OR (…)：CHECK 算出 NULL 也算通过，这样写只是让人一眼看出允许空。
 * - 枚举值在各表文件里写死，不从 shared/ 拼（基础模块只能引用 shared/core）；
 *   和各模块常量是否一致由 tests/schema-constraints.test.ts 逐个比对。
 */

/**
 * 业务日期：YYYY-MM-DD，而且真有这一天（2 月 30 日、13 月都不行）。
 * 必须写 date(x) IS x：不存在的日期 date() 得 NULL，用 = 比出来是 NULL，CHECK 会放行。
 */
export const isDate = (column: string) =>
  `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(${column}) IS ${column}`;

/** 可以不填的业务日期：只能是 NULL 或合法日期，不能是空字符串 */
export const isDateOrNull = (column: string) => `${column} IS NULL OR (${isDate(column)})`;

/** 会计期间：YYYY-MM，月份 01～12 */
export const isPeriod = (column: string) =>
  `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(${column},6,2) BETWEEN '01' AND '12'`;

/** 可以不填的会计期间：只能是 NULL 或合法期间 */
export const isPeriodOrNull = (column: string) => `${column} IS NULL OR (${isPeriod(column)})`;

/** JSON 文本，而且是对象（单据、补充资料这类） */
export const isJsonObject = (column: string) => `json_valid(${column}) AND json_type(${column})='object'`;

/** JSON 文本，而且是数组 */
export const isJsonArray = (column: string) => `json_valid(${column}) AND json_type(${column})='array'`;

/** SHA-256 的十六进制文本：64 个小写十六进制字符 */
export const isSha256 = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
