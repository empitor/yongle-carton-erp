/**
 * 接口表的类型工具。一个模块一张接口表，放在 shared/<路由主人模块>/，键是“方法 地址”，值写这条接口收什么、回什么：
 *   type RecordsApi = {
 *     'GET /customers/:id': { response: Customer };
 *     'PUT /customers/:id': { body: CustomerBody; response: Customer };
 *   };
 * 服务端用 route()（server/core/http/route.ts）注册，前端用 call()（src/ui/call.ts）发，两边引同一个键：返回值、参数对不上就编译不过。
 * - 路径参数从键里推出来（:id）。query 是地址上的查询参数，body 是请求正文；不写就是不收。写接口（POST、PUT、PATCH、DELETE）必须写 body。
 * - 同一个地址按查询参数回不同形状的（withMetrics=1 回分页、不带回数组）：每种形状一个键，把定形状的参数写进键里
 *   （'GET /orders?withMetrics=1'）。服务端只注册不带问号的键，处理函数的返回值按这几个键的并集查。
 * - 响应只能是 JSON 原样来回的值（ApiJson）：不能有 Date、Map、Set、bigint、函数，时间写 ISO 字符串。
 */
/** 接口用到的请求方法（页面上报出错记录时也只收这几种） */
export const apiMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type ApiMethod = (typeof apiMethods)[number];
export type ApiKey = `${ApiMethod} /${string}`;

/** JSON 能原样来回的值。对象里可以有可选字段（序列化时去掉）。接口表里结构不定的回答写它 */
export type ApiJson =
  | string
  | number
  | boolean
  | null
  | readonly ApiJson[]
  | { readonly [key: string]: ApiJson | undefined };
/** 不收内容的写接口的正文：前端发空对象（和服务端校验用的 emptyBodySchema 的输入是同一个类型） */
export type Empty = Record<string, never>;
/** 查询参数的值：拼进地址时一律转成文字 */
export type ApiQuery = { readonly [key: string]: string | number | boolean | undefined };

type Endpoint = { query?: ApiQuery; response: ApiJson };
/** 写接口的正文：不能是 undefined（前端请求入口靠“有没有正文”分读写） */
type WriteEndpoint = Endpoint & { body: object | string | number | boolean | null };
/** 一张接口表：读接口不收正文，写接口必须有正文 */
export type ApiTable = { readonly [key: `GET /${string}`]: Endpoint } & {
  readonly [key: `${Exclude<ApiMethod, 'GET'>} /${string}`]: WriteEndpoint;
};

/** 键里的地址（不带查询参数）：'GET /orders/:id?x=1' → '/orders/:id' */
type PathOf<K> = K extends `${ApiMethod} ${infer P}` ? (P extends `${infer Base}?${string}` ? Base : P) : never;
type ParamNames<P> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
/** 键里的路径参数名：'PUT /orders/:id/lines/:line' → 'id' | 'line' */
export type ApiParamName<K> = ParamNames<PathOf<K>>;

/** 从键里取出方法和地址（地址可能带写进键里的查询参数） */
export function splitApiKey(key: string): { method: ApiMethod; path: string } {
  const method = apiMethods.find((m) => key.startsWith(m + ' /'));
  if (!method) throw new Error('接口表的键要写成“方法 /地址”：' + key);
  return { method, path: key.slice(method.length + 1) };
}
