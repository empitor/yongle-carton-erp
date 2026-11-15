/*
 * 读响应正文。登录状态（auth-state.ts）和发请求（http.ts）都要用，放在它们下面一层，两边不互相引。
 */

export const unreadable = Symbol('unreadable');

/** 读响应正文；空响应、网关错误页、纯文字读不出 JSON 时返回 unreadable，和接口正常返回的 null 区分开。 */
export async function readBody(response: Response): Promise<unknown> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    // 正文读到一半连接断了：和读不出 JSON 一样交给调用方按 unreadable 说
    return unreadable;
  }
  if (!text.trim()) return unreadable;
  try {
    return JSON.parse(text);
  } catch {
    // 网关错误页、纯文字不是 JSON：按 unreadable 交回，调用方给中文说明
    return unreadable;
  }
}

/** 读响应里的 JSON；网关错误页、空响应、纯文字（如 403 Forbidden）读不出来时返回 null，不抛语法错误。 */
export async function readJson(response: Response): Promise<unknown> {
  const body = await readBody(response);
  return body === unreadable ? null : body;
}

/** 正文里某个字段的文字；正文不是对象、没有这个字段或不是文字时没有。 */
export function textField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value: unknown = Reflect.get(body, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 把接口回答当成调用方说的类型。前后端同版本发布，回答的形状由服务端按接口表做类型检查保证，前端不逐个校验（call.ts 开头）。
 * 前端只有这一处把读出来的 unknown 当成具体类型（responseData、readEventStream 用它）；不从 src/ui 导出，
 * 页面经 call<表>() 拿有类型的回答。
 */
export function trustedReply<T>(body: unknown): T;
export function trustedReply(body: unknown): unknown {
  return body;
}
