import { SERVER_BUSY_CODE, SERVER_BUSY_RETRY_SECONDS, userError } from '../../shared/core/index';
import { authChanged, freshAuthState, knownCsrf, rememberAuthState, type AuthState } from './auth-state';
import { reportPageProblem, reportingPageProblems, startProblemReports } from './problem-report';
import { parseAuthState } from './auth-state';
import { readBody, readJson, textField, trustedReply, unreadable } from './read-body';

/* 发请求、读响应：网络出错和非 JSON 响应换成中文，401 回到登录，写入带页面凭证。登录状态本身在 auth-state.ts。 */

// 页面上的失败请求、报错、出错提示上报给服务端（src/ui/problem-report.ts），用记下的页面凭证；没登录不报
startProblemReports(knownCsrf);

/** 服务重启时网关返回的错误页、空响应都不是 JSON，统一给这句话。 */
export const serviceUnavailable = '服务暂时不可用，请稍后重试。';
/** 网络断开、响应丢了时浏览器只给英文原文（Failed to fetch 等），统一换成这句话。 */
export const networkUnavailable = '连不上服务器，请检查网络后再试。';
/** 要带页面凭证的请求，本地没有登录状态时不发，直接给这句话。 */
export const signedOutMessage = '请先登录账号。';

/**
 * 发请求：网络断开、响应丢了（fetch 自己抛错）时换成中文说明，错误带 code: 'network'，
 * 仍是 TypeError，按类型判断网络错误的地方不受影响。主动停止、超时（AbortError、TimeoutError）原样抛出。
 * 只发给本站接口，服务端不做跳转：一律不跟随跳转（redirect: 'error'），带着的页面凭证不会被带到别处。
 */
export async function request(input: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, { ...init, redirect: 'error' });
  } catch (e) {
    const name = textField(e, 'name');
    if (name === 'AbortError' || name === 'TimeoutError') throw e;
    reportPageProblem({ kind: 'network', message: networkUnavailable, method: init?.method, path: input });
    throw Object.assign(new TypeError(networkUnavailable), { code: 'network', cause: e });
  }
  if (!response.ok) reportFailedResponse(input, init?.method, response);
  return response;
}
/**
 * 服务器正忙（429、代码 busy：服务端核对密码排队的人满了或等超时，什么都没办）：按 Retry-After 停一下自动再发一次，
 * 第二次还忙才把这个回答交给调用方去显示。登录、进超级管理员模式、改密码、删除确认都经过这里，期间按钮保持“正在……”。
 * wait 是停的办法（测试换成不真等的）。
 */
