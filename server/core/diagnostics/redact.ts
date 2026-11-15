/**
 * 给模型和人看的诊断文字（运行日志、出错记录、页面上报、程序代码的搜索结果）在存下或交出去之前统一打码：
 * 看起来像密钥、口令、令牌、页面凭证、登录会话、验证码的内容一律换成 ***。宁可多遮，不能漏。
 */

const HIDDEN = '***';
/**
 * 名字像机密的“名 = 值”“名: 值”，值整个遮掉（含引号里的、带 Bearer 的）。
 * 短名字（key、code、sign、otp）要单独成词，免得 errcode、monkey 这类也被遮。
 */
const NAMED =
  /((?:password|passwd|passphrase|pwd|secret|token|credential|signature|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|session|csrf|salt|hash|\b(?:key|code|sign|otp)\b|密码|口令|密钥|令牌|凭证|验证码)[\w-]*["']?\s*[:=：]\s*)(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&'"}]+)/gi;
/** “密码是 xxx”“口令为 xxx”这种不带冒号等号的说法 */
const SPOKEN = /((?:密码|口令|密钥|验证码)\s*(?:是|为)\s*)\S+/g;
/** Cookie 请求头整行遮掉（每一项都可能是会话） */
const COOKIE_LINE = /(\b(?:set-)?cookie\s*[:：]\s*)[^\r\n]*/gi;
/** 请求头里的 Bearer / Basic 凭据 */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** 网址里带的账号口令：https://用户:口令@主机 */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
/** 常见的密钥前缀（DeepSeek、OpenAI 一类的 sk-，企业微信、GitHub 一类的长串） */
const PREFIXED = /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g;
/** 长串（会话令牌、页面凭证、哈希、base64 密钥、私钥正文）：字符表含 / 免得 base64 被切成短段 */
const LONG_RUN = /[A-Za-z0-9_+=/-]{32,}/g;
/** 纯字母的长串到这么长才算机密（字母数字混排的 32 位起，见 LONG_RUN） */
const LETTERS_ONLY_SECRET = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * 长串里哪些算机密：32 位以上字母数字混排，或 40 位以上大小写混排的纯字母；
 * 编号用的 UUID、全小写的路径和名字（server/core/diagnostics/request-recorder）不遮。
 */
const secretRun = (run: string) =>
  !UUID.test(run) &&
  ((/\d/.test(run) && /[A-Za-z]/.test(run)) || (run.length >= LETTERS_ONLY_SECRET && /[a-z]/.test(run) && /[A-Z]/.test(run)));

export function redactSecrets(text: string): string {
  return text
    .replace(COOKIE_LINE, (_m, name: string) => name + HIDDEN)
    .replace(NAMED, (_m, name: string) => name + HIDDEN)
    .replace(SPOKEN, (_m, lead: string) => lead + HIDDEN)
    .replace(AUTH_SCHEME, (_m, scheme: string) => scheme + ' ' + HIDDEN)
    .replace(URL_CREDENTIALS, (_m, scheme: string) => scheme + HIDDEN + '@')
    .replace(PREFIXED, HIDDEN)
    .replace(LONG_RUN, (run) => (secretRun(run) ? HIDDEN : run));
}

/**
 * 读程序代码用的轻一档：只遮密钥前缀、长串和网址里的口令。代码里叫 key、token、session 的变量很多，
 * 按名字遮会把正常代码行遮成残句；读代码的范围里本来就不许有密钥，这一档只是兜一下。
 */
export function redactCodeSecrets(text: string): string {
  return text
    .replace(URL_CREDENTIALS, (_m, scheme: string) => scheme + HIDDEN + '@')
    .replace(PREFIXED, HIDDEN)
    .replace(LONG_RUN, (run) => (secretRun(run) ? HIDDEN : run));
}

/** 截到 max 个字，超了末尾标“…” */
export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** 打码再截断：存进诊断记录、交给读取方的文字都过这一道 */
export const safeText = (text: unknown, max: number) => clip(redactSecrets(String(text ?? '')), max);
