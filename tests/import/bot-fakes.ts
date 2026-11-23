/**
 * 三家机器人的本机假服务端：一个 HTTP 服务加 WebSocket，模仿握手、推消息、给文件下载、收回复。
 * 测试和界面预览（scripts/ui-check/server.mts）共用。官方地址经 fetchImpl / WebSocketImpl 换到本机，
 * 不会连到真的企业微信、飞书、钉钉。凭据、令牌都是虚构的。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WebSocketServer, WebSocket as NodeWebSocket, type RawData } from 'ws';
import { decodeFrame, encodeFrame, headerOf, type FeishuFrame } from '../../server/inbox/bots/feishu-frame.js';
import type { BotConnectionOptions } from '../../server/inbox/bots/connection.js';
import { errorMessage } from '../../shared/core/index.js';
import { dingtalkFake, type DingtalkFake } from './bot-fakes-dingtalk.js';
import { FAKE_APP, FAKE_PUBLIC_IP, field, json, readBody, serveFile, type FakeFile } from './bot-fakes-http.js';

export const FEISHU_TOKEN = 'fictional-tenant-token';

const hosts: [official: string, local: string][] = [
  ['https://open.feishu.cn', '/feishu-api'],
  ['https://api.dingtalk.com', '/dingtalk-api'],
  ['https://oapi.dingtalk.com', '/dingtalk-oapi'],
  ['https://fake-media.invalid', '/media'],
];
const sockets: [official: string, local: string][] = [
  ['wss://openws.work.weixin.qq.com', '/wecom'],
  ['wss://fake-feishu.invalid/ws', '/feishu'],
  ['wss://fake-dingtalk.invalid/connect', '/dingtalk'],
];
const RESOURCE = /^\/feishu-api\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/;
const REPLY = /^\/feishu-api\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/;
const DEFAULT_PING_SECONDS = 120;

function feishuFake() {
  const feishu = {
    /** 换连接地址时回的错误码；0 是正常。 */
    endpointCode: 0,
    /** 换连接地址时回的 HTTP 状态（配合 endpointCode 模拟 5xx 带错误码）。 */
    endpointStatus: 200,
    sockets: [] as NodeWebSocket[],
    /** 客户端发来的帧（心跳、回包）。 */
    frames: [] as FeishuFrame[],
    replies: [] as { messageId: string; text: string; auth: string }[],
    downloads: 0,
    /** 关掉就不回心跳，模拟连接半死。 */
    answerPings: true,
    /** 推一条飞书事件，可拆成几片。返回用的 message_id 头。 */
    push(event: unknown, pieces = 1) {
      const socket = feishu.sockets.at(-1);
      if (!socket) throw new Error('飞书假服务端还没有连接');
      const bytes = Buffer.from(JSON.stringify(event)),
        size = Math.ceil(bytes.length / pieces),
        id = 'fictional-msg-' + randomUUID();
      for (let seq = 0; seq < pieces; seq++)
        socket.send(
          encodeFrame({
            SeqID: BigInt(seq + 1),
            LogID: 9007199254740993n,
            service: 7,
            method: 1,
            headers: [
              { key: 'type', value: 'event' },
              { key: 'message_id', value: id },
              { key: 'sum', value: String(pieces) },
              { key: 'seq', value: String(seq) },
              { key: 'trace_id', value: 'fictional-trace' },
            ],
            payload: bytes.subarray(seq * size, (seq + 1) * size),
          }),
        );
      return id;
    },
  };
  return feishu;
}
type FeishuFake = ReturnType<typeof feishuFake>;
type Fakes = { feishu: FeishuFake; files: Map<string, FakeFile>; pingSeconds: number; dingtalk: () => DingtalkFake };

/** 飞书换长连接地址：凭据不对回 514，排了错误码就回它 */
function feishuEndpoint(fakes: Fakes, res: http.ServerResponse, body: Record<string, unknown>) {
  if (body.AppID !== FAKE_APP.appId || body.AppSecret !== FAKE_APP.secret) return json(res, 200, { code: 514, msg: 'auth failed: fictional' });
  const { feishu } = fakes;
  if (feishu.endpointCode) return json(res, feishu.endpointStatus, { code: feishu.endpointCode, msg: 'fictional error' });
  json(res, 200, {
    code: 0,
    data: {
      URL: 'wss://fake-feishu.invalid/ws?device_id=fictional-device&service_id=7',
      ClientConfig: { PingInterval: fakes.pingSeconds, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 },
    },
  });
}

/** 飞书收到的回复：正文是 JSON 文本 { text } */
const replyContent = z.looseObject({ text: z.unknown().optional() });

