import { splitApiKey, type ApiKey, type ApiParamName, type ApiQuery, type ApiTable } from '../../shared/core/index';
import { authorizedRequest } from './http';

/*
 * 按接口表发请求（表的写法见 shared/core/api-table.ts）。只在各模块的 *-api.ts 里用：
 *   const records = call<RecordsApi>();
 *   export const readCustomer = (id: number) => records('GET /customers/:id', { params: { id } });
 * 路径参数、query、body 按表检查，返回值按表有类型。读和写都带页面凭证，都经 http.ts 的 authorizedRequest：
 * 本地没登录直接说 signedOutMessage（http.ts）、不发；403 时换新凭证重发一次；出错说中文、401 回登录。
 * 不做运行时校验：服务端和前端同版本发布，返回值由服务端的类型检查保证。
 */

type Part<Name extends string, T> = undefined extends T ? { [P in Name]?: T } : { [P in Name]: T };
type Own<E, Name extends string> = Name extends keyof E ? Part<Name, E[Name]> : { [P in Name]?: undefined };
type ParamsOf<K> = [ApiParamName<K>] extends [never]
  ? { params?: undefined }
  : { params: { readonly [N in ApiParamName<K>]: string | number } };
/** 一次请求要给的：路径参数、查询参数、正文 */
type CallInput<E, K> = ParamsOf<K> & Own<E, 'query'> & Own<E, 'body'>;
/** 什么都不用给的接口可以不写第二个参数 */
type CallArgs<E, K> = Partial<CallInput<E, K>> extends CallInput<E, K> ? [input?: CallInput<E, K>] : [input: CallInput<E, K>];

type Caller<A extends ApiTable> = <K extends keyof A & ApiKey>(key: K, ...input: CallArgs<A[K], K>) => Promise<A[K]['response']>;
type Sent = { params?: { readonly [name: string]: string | number }; query?: ApiQuery; body?: unknown };

export function call<A extends ApiTable>(): Caller<A> {
  return send;
}

/** 键里的地址填上路径参数，接上查询参数（键里写死的在前） */
function urlOf(path: string, input: Sent) {
  const [base, fixed] = path.split('?');
  const filled = base.replace(/:(\w+)/g, (_, name: string) => {
    const value = input.params?.[name];
    if (value === undefined) throw new Error('缺少路径参数 ' + name + '：' + path);
    return encodeURIComponent(String(value));
  });
  const query = new URLSearchParams(fixed);
  if (input.query)
    for (const [name, value] of Object.entries(input.query)) if (value !== undefined) query.set(name, String(value));
  // 不用 URLSearchParams.size：Safari 16、Chrome 107 没有它（在构建目标里），会把查询参数整段丢掉
  const text = query.toString();
  return filled + (text ? '?' + text : '');
}

/** 读接口不带正文（authorizedRequest 按“有没有正文”定 GET）；写接口的正文由接口表保证有 */
function send<R>(key: string, input: Sent = {}): Promise<R> {
  const { method, path } = splitApiKey(key);
  return authorizedRequest<R>(urlOf(path, input), method === 'GET' ? undefined : input.body, method);
}
