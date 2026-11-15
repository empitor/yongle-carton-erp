/**
 * `https.request` 的替身（机器人下载的固定 IP 传输、公网 DNS 用）：记下每次请求的参数，
 * 回答由本地假连接按 HTTP 报文给出，不连网、不走 TLS。
 */
import http, { type IncomingMessage } from 'node:http';
import type https from 'node:https';
import { Duplex } from 'node:stream';

export type FakeReply = {
  status?: number;
  location?: string;
  /** 回答正文；不给是“虚构文件” */
  body?: Buffer;
  /** 响应头里的 content-length（可以和正文对不上，用来试大小限制） */
  length?: string;
  /** 连接出错（证书校验失败、连不上这类） */
  error?: Error;
  /** 一直不回答（试超时） */
  hang?: boolean;
  /** 正文先到、结尾晚一拍（像大回答分几次到）：读的一方读到一半断开，就收不到结尾 */
  lateEnd?: boolean;
};
type Done = (res: IncomingMessage) => void;

/** 一条假连接：收到请求就回一段 HTTP 报文后关掉 */
function replySocket(reply: FakeReply) {
  const body = reply.body ?? Buffer.from('虚构文件');
  const head = [
    `HTTP/1.1 ${reply.status ?? 200} Fake`,
    'content-disposition: attachment; filename="fictional.bin"',
    'connection: close',
    ...(reply.location ? ['location: ' + reply.location] : []),
    ...(reply.length ? ['content-length: ' + reply.length] : []),
  ];
  let answered = false;
  const socket = new Duplex({
    read() {
      // 回答在收到请求时一次推进去，这里不用另外读
    },
    write(_chunk, _encoding, next) {
      if (reply.error) {
        socket.destroy(reply.error);
        return;
      }
      if (!answered && !reply.hang) {
        answered = true;
        socket.push(Buffer.concat([Buffer.from(head.join('\r\n') + '\r\n\r\n'), body]));
        if (reply.lateEnd) setImmediate(() => socket.push(null));
        else socket.push(null);
      }
      next();
    },
  });
  return socket;
}

/** 按顺序回 replies（用完了回默认的 200）；calls 是每次请求的参数 */
export function fakeHttpsRequest(replies: FakeReply[]) {
  const calls: https.RequestOptions[] = [];
  function request(options: string | URL | https.RequestOptions, done?: Done): http.ClientRequest;
  function request(url: string | URL, options: https.RequestOptions, done?: Done): http.ClientRequest;
  function request(first: string | URL | https.RequestOptions, second?: https.RequestOptions | Done, third?: Done) {
    if (typeof first === 'string' || first instanceof URL) throw new Error('替身只认 request(options, done) 的写法');
    calls.push(first);
    const socket = replySocket(replies.shift() ?? {});
    const options = { method: first.method, path: first.path, headers: first.headers, createConnection: () => socket };
    return http.request(options, typeof second === 'function' ? second : third);
  }
  return { calls, request };
}
