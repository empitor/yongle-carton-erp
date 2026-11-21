import { z } from 'zod';

/*
 * 安卓 App 里保存文件（通道在 src/app-bridge.ts，消息约定见 docs/架构/外壳和网页.md“安卓 App 通道”）：
 * 网页发 save-file {id, name, mime, data(base64)}，App 存进手机“下载”后回 save-result {id, ok, message?}。
 * id 是本页从 1 递增的正整数，收到不在等的 id 丢掉。存好的提示 App 自己弹，这里不再说。
 * 没接通、发不出去、等太久、页面重新接通（App 那头的旧端口已关，回话不会再来）都按没存成处理（不改业务状态）；
 * 后两种 App 那头可能已经存好了，提示留余地。
 */

/** 等 App 回保存结果最多多久（存进“下载”在 App 后台做，20MB 也用不了几秒） */
export const APP_SAVE_TIMEOUT_MS = 60_000;

const resultMessage = z
  .object({ type: z.literal('save-result'), id: z.number(), ok: z.boolean(), message: z.string().optional() })
  .strict();

const NOT_CONNECTED = '安卓 App 还没准备好，文件没有保存。请稍等几秒再试。';
const NO_ANSWER = '安卓 App 没有回话，文件可能没有保存。请到手机“下载”里看一看，没有就再试一次。';
const RECONNECTED = '页面重新连上了安卓 App，没等到保存结果，文件可能没有保存。请到手机“下载”里看一看，没有就再试一次。';
const SEND_FAILED = '没能把文件交给安卓 App，文件没有保存。请再试一次。';
/** App 回了没存成、又没说原因 */
const NOT_SAVED = '文件没有保存。';
/** 转 base64 时一次转多少字节（一次转太多会超过函数参数个数的上限） */
const CHUNK = 0x8000;

/** 字节 → base64 */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let at = 0; at < view.length; at += CHUNK) text += String.fromCharCode(...view.subarray(at, at + CHUNK));
  return btoa(text);
}

type Send = (message: object) => void;
type Waiting = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * 交给 App 保存：connect 接上新端口的发送函数（还在等的一律按没存成）；save 发 save-file、等回话，
 * 最多等 timeoutMs；receive 认 save-result（不是这种消息返回 false）。
 */
export function createAppSaver(timeoutMs: number) {
  let send: Send | null = null,
    lastId = 0;
  const waiting = new Map<number, Waiting>();
  const settle = (id: number, error?: Error) => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve();
  };
  return {
    connect(next: Send) {
      for (const id of [...waiting.keys()]) settle(id, new Error(RECONNECTED));
      send = next;
    },
    async save(bytes: ArrayBuffer, type: string, filename: string): Promise<void> {
      const to = send;
      if (!to) throw new Error(NOT_CONNECTED);
      const data = toBase64(bytes),
        id = ++lastId;
      const saved = new Promise<void>((resolve, reject) => {
        waiting.set(id, { resolve, reject, timer: setTimeout(() => settle(id, new Error(NO_ANSWER)), timeoutMs) });
      });
      try {
        to({ type: 'save-file', id, name: filename, mime: type, data });
      } catch {
        // 发不出去（端口已坏、内容太大）：不用等到超时
        settle(id, new Error(SEND_FAILED));
      }
      return saved;
    },
    receive(message: unknown): boolean {
      const parsed = resultMessage.safeParse(message);
      if (!parsed.success) return false;
      const { id, ok, message: reason } = parsed.data;
      settle(id, ok ? undefined : new Error(reason || NOT_SAVED));
      return true;
    },
  };
}
