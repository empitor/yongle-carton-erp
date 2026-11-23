/** 三家替身共用的小件：虚构凭据、读请求体、回 JSON、给文件。 */
import type http from 'node:http';
import { text } from 'node:stream/consumers';
import { z } from 'zod';

/** 假服务端认的凭据。 */
export const FAKE_APP = { appId: 'fictional-app-id', secret: 'fictional-app-secret' };
/** 下载前核对域名时假装解析到的公网地址。 */
export const FAKE_PUBLIC_IP = '203.0.114.1';
export type FakeFile = { name: string; bytes: Uint8Array; failTimes?: number };

const record = z.record(z.string(), z.unknown());
/** 取对象上的一个字段；不是对象时是 undefined */
export const field = (value: unknown, key: string): unknown => {
  const parsed = record.safeParse(value);
  return parsed.success ? parsed.data[key] : undefined;
};

/** 请求体按 JSON 对象读；空的、不是 JSON 对象的（GET 请求等）当成没有字段 */
export async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await text(req);
  try {
    const parsed = record.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    // 不是 JSON：这几家的接口都收 JSON，别的当成没有字段
    return {};
  }
}
export const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
/** 按 key 给文件；failTimes 次以内先回 500，模拟下载失败。 */
export function serveFile(res: http.ServerResponse, files: Map<string, FakeFile>, key: string) {
  const file = files.get(key);
  if (!file) return json(res, 404, { code: 234003, msg: 'not found' });
  if (file.failTimes && file.failTimes-- > 0) return json(res, 500, { msg: 'busy' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(file.bytes.byteLength),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  });
  res.end(Buffer.from(file.bytes));
}
