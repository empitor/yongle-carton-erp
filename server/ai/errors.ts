import type { AiFailureCode, ResponseFailureDetail } from '../../shared/ai/index.js';
/**
 * 模型响应在处理阶段被判定不可用时的已接收文本。
 * text 只包含已通过“不含密钥”检查、可安全展示给用户的部分文本；
 * 它绝不进入业务写入路径，只用于避免已生成的回答被整条丢弃。
 */
export type AiResponseNote = {
  kind: 'invalid-json' | 'truncated' | 'incomplete' | 'refusal' | 'empty' | 'protocol';
  text?: string;
};
export class AiConnectionError extends Error {
  diagnostic?: ResponseFailureDetail;
  upstreamStatus?: number;
  /** 对话请求里引用的上传文件失效了（过期、被删、不在这个账号下）：DeepSeek 报错里点名的文件编号 */
  invalidFileIds?: string[];
  constructor(
    public readonly code: AiFailureCode,
    message: string,
    public readonly status = 400,
    public responseNote?: AiResponseNote,
  ) {
    super(message);
  }
}

/** 是哪一类接口出的错：同一个状态码在上传文件、读网页时意思不同。 */
export type DeepSeekOperation =
  | 'chat'
  | 'upload'
  | 'delete'
  | 'asr'
  | 'tts'
  | 'search'
  | 'fetch'
  | 'balance';

// 文件失效、上传超限的认法借鉴 deepseek-ai/chat-demo（MIT）src/services/api/errors.ts 的 getFileErrorCode、getUploadErrorInfo，只借做法、没抄代码。
// 那个示例走 Messages 接口；Chat Completions 带文件时报错文案是否完全一样没有用真实接口核实过。
const FILE_INVALID = /file_ids do not exist or are not created under your account|file data not found for file_id|\.source\.file_id: invalid file_id/i;
const FILE_ID = /file-api-[\w-]+/g;
const FILE_COUNT_LIMIT = /User file count limit exceeded/i;
const FILE_STORAGE_LIMIT = /User storage quota exceeded/i;
/** 报错里带的上限数字（紧跟在 limit 后面的数，如“limit: 100”“limit 10.0GB”），没有就不说 */
const limitIn = (hint: string, unit: string) => {
  const m = /limit\W{0,3}(\d+(?:\.\d+)?)/i.exec(hint);
  return m ? `（上限 ${m[1]} ${unit}）` : '';
};
type MakeError = (code: AiFailureCode, message: string, httpStatus: number) => AiConnectionError;
/** 上游回的一次失败：状态码、报错里的说明、哪一类接口，make 建出带上游状态码的错 */
type UpstreamFailure = { status: number; hint: string; op: DeepSeekOperation; make: MakeError };

/** 上传接口回 400 时按原因说：文件个数、存储到了上限，或者文件读不了 */
function uploadRejected(hint: string, make: MakeError) {
  const later = '以前传上去的文件到期会自动删掉，过后再试。原件已保留。';
  if (FILE_COUNT_LIMIT.test(hint))
    return make('quota', `DeepSeek 账号下存的文件个数到了上限${limitIn(hint, '个')}，这份没传上去。${later}`, 422);
  if (FILE_STORAGE_LIMIT.test(hint))
    return make('quota', `DeepSeek 账号下存的文件总大小到了上限${limitIn(hint, 'GB')}，这份没传上去。${later}`, 422);
  const why = /too large to process/i.test(hint) ? '图片太大，处理不了' : '可能加了密码、已损坏，或者格式不支持';
  return make('unreadable', `DeepSeek 读不了这个文件：${why}。原件已保留。`, 422);
}

/** 值是带这个字段的对象 */
const hasKey = <K extends string>(value: unknown, key: K): value is Record<K, unknown> =>
  typeof value === 'object' && value !== null && key in value;
/** 上游报错正文里的 error.message，没有就是空 */
function upstreamHint(body: unknown) {
  const upstream = hasKey(body, 'error') ? body.error : null;
  return hasKey(upstream, 'message') && typeof upstream.message === 'string' ? upstream.message : '';
}

/** 账号这一层的拒绝：密钥、余额、权限 */
function accountRejected({ status, op, make }: UpstreamFailure) {
  if (status === 401)
    return make('authentication', 'DeepSeek 密钥不对或已失效，请到 设置 → API 配置 重新填写。', 422);
  if (status === 402)
    return make('quota', 'DeepSeek 账户余额不足，请到 DeepSeek 开放平台充值后重试。', 422);
  if (status === 403)
    return op === 'fetch'
      ? make('permission', '这个网页不允许读取（被 DeepSeek 的安全策略拒绝）。', 422)
      : make('permission', 'DeepSeek 拒绝了这次请求，请检查账号状态。', 422);
  return null;
}

