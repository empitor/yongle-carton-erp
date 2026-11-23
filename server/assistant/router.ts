// 助手的地址（挂在 /api/assistant 下）：先统一核对登录和页面凭证，再分三处注册——
// 收发 JSON 的按接口表走 route()（api-router.ts、preview-router.ts、memory-router.ts）；
// 这里只留收发的不是 JSON 的 5 个：语音识别的录音、朗读的音频流、上传附件的原始字节、下载附件原件、一轮回复的事件流。
import express, { Router } from 'express';
import { z } from 'zod';
import type { RequestAuth } from '../core/index.js';
import type { AssistantManager } from './manager.js';
import { AppError, openEventStream, watchDisconnect } from '../core/index.js';
import { AI_HTTP_TIMEOUT_MS } from '../../shared/ai/index.js';
import { readAloud, transcribePcm } from './speech/service.js';
import { messageForSpeech } from './speech-text.js';
import { memoryRouter } from './memory-router.js';
import { previewRoutes } from './preview-router.js';
import { jsonRoutes } from './api-router.js';
import { field } from './chat/result-fields.js';

/** 一轮回复的事件流最长开多久：AI 接口超时的这么多倍 */
const STREAM_TIMEOUTS = 4;
/** 朗读、语音识别带的编号最长多少字 */
const SPEECH_ID_CHARS = 100;
const speakBody = z.strictObject({
  threadId: z.string().min(1).max(SPEECH_ID_CHARS),
  messageId: z.string().min(1).max(SPEECH_ID_CHARS),
});

/** 语音输入和朗读（都交给 DeepSeek，密钥只在服务端）：录音进、音频流出，不是 JSON */
function speechRoutes(router: Router, manager: AssistantManager, auth: RequestAuth) {
  // 语音识别：录音在内存里包成 WAV 发给 DeepSeek 识别，不落盘；浏览器断开就取消上游。
  router.post('/transcribe', express.raw({ type: 'application/octet-stream', limit: '3mb' }), async (req, res) => {
    const owner = auth.actor(req);
    if (!owner) throw new AppError('登录状态已失效，请重新登录。', 401, 'speech');
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new AppError('请通过语音识别入口提交 16kHz 单声道音频。', 415, 'speech');
    const upstream = new AbortController();
    const release = watchDisconnect(res, () => upstream.abort());
    try {
      const result = await transcribePcm(manager.settings, body, owner.id, upstream.signal);
      if (res.destroyed) return;
      if (auth.actor(req)?.id !== owner.id) throw new AppError('登录状态已变化，已丢弃本次语音结果。', 403, 'speech');
      res.json(result);
    } finally {
      release();
    }
  });
  // 朗读：按消息编号由服务端取文字（只读自己会话里助手的回复），DeepSeek 合成的音频边收边转给浏览器
  router.post('/speak', async (req, res) => {
    const owner = auth.signedIn(req);
    const v = speakBody.parse(req.body);
    await readAloud(manager.settings, messageForSpeech(manager.store.db, v.threadId, v.messageId, owner.id), owner.id, res);
  });
}

/** 附件：上传原始字节、下载原件 */
function attachmentFileRoutes(router: Router, manager: AssistantManager, auth: RequestAuth) {
  router.post('/threads/:id/attachments', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
    if (manager.isBusy(req.params.id)) throw new AppError('请先等待或停止当前AI回复，再上传附件。', 409);
    let name: string;
    try {
      name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    } catch {
      throw new AppError('文件名编码无效。');
    }
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) throw new AppError('请通过附件上传入口提交原始字节。', 415);
    const uploadId = String(req.headers['x-upload-id'] || '');
    const saved = await manager.attachments.upload(req.params.id, body, name, uploadId, auth.actor(req), () =>
      res.destroyed ? null : auth.actor(req),
    );
    res.status(201).json(saved);
  });
  router.get('/attachments/:id/file', (req, res) => {
    const { meta, bytes } = manager.attachments.file(req.params.id, auth.actor(req));
    res.set({
      'Content-Type': meta.mime + (meta.kind === 'text' ? '; charset=utf-8' : ''),
      'Content-Disposition': (req.query.download === '1' ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(meta.name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.send(bytes);
  });
}

/** 一次回复用事件流推给页面（写法在 server/core/http/stream.ts）；进度按阶段、正在生成的正文（整段替换）只算最新一条 */
function chatRoute(router: Router, manager: AssistantManager, auth: RequestAuth) {
  router.post('/threads/:id/chat', async (req, res) => {
    const id = req.params.id;
    const stream = openEventStream(req, res, {
      timeoutMs: AI_HTTP_TIMEOUT_MS * STREAM_TIMEOUTS,
      onLost: () => {
        if (!auth.actor(req)) return;
        try {
          manager.cancel(id, auth.actor(req));
        } catch {
          /* 无效会话已由主请求安全拒绝。 */
        }
      },
      latest: { progress: (d: unknown) => field(d, 'stage'), draft: () => 'draft' },
    });
    try {
      const body: unknown = req.body;
      // 从域名进来时，只能在服务器本机做的操作（一键清空）生成方案时就说明，不出必然失败的卡片
      const proxy = res.locals.proxyIngress !== false;
      stream.end('result', await manager.chat(id, body, auth.actor(req), auth.sessionBinding(req), stream.send, () => auth.actor(req), { proxy }));
    } catch (e) {
      stream.end('error', {
        message: e instanceof AppError ? e.message : '全局助手请求失败，请重新载入历史核实结果后再试。',
      });
    }
  });
}

export function assistantRouter(manager: AssistantManager, auth: RequestAuth) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    auth.signedIn(req);
    if (req.method !== 'GET' && req.headers['x-erp-auth-token'] !== auth.csrf) throw new AppError('页面凭证失效，请刷新。', 403);
    next();
  });
  // 助手窗口的“记忆”面板：只动当前账号自己的长期记忆
  router.use('/memory', memoryRouter(manager.registry.memory, auth));
  // 语音输入和朗读都交给 DeepSeek（密钥只在服务端）：没填密钥、密钥读不出来时直接说清楚
  router.use('/transcribe', (_req, _res, next) => {
    if (!manager.speechAvailable()) throw new AppError('语音输入用不了：' + manager.settings.status().message, 503, 'key_required');
    next();
  });
  router.use('/speak', (_req, _res, next) => {
    if (!manager.speechAvailable()) throw new AppError('朗读用不了：' + manager.settings.status().message, 503, 'key_required');
    next();
  });
  jsonRoutes(router, manager, auth);
  speechRoutes(router, manager, auth);
  attachmentFileRoutes(router, manager, auth);
  chatRoute(router, manager, auth);
  previewRoutes(router, manager, auth);
  return router;
}
