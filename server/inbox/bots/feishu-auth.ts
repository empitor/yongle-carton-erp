/**
 * 飞书开放接口里机器人要用的两样：用 App ID、App Secret 换长连接地址（连不上、被拒怎么分），和租户访问令牌。
 * 回答是外来数据，用 zod 认；对方的原文多是英文，不给人看，只留数字错误码。
 */
import { z } from 'zod';
import { TOKEN_DEFAULT_SECONDS, TokenCache, postJson } from './http.js';
import { BotAuthError, BotFailure, type BotCredentials, type ProtocolDeps } from './protocol.js';

export const FEISHU_API = 'https://open.feishu.cn';
/** 服务端没给心跳间隔时用官方 SDK 的默认值。 */
export const DEFAULT_PING_MS = 120_000;
// 换连接地址时怎么判断（照官方 Node SDK ws-client/index.ts 的 pullConnectConfig 和 enum.ts）：错误码 1000040343
// （internal_error）重试，别的非 0 码都当客户端错误、停下等人处理。官方两份 SDK 对错误码 1（system_busy）的做法不一样，
// 这里按暂时错误重试。另外按暂时问题退避：HTTP 429、5xx，频率限制 99991400，网络不通、超时（http.ts 抛的 BotFailure）
const SYSTEM_BUSY = 1;
const INTERNAL_ERROR = 1000040343;
const RATE_LIMITED = 99991400;
const RETRY_CODES = new Set([SYSTEM_BUSY, INTERNAL_ERROR, RATE_LIMITED]);
/** 被拒时给人看的提示：这几个码各有说法，认不出的叫人查凭据和后台配置。 */
const rejectedHints: Record<number, string> = {
  403: '飞书拒绝连接（错误码 403）：请检查 App ID、App Secret，并确认后台开了机器人能力和长连接。',
  514: '飞书拒绝连接（错误码 514）：请检查 App ID、App Secret，并确认后台开了机器人能力和长连接。',
  1000040350: '这个飞书应用的长连接已经开满了（错误码 1000040350），请先断开别处的连接。',
};
/** 开放接口回答里的错误码（不是数字就是没有） */
const codeReply = z.object({ code: z.number() });
const codeOf = (data: unknown) => {
  const parsed = codeReply.safeParse(data);
  return parsed.success ? parsed.data.code : null;
};
const tokenReply = z.object({ code: z.literal(0), tenant_access_token: z.string().min(1), expire: z.unknown().optional() });
const endpointReply = z.object({
  data: z.object({
    URL: z.string(),
    ClientConfig: z.object({ PingInterval: z.unknown().optional() }).optional().catch(undefined),
  }),
});
/** 用凭据换长连接地址和心跳间隔；暂时连不上抛 BotFailure（退避重试），被拒抛 BotAuthError */
export async function endpointOf(credentials: BotCredentials, deps: ProtocolDeps) {
  const { status, data } = await postJson(
    FEISHU_API + '/callback/ws/endpoint',
    { AppID: credentials.appId, AppSecret: credentials.secret },
    deps,
    { locale: 'zh' },
  );
  // 对方的原文多是英文，不给人看，只留数字错误码
  const code = codeOf(data);
  // 没有错误码可判断的（回的不是 JSON）也当暂时问题
  if (status === 429 || status >= 500 || code === null || RETRY_CODES.has(code))
    throw new BotFailure('飞书暂时连不上（错误码 ' + (code ?? status) + '），正在重试');
  if (code !== 0)
    throw new BotAuthError(
      rejectedHints[code] ?? '飞书拒绝连接（错误码 ' + code + '）：请检查 App ID、App Secret 和应用后台的配置。',
    );
  const endpoint = endpointReply.safeParse(data);
  const url = endpoint.success ? endpoint.data.data.URL : '';
  if (!url.startsWith('wss://')) throw new BotFailure('飞书给的连接地址不对，正在重试');
  const pingSeconds = endpoint.success ? Number(endpoint.data.data.ClientConfig?.PingInterval) : NaN;
  return {
    url,
    serviceId: Number(new URL(url).searchParams.get('service_id')) || 0,
    pingMs: pingSeconds * 1000 || DEFAULT_PING_MS,
  };
}

/** 租户访问令牌：下载文件、回复都要 */
export function tenantTokens(deps: ProtocolDeps) {
  return new TokenCache(async (credentials) => {
    const { data } = await postJson(
      FEISHU_API + '/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: credentials.appId, app_secret: credentials.secret },
      deps,
    );
    const reply = tokenReply.safeParse(data);
    if (!reply.success) throw new BotFailure('飞书没有给访问令牌（错误码 ' + (codeOf(data) ?? '无') + '）');
    return {
      token: reply.data.tenant_access_token,
      expiresInSeconds: Number(reply.data.expire) || TOKEN_DEFAULT_SECONDS,
    };
  });
}