export async function retryWhenBusy(
  send: () => Promise<Response>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<Response> {
  const first = await send();
  if (first.status !== 429 || textField(await readJson(first.clone()), 'code') !== SERVER_BUSY_CODE) return first;
  await wait((Number(first.headers.get('Retry-After')) || SERVER_BUSY_RETRY_SECONDS) * 1000);
  return send();
}
/** 失败的请求报给服务端：读的是正文的副本，不动调用方要读的那份 */
function reportFailedResponse(path: string, method: string | undefined, response: Response) {
  if (!reportingPageProblems() || response.status === 401) return;
  void readJson(response.clone()).then((body) =>
    reportPageProblem({
      kind: 'request',
      status: response.status,
      method: method ?? 'GET',
      path,
      message: textField(body, 'message') || '服务端没有给说明',
    }),
  );
}
/** 是不是网络断开、响应丢了（request 换过的错误）。 */
export function isNetworkError(e: unknown): boolean {
  return textField(e, 'code') === 'network';
}
/** 接口失败时带上状态码和原始返回，页面可以按 code 或附带的候选继续处理。 */
export type ResponseError = Error & { status: number; code?: string; data?: unknown };

/** 接口失败时给人看的那句话：服务端给的说明；读不出正文时服务端错误（5xx）说服务暂时不可用，其他用调用方给的说明 */
function failureMessage(data: unknown, status: number, fallback: string) {
  const message = textField(data, 'message');
  if (message?.trim()) return message;
  return data === null && status >= 500 ? serviceUnavailable : fallback;
}

/** 接口失败的错误：中文说明，带上状态码、服务端给的 code 和原始返回 */
function responseError(data: unknown, status: number, fallback: string): ResponseError {
  const code = textField(data, 'code');
  return Object.assign(new Error(userError(failureMessage(data, status, fallback))), {
    status,
    ...(code !== undefined ? { code } : {}),
    ...(data && typeof data === 'object' ? { data } : {}),
  });
}

function failedResponse(response: Response, data: unknown, fallback: string) {
  if (response.status === 401) authChanged();
  return responseError(data, response.status, fallback);
}

/** 不读正文的响应（文件、事件流、语音）失败时，按 responseData 的统一方式报错；成功就原样放过 */
export async function throwIfFailed(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  const body = await readBody(response);
  throw failedResponse(response, body === unreadable ? null : body, fallback);
}

/**
 * 统一处理接口响应：先看状态码再取数据。只有 401（会话失效）才通知页面回到登录；
 * 错误说明转成中文；读不出 JSON 时，服务端错误（5xx）和空的成功响应都说服务暂时不可用，
 * 其他错误用调用方给的兜底说明。
 * 返回值的类型由调用方给（不给就是 unknown），前端不做运行时校验，见 read-body.ts 的 trustedReply。
 */
export async function responseData<T>(response: Response, fallback = '操作失败，请刷新后重试。'): Promise<T> {
  const body = await readBody(response);
  const data = body === unreadable ? null : body;
  if (!response.ok) throw failedResponse(response, data, fallback);
  // 接口可以正常返回 null（例如还没设置过的账期），只有读不出 JSON 才算服务异常
  if (body === unreadable) throw new Error(serviceUnavailable);
  return trustedReply<T>(data);
}

/** 读当前登录状态（含页面凭证）。读到的不像登录状态（网关错误页之外的怪回答）时说服务暂时不可用。 */
export async function readAuthState(): Promise<AuthState> {
  const state = parseAuthState(await responseData(await request('/api/auth/state', { cache: 'no-store' })));
  if (!state) throw new Error(serviceUnavailable);
  rememberAuthState(state);
  return state;
}

/**
 * 带页面凭证发请求。凭证用记下的登录状态，没登录就抛 signedOutMessage 这句话、不发请求。
 * 服务重启后页面凭证会换，拿旧凭证的请求被拒（403）：这时重读一次登录状态，凭证确实换了就用新的重发一次。
 * 被拒的请求没有办成，重发不会办两次。
 */
async function sendWithAuth(url: string, init: (token: string) => RequestInit): Promise<Response> {
  const auth = freshAuthState() ?? (await readAuthState());
  if (!auth.actor) throw new Error(signedOutMessage);
  const r = await retryWhenBusy(() => request(url, init(auth.csrf)));
  if (r.status !== 403) return r;
  const fresh = await readAuthState();
  if (fresh.csrf === auth.csrf) return r;
  if (!fresh.actor) throw new Error(signedOutMessage);
  return retryWhenBusy(() => request(url, init(fresh.csrf)));
}

/** 带登录凭证的接口请求（读和写都要登录）：按接口表发的 call<表>()（call.ts）经它发。 */
export async function authorizedRequest<T>(path: string, body: unknown, method: string): Promise<T> {
  const r = await sendWithAuth('/api' + path, (token) => ({
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return responseData<T>(r);
}


/**
 * AI 页面（AI 设置、提示词、AI 导入工作区）的请求：这几页有自己的页面凭证，放在请求头 X-ERP-AI-Token。
 * 不带 body 是读（不缓存、不带凭证），带 body 是 POST JSON。返回原始响应：调用方用 responseData 读，
 * 流式响应先看类型再读。
 */
export function tokenRequest(url: string, token: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return request(
    url,
    body === undefined
      ? { cache: 'no-store', ...(signal ? { signal } : {}) }
      : {
          method: 'POST',
          ...(signal ? { signal } : {}),
          headers: { 'Content-Type': 'application/json', 'X-ERP-AI-Token': token },
          body: JSON.stringify(body),
        },
  );
}

export type UploadOptions = {
  /** 页面凭证。不给就现读登录状态；连续传多份时先读一次传进来。 */
  token?: string;
  /** 凭证放在哪个请求头。AI 导入工作区用自己的凭证头 X-ERP-AI-Token。 */
  tokenHeader?: string;
  contentType?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 服务端没给说明时显示的话，比如“某某文件 上传失败”。 */
  failure?: string;
};
/**
 * 原文件直传：带页面凭证，401 回到登录，错误说明转中文，非 JSON 响应不报语法错误。
 * 上传地址不在接口表里，回答如实是 unknown：要用回答的调用方自己按结构（zod）校验。
 */
export async function uploadFile(url: string, file: Blob, options: UploadOptions = {}): Promise<unknown> {
  const init = (token: string): RequestInit => ({
    method: 'POST',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'Content-Type': options.contentType || 'application/octet-stream',
      [options.tokenHeader || 'X-ERP-Auth-Token']: token,
      ...options.headers,
    },
    body: file,
  });
  const r =
    options.token !== undefined
      ? await request(url, init(options.token))
      : await sendWithAuth(url, init);
  return responseData<unknown>(r, options.failure || '上传失败，请稍后重试。');
}
