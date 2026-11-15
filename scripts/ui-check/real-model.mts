// 预览实例的“真实模型”模式（preview.mjs --real-model）：不装模型替身，连真实 DeepSeek。
// 密钥由用户在这个实例的设置页填一次，程序的凭据存储加密后存在固定隔离目录（preview.mjs 拼的路径），以后接着用。
// 这里还挂了冒烟脚本 real-smoke.mjs 用的几个测试入口（只有这个隔离实例有），密钥始终留在服务端，不经过脚本。
// UI_CHECK_FAKE_DEEPSEEK=1 时连假 DeepSeek（只给冒烟脚本自测），配置目录是临时目录。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { uploadPurposes } from '../../shared/ai/index.ts';
import { watchUpstream, type Cuts, type Traffic } from './real-model-traffic.mts';
import { failureOf, toolCallScenarios } from './real-tool-calls.mts';

const { AiSettingsManager, defaultAiSettingsPath } = await import('../../server/ai/index.ts');
type Settings = InstanceType<typeof AiSettingsManager>;

export async function createRealModelSettings() {
  let calls = 0;
  const upstream: Traffic[] = [];
  const cuts: Cuts = { left: 0, afterBytes: 800 };
  const fake = process.env.UI_CHECK_FAKE_DEEPSEEK === '1';
  let settings: Settings;
  if (fake) {
    const { fakeDeepSeek, testProtector } = await import('../../tests/fake-deepseek.ts');
    const deepseek = fakeDeepSeek({
      chat: (body) => fakeAnswer(body),
      asrText: '测试订单五百只',
      pages: { 'https://api-docs.deepseek.com/zh-cn/': { title: 'DeepSeek API 文档（虚构）', content: '# 虚构正文' } },
    });
    settings = new AiSettingsManager({ protector: testProtector, transport: watchUpstream((request) => (calls++, deepseek.transport(request)), upstream, cuts) });
    settings.saveKey({ apiKey: deepseek.key, expectedRevision: settings.view().revision });
  } else {
    // 和程序正式用的一样直接 fetch，只多数一下发了几次
    settings = new AiSettingsManager({ file: defaultAiSettingsPath(), transport: watchUpstream((request) => (calls++, fetch(request)), upstream, cuts) });
  }
  return {
    settings,
    fake,
    calls: () => calls,
    /** 拿走到现在为止记下的对话请求摘要 */
    traffic: () => upstream.splice(0),
    /** 接下来 times 次流式对话请求收到 afterBytes 字节后掐断 */
    cut: (times: number, afterBytes?: number) => {
      cuts.left = Math.max(0, Math.min(10, Math.floor(times) || 0));
      if (afterBytes && afterBytes > 0) cuts.afterBytes = Math.floor(afterBytes);
      return { ...cuts };
    },
    upstreamErrors: () => upstream.splice(0).filter((t) => t.status >= 400).map((t) => ({ status: t.status, message: t.error ?? '' })),
  };
}
type RealModel = Awaited<ReturnType<typeof createRealModelSettings>>;

const b64 = (s: unknown) => Buffer.from(String(s || ''), 'base64');
const answerOnly = '只根据给你的内容回答，只输出一个 JSON 对象；问题里给了键名就用那些键、值原样照抄，读不到的填 null；没给键名就用 {"answer":"一句话"}。';
/** 假 DeepSeek 收到的请求里自测要看的几项 */
const fakeRequestSchema = z.object({ messages: z.unknown().optional(), tools: z.unknown().optional() });
const listSchema = z.array(z.unknown());
const lookupToolSchema = z.object({ function: z.object({ name: z.literal('lookup_order') }) });
const userMessageSchema = z.object({ role: z.literal('user') });
/** 假 DeepSeek 自测用的固定回答：按问题里的键名回“读对了”的值 */
function fakeAnswer(raw: unknown) {
  const body = fakeRequestSchema.parse(raw);
  const tools = listSchema.safeParse(body.tools);
  const messages = listSchema.safeParse(body.messages);
  // 助手的原生工具调用请求：回一个信封，假 DeepSeek 自动翻成原生回复（不调工具、直接答完）
  // 探测脚本的 lookup_order：还没收到工具结果就先调一次，收到了再答
  if (tools.success && tools.data.some((t) => lookupToolSchema.safeParse(t).success) && messages.success && userMessageSchema.safeParse(messages.data.at(-1)).success)
    return { message: '我先查一下。', toolCalls: [{ name: 'lookup_order', args: { orderNo: 'XS-001' } }] };
  if (tools.success) return { speaker: 'yong', message: '虚构回答（假 DeepSeek）', status: 'completed', toolCalls: [] };
  const text = JSON.stringify(body.messages);
  if (text.includes('priceA'))
    return { priceA: '1.3', priceB: '0.7312', dateA: '2026-12-01', merged: '虚构客户甲 采购订单（测试数据，不是真实订单）', hidden: 'HX-7731' };
  if (text.includes('qtyB')) return { qtyB: '800', imageText: '虚构样箱' };
  return { ok: true, answer: '虚构回答' };
}