/** 飞书的几个地址；对不上的回 404 */
function feishuHttp(fakes: Fakes, req: http.IncomingMessage, res: http.ServerResponse, path: string, body: Record<string, unknown>) {
  if (path === '/feishu-api/callback/ws/endpoint') return feishuEndpoint(fakes, res, body);
  if (path === '/feishu-api/open-apis/auth/v3/tenant_access_token/internal') {
    if (body.app_id !== FAKE_APP.appId || body.app_secret !== FAKE_APP.secret) return json(res, 200, { code: 10014, msg: 'bad' });
    return json(res, 200, { code: 0, tenant_access_token: FEISHU_TOKEN, expire: 7200 });
  }
  const resource = RESOURCE.exec(path);
  if (resource) {
    if (req.headers.authorization !== 'Bearer ' + FEISHU_TOKEN) return json(res, 401, { code: 234002 });
    fakes.feishu.downloads++;
    return serveFile(res, fakes.files, decodeURIComponent(resource[2]));
  }
  const reply = REPLY.exec(path);
  if (reply) {
    fakes.feishu.replies.push({
      messageId: decodeURIComponent(reply[1]),
      text: String(replyContent.parse(JSON.parse(String(body.content))).text),
      auth: String(req.headers.authorization),
    });
    return json(res, 200, { code: 0 });
  }
  json(res, 404, { msg: 'fake: no route ' + path });
}

async function handle(fakes: Fakes, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', 'http://local');
  const path = url.pathname;
  if (path.startsWith('/dingtalk-') || path.startsWith('/media/dingtalk/')) return fakes.dingtalk().http(req, res, url, fakes.files);
  if (path.startsWith('/media/')) return serveFile(res, fakes.files, decodeURIComponent(path.slice('/media/'.length)));
  const body = req.method === 'POST' ? await readBody(req) : {};
  feishuHttp(fakes, req, res, path, body);
}

const wecomFrame = z.looseObject({ cmd: z.unknown().optional(), headers: z.unknown().optional(), body: z.unknown().optional() });
/** 企业微信：只够设置页预览用的订阅和心跳（协议的细节测试在 bot-wecom.test.ts）。 */
const wecomSocket = (ws: NodeWebSocket) =>
  ws.on('message', (raw) => {
    const frame = wecomFrame.parse(JSON.parse(String(raw)));
    if (frame.cmd === 'aibot_subscribe') {
      const ok = field(frame.body, 'bot_id') === FAKE_APP.appId && field(frame.body, 'secret') === FAKE_APP.secret;
      ws.send(JSON.stringify({ headers: frame.headers, errcode: ok ? 0 : 853000, errmsg: ok ? 'ok' : 'fictional' }));
    } else if (frame.cmd === 'ping') ws.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
  });
const frameBytes = (raw: RawData) => (raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
const feishuSocket = (feishu: FeishuFake) => (ws: NodeWebSocket) => {
  feishu.sockets.push(ws);
  ws.on('message', (raw) => {
    const frame = decodeFrame(frameBytes(raw));
    feishu.frames.push(frame);
    if (frame.method === 0 && headerOf(frame, 'type') === 'ping' && feishu.answerPings)
      ws.send(encodeFrame({ ...frame, headers: [{ key: 'type', value: 'pong' }], payload: new TextEncoder().encode('{}') }));
  });
};

/** 官方地址换成本机假服务端：HTTP 走 fetchImpl，WebSocket 走 LocalWebSocket */
function localClients(port: number) {
  const base = 'http://127.0.0.1:' + port;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = hosts.find(([official]) => url.startsWith(official + '/'));
    if (!host) throw new Error('假服务端不认这个地址：' + url);
    return fetch(base + host[1] + url.slice(host[0].length), init);
  }) as typeof fetch;
  class LocalWebSocket extends NodeWebSocket {
    constructor(url: string | URL) {
      const text = String(url);
      const target = sockets.find(([official]) => text.startsWith(official));
      if (!target) throw new Error('假服务端不认这个连接地址：' + text);
      super('ws://127.0.0.1:' + port + target[1] + text.slice(target[0].length));
    }
  }
  const WebSocketImpl: NonNullable<BotConnectionOptions['WebSocketImpl']> = LocalWebSocket;
  return { base, fetchImpl, WebSocketImpl };
}

export async function startFakeBots(options: { feishuPingSeconds?: number } = {}) {
  let dingtalk: DingtalkFake | undefined;
  const fakes: Fakes = {
    feishu: feishuFake(),
    files: new Map<string, FakeFile>(),
    pingSeconds: options.feishuPingSeconds ?? DEFAULT_PING_SECONDS,
    dingtalk: () => {
      if (!dingtalk) throw new Error('钉钉假服务端还没建好');
      return dingtalk;
    },
  };
  // 出错回 500（测试里看得到哪错了），不让异常漏成没人接的 Promise
  const server = http.createServer((req, res) => void handle(fakes, req, res).catch((e: unknown) => json(res, 500, { msg: errorMessage(e) })));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname === '/dingtalk' && !fakes.dingtalk().acceptTicket(url.searchParams.get('ticket'))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/wecom') wecomSocket(ws);
      else if (url.pathname === '/feishu') feishuSocket(fakes.feishu)(ws);
      else if (url.pathname === '/dingtalk') fakes.dingtalk().socket(ws);
      else ws.close();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('假服务端没有拿到端口');
  const clients = localClients(address.port);
  dingtalk = dingtalkFake(clients.base);
  return {
    files: fakes.files,
    feishu: fakes.feishu,
    dingtalk,
    fetchImpl: clients.fetchImpl,
    WebSocketImpl: clients.WebSocketImpl,
    checkHost: async () => FAKE_PUBLIC_IP,
    close: () =>
      new Promise<void>((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
