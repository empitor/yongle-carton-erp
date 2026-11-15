import type { AiBalance, AiKeyState } from '../../shared/ai/index';
import { isNetworkError, type Tone } from '../ui/index';

/* AI 设置页的叫法：错误类别、密钥状态、余额和并发的写法，出错时给人看的一句话。 */

/** 一条结果提示：ok 为假时带上错误类别 */
export type AiMessage = { ok: boolean; message: string; code?: string };

/** 错误类别的短标签，跟服务端 server/ai/errors.ts 的类别对应。 */
export const errorLabels: Record<string, string> = {
  authentication: '密钥不对',
  quota: '余额不足',
  permission: '访问被拒',
  unreadable: '读不了',
  too_large: '太大',
  rate_limit: '太忙',
  network: '网络错误',
  timeout: '超时',
  upstream: '服务出错',
  content_filter: '被审核拦下',
  response: '返回格式不对',
  key_required: '需要填写密钥',
  stale: '配置已变化',
  busy: '正在处理',
  storage: '存储失败',
  validation: '请检查输入',
};
export const stateNames: Record<AiKeyState | 'checking', string> = {
  missing: '还没填密钥',
  saved: '已保存，还没检查',
  ok: '可以使用',
  'low-balance': '余额不足',
  invalid: '密钥不对',
  failed: '连不上',
  checking: '正在检查',
};
export const stateTone = (state: AiKeyState | 'checking'): Tone =>
  state === 'ok'
    ? 'success'
    : state === 'checking'
      ? 'info'
      : ['low-balance', 'invalid', 'failed'].includes(state)
        ? 'danger'
        : 'neutral';
export const concurrencyLabel = (n: number) => (n === 1 ? '1 个（逐个识别）' : n + ' 个');
export const currency = (b: AiBalance['balances'][number]) => (b.currency === 'USD' ? '$' : '¥');
export const money = (b: AiBalance['balances'][number]) => currency(b) + b.total;

/** 出错对象上带的错误类别（code）、说明（message）；没有或不是文字时是空串 */
const codeOf = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : '';
const messageOf = (e: unknown) =>
  typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : '';
const requestFailed = '请求失败，请稍后重试。';
/** 请求失败时给人看的一句话和类别 */
export const errorMessage = (e: unknown): AiMessage => ({
  ok: false,
  code: codeOf(e) || 'network',
  // 网断、响应丢了：request 已换成中文“连不上服务器……”；别的 TypeError 是程序出错，不露英文原文
  message: isNetworkError(e) || !(e instanceof TypeError) ? messageOf(e) || requestFailed : requestFailed,
});

/** 保存密钥没成功：密钥不对、连不上 DeepSeek 时说清楚没保存、下一步怎么办 */
export function keyFailure(e: unknown): AiMessage {
  const failure = errorMessage(e);
  return {
    ...failure,
    message:
      failure.code === 'authentication'
        ? 'DeepSeek 不认这个密钥，请检查是否复制完整。没有保存。'
        : failure.code === 'network' || failure.code === 'timeout'
          ? '连不上 DeepSeek：' + failure.message + ' 没有保存；网络恢复后再试，或在“更多”里只保存不测试。'
          : failure.message,
  };
}

/** 保存密钥成功后的说法：只保存、测试通过（带用时和余额）、密钥对但余额不足 */
export function keySaved(test: boolean, state: AiKeyState, seconds: number, balance?: AiBalance): string {
  if (!test) return '已加密保存，还没测试。';
  if (state === 'low-balance') return '密钥正确，但余额不足。已保存，充值后点“重新测试”。';
  return `已保存，测试通过（${seconds.toFixed(1)} 秒）。` + (balance?.balances[0] ? '余额 ' + money(balance.balances[0]) + '。' : '');
}