type Step = (body: unknown) => Promise<unknown>;
/** 先按 schema 校验请求体，再交给这一步 */
const withBody =
  <T,>(schema: z.ZodType<T>, run: (body: T) => Promise<unknown>): Step =>
  (body) =>
    run(schema.parse(body));
const scenarioBody = z.object({ scenario: z.coerce.string() });
const fileBody = z.object({ name: z.string(), data: z.unknown().optional(), purpose: z.enum(uploadPurposes), question: z.string() });
const imageBody = z.object({ data: z.coerce.string(), question: z.string() });
const dataBody = z.object({ data: z.unknown().optional() });
const textBody = z.object({ text: z.coerce.string() });
const queryBody = z.object({ query: z.coerce.string() });
const urlBody = z.object({ url: z.coerce.string() });
const cutBody = z.object({ times: z.unknown().optional(), afterBytes: z.unknown().optional() });
const agentBody = z.object({ session: z.unknown().optional() });
const sessionValues = z.record(z.string(), z.unknown());

/** 不带工具、不开思考问一句，回答按 JSON 解析（去掉代码围栏）。产品里没有要 JSON 输出的对话了，只有这个冒烟脚本这样问。 */
async function askJson(settings: Settings, messages: Parameters<Settings['completeChatTools']>[0], maxOutputTokens: number, stream = true) {
  const reply = await settings.completeChatTools(messages, [], undefined, { thinking: 'off', stream, maxOutputTokens });
  const answer: unknown = JSON.parse(reply.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  return answer;
}
/** 分段计时：回调开始时文件已经传完、拿到编号（上传解析）；回答完到删文件之前算模型回答 */
async function fileStep(settings: Settings, b: z.infer<typeof fileBody>) {
  const started = Date.now();
  let uploaded = started,
    answered = started;
  const answer = await settings.withUploadedFiles([{ name: b.name, data: b64(b.data), purpose: b.purpose }], (parts) => {
    uploaded = Date.now();
    return askJson(
      settings,
      [
        { role: 'system', content: answerOnly },
        { role: 'user', content: [{ type: 'text', text: b.question }, ...parts] },
      ],
      2000,
    ).finally(() => (answered = Date.now()));
  });
  return { answer, uploadMs: uploaded - started, answerMs: answered - uploaded };
}
/** 冒烟脚本的测试入口：每个地址只做一件事，返回给人看的摘要，不返回密钥、不返回原文全文。 */
function steps(model: RealModel): Record<string, Step> {
  const settings = model.settings;
  return {
    // DeepSeek 工具调用的探测（real-tool-calls-probe.mjs）：b.scenario 是 real-tool-calls.mts 里的场景名
    'tool-calls': withBody(scenarioBody, (b) => {
      const scenario = toolCallScenarios[b.scenario];
      if (!scenario) throw new Error('没有这个场景：' + b.scenario);
      model.upstreamErrors();
      return scenario.run(settings).then((result) => ({ result, upstreamErrors: model.upstreamErrors() }));
    }),
    balance: async () => {
      const b = await settings.balance();
      return { available: b.available, currency: b.balances[0]?.currency ?? null };
    },
    chat: () =>
      askJson(
        settings,
        [
          { role: 'system', content: '只输出一个 JSON 对象。' },
          { role: 'user', content: '回复 {"ok":true}' },
        ],
        1000,
      ),
    file: withBody(fileBody, (b) => fileStep(settings, b)),
    image: withBody(imageBody, (b) =>
      askJson(
        settings,
        [
          { role: 'system', content: answerOnly },
          {
            role: 'user',
            content: [
              { type: 'text', text: b.question },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b.data, detail: 'high' } },
            ],
          },
        ],
        2000,
      ),
    ),
    tts: withBody(textBody, async (b) => {
      const audio = await settings.textToSpeech(b.text, { signal: AbortSignal.timeout(120_000) });
      const pcm = Buffer.from(await new Response(audio.body).arrayBuffer());
      return { bytes: pcm.length, sampleRate: audio.sampleRate, pcm: pcm.toString('base64') };
    }),
    asr: withBody(dataBody, (b) => settings.speechToText(b64(b.data))),
    search: withBody(queryBody, async (b) => {
      const r = await settings.webSearch({ query: b.query, count: 3 });
      return { count: r.length, first: r[0] ? { title: r[0].title.slice(0, 60), url: r[0].url } : null };
    }),
    fetch: withBody(urlBody, async (b) => {
      const r = await settings.webFetch(b.url);
      return { title: r.title.slice(0, 60), chars: r.content.length };
    }),
  };
}