/** 400 按接口和报错里的关键词说；说不出具体原因的 400 和 422 都算请求不合规定 */
function requestRejected({ status, hint, op, make }: UpstreamFailure) {
  if (status !== 400 && status !== 422) return null;
  if (status === 400 && op === 'upload') return uploadRejected(hint, make);
  if (status === 400 && op === 'chat' && FILE_INVALID.test(hint)) {
    // 助手对话会按点名的编号从本地原件重传一次（server/assistant/chat/model-round.ts），这句话是重传不了时给人看的
    const error = make('unreadable', '对话里引用的附件在 DeepSeek 那边已经失效（过期或被删了）。', 422);
    error.invalidFileIds = [...new Set<string>(hint.match(FILE_ID) ?? [])];
    return error;
  }
  if (status === 400 && op === 'tts')
    return make('unreadable', '这段内容读不出来（可能全是表格或代码）。', 422);
  if (status === 400 && /context|length|token|上下文|超长|too long/i.test(hint))
    return make('too_large', '内容超过模型一次能读的上限，请把文件拆小或减少附件后重试。', 422);
  if (status === 400 && /reasoning_content/i.test(hint))
    return make('validation', '思考内容没有按 DeepSeek 的规定回传（程序问题）。请把错误编号告诉管理员。', 422);
  return make('validation', 'DeepSeek 不接受这次请求（程序问题）。请把错误编号告诉管理员。', 422);
}

/** 网页打不开、超时、太大、太忙、上游出错、跳转 */
function serviceFailed({ status, op, make }: UpstreamFailure) {
  if (status === 404 && op === 'fetch')
    return make('unreadable', '网页打不开，或者没有可读的正文。', 422);
  if (status === 408) return make('timeout', '文件上传太慢，超时了。请检查网络后重试。', 504);
  if (status === 413)
    return make('too_large', '文件太大，超过 DeepSeek 的上限（图片 64 MB、文档 100 MB、语音 8 MB）。', 413);
  if (status === 429)
    return make('rate_limit', 'DeepSeek 正忙或同时请求太多，系统会自动稍后重试；还不行就过一会儿再试。', 429);
  if (status === 503)
    return make('rate_limit', 'DeepSeek 服务繁忙，系统会自动稍后重试；还不行就过一会儿再试。', 429);
  if (status === 500)
    return op === 'upload'
      ? make('upstream', 'DeepSeek 没有完整解析这个文件，请重试；还不行就换一份清晰的文件。', 502)
      : make('upstream', 'DeepSeek 服务内部出错，请稍后重试。', 502);
  if (status === 504) return make('timeout', 'DeepSeek 处理超时（文件太大或太复杂），请减小文件后重试。', 504);
  if (status >= 300 && status < 400)
    return make('upstream', 'DeepSeek 返回了跳转，为保护密钥没有跟随。请稍后重试。', 502);
  return null;
}

/**
 * DeepSeek 返回非 2xx 时给人看的话。只看状态码和错误信息里的少数关键词，
 * 不把上游正文透传出去（上游可能回显密钥或请求内容）。
 */
export function deepSeekError(status: number, body: unknown, op: DeepSeekOperation): AiConnectionError {
  const make: MakeError = (code, message, httpStatus) => {
    const error = new AiConnectionError(code, message, httpStatus);
    error.upstreamStatus = status;
    return error;
  };
  const failure = { status, hint: upstreamHint(body), op, make };
  return (
    accountRejected(failure) ??
    requestRejected(failure) ??
    serviceFailed(failure) ??
    make('upstream', `DeepSeek 返回了意外的错误（HTTP ${status}），请稍后重试。`, 502)
  );
}

/** 出错对象上某个字段转成的文字，没有或为空就是空 */
const textAt = (value: unknown, key: string) => (hasKey(value, key) && value[key] ? String(value[key]) : '');

/** 发请求时网络层抛的错（fetch 的 TypeError 带 cause）。超时、取消由调用方先判断。 */
export function networkError(error: unknown): AiConnectionError {
  if (error instanceof AiConnectionError) return error;
  const cause = hasKey(error, 'cause') ? error.cause : undefined;
  const code = textAt(cause, 'code') || textAt(error, 'code');
  if (/ENOTFOUND|EAI_AGAIN/.test(code))
    return new AiConnectionError(
      'network',
      '连不上 DeepSeek：服务器解析不了 api.deepseek.com，请检查服务器网络和 DNS。',
      502,
    );
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code))
    return new AiConnectionError('network', '和 DeepSeek 的安全连接校验失败，请检查服务器时间和网络代理。', 502);
  if (/redirect/i.test(textAt(cause, 'message')))
    return new AiConnectionError('upstream', 'DeepSeek 返回了跳转，为保护密钥没有跟随。请稍后重试。', 502);
  return new AiConnectionError('network', '连不上 DeepSeek，请检查服务器网络。', 502);
}

/** 返回 2xx 但内容不是约定的样子 */
export function badResponse(): never {
  throw new AiConnectionError('response', 'DeepSeek 返回的内容格式不对，没有采用。', 502);
}
export const cancelledError = () => new AiConnectionError('busy', '已取消。', 409);
/** idle：流式回复这么久没有新内容（空闲超时）；否则是整次请求的时限 */
export const timeoutError = (ms: number, idle = false) =>
  new AiConnectionError(
    'timeout',
    idle
      ? `DeepSeek 超过 ${Math.round(ms / 1000)} 秒没有新内容，已断开，没有采用不完整的结果。`
      : `等 DeepSeek 回复超过 ${Math.round(ms / 1000)} 秒，已停止，没有采用不完整的结果。`,
    504,
  );
export const keyRequiredError = () =>
  new AiConnectionError('key_required', '还没填写 DeepSeek 密钥。请管理员到 设置 → API 配置 填写。', 400);
