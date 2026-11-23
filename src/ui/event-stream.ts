import { SseParser } from '../../shared/core/index';
import { textField, trustedReply } from './read-body';

/** 流断了时抛的错：和 request（http.ts）换过的网络错误一样带 code: 'network'，isNetworkError 认得出 */
const lostError = (message: string) => Object.assign(new TypeError(message), { code: 'network' });

/**
 * 读服务器推来的事件流（服务端写法在 server/core/http/stream.ts），返回 result 事件的内容。
 * 一条事件跨几块到达也能拼起来；心跳（`:` 开头的注释行）跳过；每条事件的 data 按 JSON 解析后交给 onEvent（如实是 unknown，
 * 调用方按事件种类自己认）。result 的类型由调用方给，前端不做运行时校验（read-body.ts 的 trustedReply）。
 * error 事件交给 onEvent 之后抛出服务器给的说明（带 code）。响应里没有正文、读到一半网断了、读完没收到 result，
 * 都按调用方给的 interrupted 说（服务器可能已经办了，说法由调用方定）；主动停止、超时原样抛出。
 */
export async function readEventStream<T>(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
  interrupted: string,
): Promise<T> {
  if (!response.body) throw lostError(interrupted);
  // 放在对象里：result 在解析回调里才填，直接用变量的话类型检查会以为它一直是 null
  const received: { result?: { value: unknown } } = {};
  const parser = new SseParser(({ event, data }) => {
    const value: unknown = JSON.parse(data);
    onEvent(event, value);
    if (event === 'error')
      throw Object.assign(new Error(textField(value, 'message') || interrupted), { code: errorCode(value) });
    if (event === 'result') received.result = { value };
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((e: unknown) => {
        // 网断了浏览器只给英文原文
        const name = textField(e, 'name');
        if (name === 'AbortError' || name === 'TimeoutError') throw e;
        throw lostError(interrupted);
      });
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {
      // 已经在抛出读流的错误，取消读取再失败（流已经断了）没有更多可说的，交出的仍是原来那个错误
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!received.result) throw lostError(interrupted);
  return trustedReply<T>(received.result.value);
}

/** error 事件带的错误码：原样带上服务器给的（通常是文字），没给是 undefined */
function errorCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'code') : undefined;
}