/** /__real-smoke/agent：调会话上下文的几个数，null 恢复默认，只认已有的键、正数 */
function agentStep(agent: { session: Record<string, number> }): Step {
  const sessionDefaults = { ...agent.session };
  return withBody(agentBody, async (body) => {
    if (body.session === null) agent.session = { ...sessionDefaults };
    else {
      const values = sessionValues.safeParse(body.session);
      if (values.success)
        for (const [k, v] of Object.entries(values.data))
          if (k in sessionDefaults && typeof v === 'number' && v > 0) agent.session[k] = v;
    }
    return { session: agent.session };
  });
}
/** 处理一次测试入口请求：读完请求体交给那一步，出错回给人看的摘要 */
function answerStep(req: IncomingMessage, step: Step, send: (status: number, body: unknown) => void) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    void (async () => {
      try {
        send(200, { ok: true, result: await step(raw ? JSON.parse(raw) : {}) });
      } catch (error) {
        const failure = failureOf(error);
        send(200, { ok: false, code: failure.code ?? 'error', status: failure.upstreamStatus ?? null, message: String(failure.message || '失败').slice(0, 300) });
      }
    })();
  });
}
/**
 * /__real-smoke/<步骤>、/__real-smoke/count、/__real-smoke/traffic（拿走记下的对话请求摘要）和 /__real-smoke/cut（{ times, afterBytes? }：
 * 接下来几次流式对话请求半路掐断）；只认登录了的超级管理员。处理了返回 true。
 * agent 给了时多一个 /__real-smoke/agent：全量测试（real-suite.mjs）不重启实例临时调会话上下文的几个数，
 * body 是 { session?: { compactAboveTokens?, retainTokens?, … } | null }；只给“压缩真的跑一次”那条场景用，null 恢复默认。
 */
export function realSmokeHandler(model: RealModel, actorOf: (req: IncomingMessage) => { role?: string } | null, agent?: { session: Record<string, number> }) {
  const table: Record<string, Step> = {
    ...steps(model),
    traffic: async () => model.traffic(),
    cut: withBody(cutBody, async (body) => model.cut(Number(body.times), Number(body.afterBytes))),
    ...(agent ? { agent: agentStep(agent) } : {}),
  };
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith('/__real-smoke/')) return false;
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    if (actorOf(req)?.role !== 'super_admin') {
      send(403, { ok: false, message: '要用超级管理员登录' });
      return true;
    }
    const name = req.url.slice('/__real-smoke/'.length);
    if (name === 'count') {
      send(200, { calls: model.calls(), fake: model.fake, hasKey: model.settings.view().hasKey });
      return true;
    }
    const step = table[name];
    if (!step || req.method !== 'POST') {
      send(404, { ok: false, message: '没有这个测试入口' });
      return true;
    }
    answerStep(req, step, send);
    return true;
  };
}
