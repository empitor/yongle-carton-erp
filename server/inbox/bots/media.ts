/**
 * 机器人收文件的下载：三家都走这里。地址来自外面，只接受 https 和公网地址，
 * 每一跳都检查并固定连核过的 IP（防内网和 DNS 重绑定），边读边数，超限就断开。
 * 另有文件名解析、清洗和按扩展名定类型。
 */
import { isIP } from 'node:net';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { INBOX_MAX_FILE } from '../../../shared/import/index.js';
import { FILE_NAME_MAX } from '../../core/index.js';
import { isPublicIPv4, resolvePublicAddress } from './public-address.js';
import { BotFailure, HTTPS_PORT, type ProtocolDeps } from './protocol.js';

const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 跳转最多跟几次 */
const MAX_REDIRECTS = 3;
/** 对方没给状态码时按“网关出错”算 */
const BAD_GATEWAY = 502;
const NETWORK_FAILED = '下载失败，网络不通或超时';

/** 重试也没用的下载失败（缺下载信息、文件太大）：不再重试，原因直接告诉对方。 */
export class NoRetry extends BotFailure {}
export class FileTooLarge extends NoRetry {}

export function fileNameFromDisposition(header: string | null) {
  if (!header) return '';
  const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(header)?.[1];
  const plain = encoded || /filename="?([^";]+)"?/i.exec(header)?.[1];
  if (!plain) return '';
  try {
    return decodeURIComponent(plain.trim());
  } catch {
    return plain.trim();
  }
}

export function safeFileName(name: string, fallback: string) {
  const clean = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  // 从尾部截，扩展名还在；下游识别的文件名和上传同一个上限
  return (clean || fallback).slice(-FILE_NAME_MAX);
}

const mimeByExtension: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
};
/** 常见图片的文件头：从第几个字节起是哪两个字节（十六进制） */
const imageSignatures = [
  { at: 0, hex: 'ffd8', extension: 'jpg' },
  { at: 0, hex: '8950', extension: 'png' },
  { at: 0, hex: '4749', extension: 'gif' },
  { at: 8, hex: '5745', extension: 'webp' },
];
/** 按文件头认图片的扩展名，认不出按 jpg */
export function imageExtension(bytes: Uint8Array) {
  const head = (at: number) => Buffer.from(bytes.subarray(at, at + 2)).toString('hex');
  return imageSignatures.find((s) => head(s.at) === s.hex)?.extension ?? 'jpg';
}
export function mimeOf(name: string) {
  return mimeByExtension[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
}

/** requestImpl 只给测试替换固定 IP 的传输。 */
export type MediaDeps = ProtocolDeps & { requestImpl?: typeof https.request };
type DownloadOptions = {
  /** 最多读多少字节，默认收件箱上限；企业微信是密文，要多留补齐的 32 字节。 */
  limit?: number;
  /** 只发给第一跳的请求头（飞书的令牌）；跳到别处就不带。 */
  headers?: Record<string, string>;
};

/**
 * Node 的响应流转成标准 ReadableStream（Response 要的那种）：读的人跟不上就先停着，取消就断开。
 * Readable.toWeb 给的是 node:stream/web 的类型，和 Response 要的标准类型对不上，所以自己接一下。
 */
function webBody(res: IncomingMessage) {
  // 读的一方取消（超过大小上限）或流已经结束以后，晚到的正文、结尾、出错都不再交给流：
  // 往关了的流里写会抛“Controller is already closed”，在事件回调里没人接
  let open = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.on('data', (chunk: Buffer) => {
        if (!open) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 1) <= 0) res.pause();
      });
      res.on('end', () => {
        if (!open) return;
        open = false;
        controller.close();
      });
      res.on('error', (error) => {
        if (!open) return;
        open = false;
        controller.error(error);
      });
    },
    pull: () => {
      res.resume();
    },
    cancel: () => {
      open = false;
      res.destroy();
    },
  });
}

function pinnedMediaResponse(
  target: URL,
  address: string,
  signal: AbortSignal,
  extra: Record<string, string>,
  request = https.request,
) {
  return new Promise<Response>((resolve, reject) => {
    const req = request({
      hostname: address,
      port: target.port || HTTPS_PORT,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { ...extra, Host: target.host },
      servername: isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      agent: false,
      signal,
    }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const status = res.statusCode || BAD_GATEWAY;
      if (status === 204 || status === 205 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers }));
      } else resolve(new Response(webBody(res), { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function readLimited(response: Response, body: ReadableStream<Uint8Array>, limit: number) {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await body.cancel().catch(() => {});
    throw new FileTooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw new BotFailure(NETWORK_FAILED);
    });
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new FileTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 下载前核对域名：解析到的地址由 public-address.ts 把关，解析本身失败（英文原文）换成中文。 */
async function resolveHost(hostname: string, deps: MediaDeps) {
  try {
    return await (deps.checkHost ?? resolvePublicAddress)(hostname);
  } catch (e) {
    throw e instanceof BotFailure ? e : new BotFailure('下载地址的域名解析不了');
  }
}

/** 下载一个文件，跳转最多 3 次；返回内容和响应头里的文件名（没有就是空串）。 */
export async function downloadMedia(url: string, deps: MediaDeps, options: DownloadOptions = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!URL.canParse(current)) throw new BotFailure('下载地址不对');
    const target = new URL(current);
    if (target.protocol !== 'https:') throw new BotFailure('下载地址不是 https');
    if (target.username || target.password) throw new BotFailure('下载地址不能包含账号密码');
    const literal = target.hostname.replace(/^\[|\]$/g, '');
    const address = isIP(literal) ? literal : await resolveHost(target.hostname, deps);
    if (!isPublicIPv4(address)) throw new BotFailure('下载地址不是公网地址');
    const headers = hop === 0 ? options.headers ?? {} : {};
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await (deps.fetchImpl
      ? deps.fetchImpl(current, { redirect: 'manual', signal, headers })
      : pinnedMediaResponse(target, address, signal, headers, deps.requestImpl)
    ).catch(() => {
      throw new BotFailure(NETWORK_FAILED);
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!next || !URL.canParse(next, current)) throw new BotFailure('下载地址跳转无效');
      current = new URL(next, current).toString();
      continue;
    }
    if (!response.ok || !response.body) throw new BotFailure('下载失败，状态 ' + response.status);
    return {
      data: await readLimited(response, response.body, options.limit ?? INBOX_MAX_FILE),
      name: fileNameFromDisposition(response.headers.get('content-disposition')),
    };
  }
  throw new BotFailure('下载地址跳转次数过多');
}
