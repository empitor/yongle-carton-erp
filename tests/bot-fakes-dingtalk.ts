/**
 * 钉钉 Stream 模式的本机假服务端（bot-fakes.ts 装进同一个 HTTP 服务）：换 ticket、换令牌、换下载地址、
 * 给文件、收会话回复，WebSocket 上推机器人消息和系统 ping、disconnect。凭据、令牌都是虚构的。
 */
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WebSocket as NodeWebSocket } from 'ws';
import { FAKE_APP, field, json, readBody, serveFile, type FakeFile } from './bot-fakes-http.js';

const DINGTALK_TOKEN = 'fictional-ding-token';
export const DINGTALK_TOPIC = '/v1.0/im/bot/messages/get';
const MEDIA = '/media/dingtalk/';

/** 客户端发来的回包：状态码、回给哪条消息、数据（JSON 文本） */
const ackSchema = z.looseObject({ code: z.unknown().optional(), headers: z.unknown().optional(), data: z.string().optional() });
type DingtalkAck = z.output<typeof ackSchema>;

export type DingtalkFake = ReturnType<typeof dingtalkFake>;

/** 各地址改的假服务端状态 */
type RouteState = { tickets: Set<string>; registrations: Record<string, unknown>[]; registerFailures: number[]; downloads: number };
type Answer = { status: number; body: unknown };
type Route = (fake: RouteState, req: http.IncomingMessage, body: Record<string, unknown>, files: Map<string, FakeFile>) => Answer;

/** 换 ticket：排了失败就先回失败；凭据对才发 ticket */
const openConnection: Route = (fake, _req, body) => {
  fake.registrations.push(body);
  const failure = fake.registerFailures.shift();
  if (failure) return { status: failure, body: { code: 'Throttling', message: 'fictional failure' } };
  if (body.clientId !== FAKE_APP.appId || body.clientSecret !== FAKE_APP.secret)
    return { status: 401, body: { code: 'InvalidAuthentication', message: 'fictional auth failure' } };
  const ticket = randomUUID();
  fake.tickets.add(ticket);
  return { status: 200, body: { endpoint: 'wss://fake-dingtalk.invalid/connect', ticket } };
};
const accessToken: Route = (_fake, _req, body) =>
  body.appKey !== FAKE_APP.appId || body.appSecret !== FAKE_APP.secret
    ? { status: 400, body: { code: 'invalidClient' } }
    : { status: 200, body: { accessToken: DINGTALK_TOKEN, expireIn: 7200 } };
/** 换下载地址；测试用 private- 开头的下载码模拟“给的地址在内网” */
const downloadUrl: Route = (fake, req, body, files) => {
  if (req.headers['x-acs-dingtalk-access-token'] !== DINGTALK_TOKEN) return { status: 401, body: { code: 'InvalidAuthentication' } };
  fake.downloads++;
  const code = String(body.downloadCode || '');
  if (code.startsWith('private-')) return { status: 200, body: { downloadUrl: 'https://10.0.0.1/' + code } };
  if (!files.has(code)) return { status: 400, body: { code: 'unknownDownloadCode' } };
  return { status: 200, body: { downloadUrl: 'https://fake-media.invalid/dingtalk/' + encodeURIComponent(code) } };
};
const routes = new Map<string, Route>([
  ['/dingtalk-api/v1.0/gateway/connections/open', openConnection],
  ['/dingtalk-api/v1.0/oauth2/accessToken', accessToken],
  ['/dingtalk-api/v1.0/robot/messageFiles/download', downloadUrl],
]);

export function dingtalkFake(base: string) {
  const fake = {
    tickets: new Set<string>(),
    sockets: [] as NodeWebSocket[],
    /** 客户端发来的帧（回包）。 */
    frames: [] as DingtalkAck[],
    /** 换 ticket 时收到的请求体。 */
    registrations: [] as Record<string, unknown>[],
    /** 接下来几次换 ticket 依次回这些 HTTP 状态（模拟限流、服务端出错），用完照常。 */
    registerFailures: [] as number[],
    replies: [] as { session: string; text: string }[],
    downloads: 0,
    /** 收到客户端 WebSocket 自带的 ping 几次。 */
    pings: 0,
    base,
    acceptTicket(ticket: string | null) {
      if (!ticket || !fake.tickets.has(ticket)) return false;
      fake.tickets.delete(ticket); // 一张 ticket 只能连一次
      return true;
    },
    socket(ws: NodeWebSocket) {
      fake.sockets.push(ws);
      ws.on('message', (raw) => fake.frames.push(ackSchema.parse(JSON.parse(String(raw)))));
      ws.on('ping', () => fake.pings++);
    },
    send(frame: unknown) {
      const socket = fake.sockets.at(-1);
      if (!socket) throw new Error('钉钉假服务端还没有连接');
      socket.send(JSON.stringify(frame));
    },
    /** 推一条机器人消息，返回这一帧的 messageId。 */
    push(message: Record<string, unknown>) {
      const messageId = 'fictional-stream-' + randomUUID();
      fake.send({
        specVersion: '1.0',
        type: 'CALLBACK',
        headers: { topic: DINGTALK_TOPIC, messageId, contentType: 'application/json', time: String(Date.now()), appId: 'fictional' },
        data: JSON.stringify(message),
      });
      return messageId;
    },
    ping(opaque: string) {
      fake.send({ specVersion: '1.0', type: 'SYSTEM', headers: { topic: 'ping', messageId: randomUUID(), contentType: 'application/json' }, data: JSON.stringify({ opaque }) });
    },
    disconnect() {
      fake.send({ specVersion: '1.0', type: 'SYSTEM', headers: { topic: 'disconnect', messageId: randomUUID(), contentType: 'application/json' }, data: JSON.stringify({ reason: 'fictional' }) });
    },
    async http(req: http.IncomingMessage, res: http.ServerResponse, url: URL, files: Map<string, FakeFile>) {
      const path = url.pathname;
      if (path.startsWith(MEDIA)) return serveFile(res, files, decodeURIComponent(path.slice(MEDIA.length)));
      const body = await readBody(req);
      const route = routes.get(path);
      if (route) {
        const answer = route(fake, req, body, files);
        return json(res, answer.status, answer.body);
      }
      if (path === '/dingtalk-oapi/robot/sendBySession') {
        fake.replies.push({ session: String(url.searchParams.get('session')), text: String(field(body.text, 'content') ?? '') });
        return json(res, 200, { errcode: 0 });
      }
      json(res, 404, { message: 'fake: no route ' + path });
    },
  };
  return fake;
}
