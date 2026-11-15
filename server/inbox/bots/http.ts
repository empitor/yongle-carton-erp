/**
 * 飞书、钉钉共用：向官方的固定地址发 JSON 请求，和访问令牌的缓存。
 * 地址都写死在各家文件里，不接收消息里带来的地址（那种走 media.ts 的下载检查）。
 */
import { BotFailure, jsonText, type BotCredentials, type ProtocolDeps } from './protocol.js';

const TIMEOUT_MS = 15_000;
/** 令牌到期前多久换新（5 分钟）：钉钉官方 SDK 提前 5 分钟，飞书剩不到 30 分钟时会给新的。 */
const RENEW_BEFORE_MS = 300_000;
/** 对方没说令牌多久过期时按两小时算（两家文档写的有效期都是 7200 秒） */
export const TOKEN_DEFAULT_SECONDS = 7200;

/**
 * POST 一段 JSON，返回状态码和解析后的内容（不是 JSON 就是 null；内容是外来的，各家用 zod 认）。
 * 不跟跳转：请求体里有 Secret，回复只该发到官方地址，跳到哪里都不再发一遍。
 * 连不上、超时、被跳转都抛中文的 BotFailure，英文原文不给人看。
 */
export async function postJson(
  url: string,
  body: unknown,
  deps: ProtocolDeps,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  let status: number, text: string;
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch {
    throw new BotFailure('网络不通或对方没有回应');
  }
  return { status, data: jsonText(text) ?? null };
}

/** 访问令牌缓存：同一套凭据到期前复用，换了凭据或快到期就重新要；同时来的几次只要一回。 */
export class TokenCache {
  private key = '';
  private token = '';
  private expiresAt = 0;
  private pending: Promise<string> | null = null;
  constructor(
    private request: (credentials: BotCredentials) => Promise<{ token: string; expiresInSeconds: number }>,
    private now: () => number = Date.now,
  ) {}
  get(credentials: BotCredentials) {
    const key = credentials.appId + '\n' + credentials.secret;
    if (key !== this.key) {
      this.key = key;
      this.token = '';
      this.pending = null;
    }
    if (this.token && this.now() < this.expiresAt) return Promise.resolve(this.token);
    if (this.pending) return this.pending;
    const pending: Promise<string> = this.request(credentials)
      .then(({ token, expiresInSeconds }) => {
        if (this.key === key) {
          this.token = token;
          this.expiresAt = this.now() + expiresInSeconds * 1000 - RENEW_BEFORE_MS;
        }
        return token;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
}
