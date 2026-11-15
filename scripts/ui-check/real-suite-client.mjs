// 助手真实模型全量测试（real-suite.mjs）用的 HTTP 客户端：按账号登录、发话读事件流、传附件、点确认卡片、看业务库每行变没变。
// 只走测试实例的 HTTP 和它自己临时目录里的虚构业务库（只读打开）；拿不到也不打印密钥。
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 账号：密码在 server.mts 的种子里（虚构）；“虚构财务”由套件开头用超级管理员现建
const seed = readFileSync(new URL('./server.mts', import.meta.url), 'utf8');
const seeded = (name) => new RegExp(`add\\('${name}',\\s*'([^']+)'`).exec(seed)?.[1];
export const FINANCE_ACCOUNT = { name: '虚构财务', password: 'Fictional-Finance-2026', level: 'finance' };
/** instance：local 是本机管理员模式的实例，remote 是模拟从域名访问的实例 */
export const ACCOUNTS = {
  local: { label: '本机管理员', name: '虚构管理员', instance: 'local' },
  remote: { label: '从域名访问的超级管理员（没进模式）', name: '虚构管理员', instance: 'remote' },
  'remote-super': { label: '从域名访问的超级管理员（进了模式）', name: '虚构管理员', instance: 'remote', superMode: true },
  staff: { label: '业务员', name: '虚构业务员', instance: 'remote' },
  viewer: { label: '只读', name: '虚构只读', instance: 'remote' },
  finance: { label: '财务', name: FINANCE_ACCOUNT.name, instance: 'remote' },
  cashier: { label: '出纳', name: '虚构出纳', instance: 'remote' },
};
export const passwordOf = (name) => (name === FINANCE_ACCOUNT.name ? FINANCE_ACCOUNT.password : seeded(name));

// 行快照不算的表：助手自己的记录、审计、预览、请求去重、编号计数这类每次操作都会动的
const IGNORED = /^(assistant_|sqlite_|schema_migrations$|business_audit$|operation_requests$|number_sequences$|fin_source_observations$)/;
// 比行内容时不算的列：每次保存都会变、本身不是业务内容的（只改了这些算没改）
const VOLATILE = /^(version|updated_at|request_id|.*_digest)$/;

/** 事件流里的一条事件记进 say() 的结果；at 是从发话起过了多少毫秒 */
function recordEvent(out, event, data, at) {
  if (event === 'result') out.view = data;
  if (event === 'error') out.error = data.message;
  if (event === 'reasoning') {
    out.reasoningChars += data.text?.length ?? 0;
    out.firstReasoningMs ??= at;
  }
  // 每次工具调用的结果：完成还是失败（失败的原因在回复的事实标注里）
  if (event === 'tool' && data.state !== 'running') out.calls.push({ name: data.name, state: data.state });
  // 这一轮压缩了会话历史（不管压缩怎么实现，都会先报这一步）
  if (event === 'progress' && data.stage === 'compacting') out.compacted = (out.compacted ?? 0) + 1;
  // 和 DeepSeek 的连接断了、程序自动重发（测试入口 cut 掐断时会有）
  if (event === 'progress' && data.stage === 'retrying') out.retries = (out.retries ?? 0) + 1;
  if (event === 'draft') {
    out.draft = data.text ?? out.draft;
    out.firstDraftMs ??= at;
  }
}

export class Session {
  constructor(base, account, dataDir) {
    Object.assign(this, { base, account, dataDir });
  }
  async login() {
    let res;
    try {
      res = await fetch(this.base + '/api/auth/state');
    } catch (e) {
      const cause = e instanceof Error && 'cause' in e && e.cause instanceof Error ? e.cause : null;
      const code = cause && 'code' in cause ? `${String(cause.code)} ` : '';
      const detail = cause?.message || (e instanceof Error ? e.message : String(e));
      throw new Error(`连接 ${this.base} 失败：${code}${detail}`, { cause: e });
    }
    const state = await res.json().catch(() => null);
    if (!state?.csrf) throw new Error(`${this.base} 上没有测试实例`);
    const r = await fetch(this.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': state.csrf },
      body: JSON.stringify({ name: this.account.name, password: passwordOf(this.account.name) }),
    });
    if (!r.ok) throw new Error(`登录${this.account.name}失败：HTTP ${r.status} ${await r.text()}`);
    this.cookie = r.headers.get('set-cookie').split(';')[0];
    this.csrf = (await fetch(this.base + '/api/auth/state', { headers: { Cookie: this.cookie } }).then((x) => x.json())).csrf;
    if (this.account.superMode) {
      const s = await this.request('/api/auth/super-admin/enter', { password: passwordOf(this.account.name) });
      if (!s.ok) throw new Error('进超级管理员模式失败：' + s.message);
    }
    return this;
  }
  get headers() {
    return { 'Content-Type': 'application/json', Cookie: this.cookie, 'X-ERP-Auth-Token': this.csrf, Origin: this.base };
  }
  /** 返回 { ok, status, body, message }，不抛错：被拒也是要记的结果 */
  async request(path, body, method, extraHeaders = {}) {
    const r = await fetch(this.base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...this.headers, ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 回的不是 JSON（比如出错页）：body 留空，message 用原文
    }
    return { ok: r.ok, status: r.status, body: parsed, message: parsed?.message ?? text.slice(0, 200) };
  }
  async api(path, body, method) {
    const r = await this.request(path, body, method);
    if (!r.ok) throw new Error(`${method || (body === undefined ? 'GET' : 'POST')} ${path} 失败：HTTP ${r.status} ${r.message}`);
    return r.body;
  }
  smoke(name, body) {
    return this.api('/__real-smoke/' + name, body);
  }
  async newThread() {
    return (await this.api('/api/assistant/threads', {})).id;
  }
  /** 这个账号的助手能用（会发给模型）的工具名 */
  async usableTools() {
    return (await this.api('/api/assistant/tools')).tools.filter((t) => t.usable).map((t) => t.name);
  }
  /**
   * 发一句话，读完事件流。cancel：{ afterMs } 到点就点停止。
   * 返回会话视图、出错、耗时、首个思考 / 正文事件的时间、思考字数、模型自己最后写的正文（draft）。
   */
  async say(thread, text, extra = {}, cancel) {
    const started = Date.now();
    const requestId = randomUUID();
    const out = { requestId, view: null, error: null, reasoningChars: 0, draft: '', firstReasoningMs: null, firstDraftMs: null, cancelled: false, calls: [] };
    const r = await fetch(this.base + `/api/assistant/threads/${thread}/chat`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ requestId, text, ...extra }),
    });
    if (!r.ok || !r.body) {
      out.error = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      return { ...out, ms: Date.now() - started };
    }
    const stop = () => {
      if (out.cancelled) return;
      out.cancelled = true;
      this.request(`/api/assistant/threads/${thread}/cancel`, {});
    };
    const timer = cancel?.afterMs ? setTimeout(stop, cancel.afterMs) : null;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const raw = /^data: (.*)$/m.exec(block)?.[1];
        if (!event || !raw) continue;
        recordEvent(out, event, JSON.parse(raw), Date.now() - started);
      }
    }
    if (timer) clearTimeout(timer);
    // 出错时事件流里没有会话视图，补读一次（这一轮存下的出错消息在里面）
    out.view ??= (await this.request(`/api/assistant/threads/${thread}`)).body;
    return { ...out, ms: Date.now() - started };
  }
  /** 上传附件；返回 { ok, status, id, message }（被拒时是服务器原话） */
  async upload(thread, name, bytes) {
    const r = await fetch(this.base + `/api/assistant/threads/${thread}/attachments`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-Upload-Id': randomUUID() },
      body: bytes,
    });
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, id: body?.id, message: body?.message ?? '', size: bytes.length };
  }
  /** 在确认卡片上点确认（删除类本机管理员以外带本人密码）；返回执行结果、服务器原话，导出类带要下载的文件编号 */
  async confirm(card) {
    const r = await this.request(`/api/assistant/previews/${card.id}/execute`, {
      acknowledged: true,
      ...(card.args?.deletionDigest ? { deletionDigest: card.args.deletionDigest } : {}),
      ...(card.requiresPassword ? { password: passwordOf(this.account.name) } : {}),
    });
    const exportId = r.body?.file?.exportId ?? r.body?.exportId ?? r.body?.result?.exportId;
    return { ok: r.ok, status: r.status, code: r.body?.code, message: r.ok ? r.body?.label || r.body?.message || '已执行' : r.message, exportId };
  }
  /** 在确认卡片上点“不执行” */
  async reject(card) {
    const r = await this.request(`/api/assistant/previews/${card.id}/reject`, {});
    return { ok: r.ok, status: r.status, message: r.ok ? '已作废' : r.message };
  }
  /** 删除卡片上改“库存怎么处理” */
  inventoryPolicy(card, policy) {
    return this.request(`/api/assistant/previews/${card.id}/inventory-policy`, { inventoryPolicy: policy });
  }
  /** 像浏览器那样把导出的单据下载下来并报告交付完成（导出并标已订货、导出并出库要交付完成才改状态） */
  async download(exportId) {
    const r = await fetch(this.base + `/api/documents/${exportId}/file`, { headers: this.headers });
    if (!r.ok) return { ok: false, status: r.status, message: (await r.text()).slice(0, 200) };
    const sha256 = createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
    const done = await this.request(`/api/documents/${exportId}/complete`, { sha256 });
    return { ok: done.ok, status: done.status, message: done.ok ? '已下载并交付' : done.message };
  }
  memories() {
    return this.api('/api/assistant/memory');
  }
}

/**
 * 业务库行快照：{ 表: Map(主键 → 去掉易变列后的内容哈希) }。只读打开测试实例临时目录里的虚构库，WAL 模式下和服务并行读没问题。
 * 主键按建表的 PRIMARY KEY 列，没有就用 rowid。
 */
export function rowSnapshot(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'erp.sqlite'), { readOnly: true });
  try {
    const out = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
      if (IGNORED.test(name)) continue;
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
      const pk = cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const keep = cols.map((c) => c.name).filter((c) => !VOLATILE.test(c));
      const rows = new Map();
      for (const r of db.prepare(`SELECT rowid AS "__rowid", * FROM "${name}"`).all()) {
        const key = JSON.stringify(pk.length ? pk.map((c) => r[c]) : [r.__rowid]);
        rows.set(key, createHash('sha256').update(JSON.stringify(keep.map((c) => r[c]))).digest('hex').slice(0, 16));
      }
      out[name] = rows;
    }
    return out;
  } finally {
    db.close();
  }
}
/** 两次快照之间每张表增、删、改了几行：{ 表: { added, removed, changed } }，没变的表不列 */
export function rowDiff(before, after) {
  const out = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name] ?? new Map(),
      b = after[name] ?? new Map();
    let added = 0,
      removed = 0,
      changed = 0;
    for (const [k, h] of b) if (!a.has(k)) added++;
    else if (a.get(k) !== h) changed++;
    for (const k of a.keys()) if (!b.has(k)) removed++;
    if (added || removed || changed) out[name] = { added, removed, changed };
  }
  return out;
}
/** 直接查虚构库（场景里判数字用，比如某张订单现在的交期）；只读 */
export function query(dataDir, sql, ...params) {
  const db = new DatabaseSync(join(dataDir, 'erp.sqlite'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** 一次对话请求的用量：读这一轮的运行记录（预算视图里的 providerUsage，每次请求一条） */
export function runUsage(dataDir, requestId) {
  const row = query(dataDir, 'SELECT document FROM assistant_runs WHERE id=?', requestId)[0];
  const u = row ? JSON.parse(row.document).budget?.providerUsage : null;
  return {
    requests: u?.requests ?? 0,
    input: u?.inputTokens ?? 0,
    cached: u?.cachedInputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    reasoning: u?.reasoningTokens ?? 0,
  };
}

/**
 * 一轮对话的记录：只留判定和报告要用的，回答原文全留。工具调用看每条助手消息的事实标注（facts）和事件流里的工具事件；
 * 卡片看 plans（带 state：waiting / executed / cancelled / expired）。
 */
export function turnRecord(text, said, usage, since) {
  const messages = said.view?.messages ?? [];
  // 这一轮用户那句之后的全部助手消息；找不到就从头算（删聊天记录后只剩最后一条回复）。
  // “接着办”那条用户消息不显示、视图里没有，按上一轮视图里的消息条数（since）往后取
  let start = since ?? 0;
  if (since === undefined) for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { start = i + 1; break; }
  // 这一轮把会话记录清掉了（删聊天记录）：视图比上一轮短，从头取
  if (start > messages.length) start = 0;
  const replies = messages.slice(start).filter((m) => m.role === 'assistant');
  const facts = replies.map((m) => m.facts ?? {});
  const parts = replies.flatMap((m) => [{ speaker: m.speaker, text: m.text }, ...(m.relay ?? []).map((x) => ({ speaker: x.speaker, text: x.text }))]);
  const cards = replies.flatMap((m) => m.plans ?? []).map((p) => ({ id: p.id, tool: p.tool, label: p.label, args: p.args, state: p.state, workflow: !!p.workflow, summary: p.summary, before: p.before, after: p.after, destructive: !!p.destructive, requiresPassword: !!p.requiresPassword, requiresSuperMode: !!p.requiresSuperMode, localOnly: !!p.localOnly }));
  return {
    text,
    error: said.error,
    cancelled: said.cancelled,
    reply: parts.map((x) => x.text).join('\n'),
    draft: said.draft,
    speakers: parts.map((x) => x.speaker).filter(Boolean),
    // 谁说了什么：每条助手消息先是开口的人，接力的话在消息的 relay 里（另一位补的那段）
    parts,
    tools: [...new Set([...facts.flatMap((x) => x.tools ?? []), ...said.calls.map((c) => c.name)])],
    calls: said.calls,
    reads: facts.reduce((n, x) => n + (x.reads ?? 0), 0),
    failed: facts.flatMap((x) => x.failed ?? []),
    executed: facts.flatMap((x) => x.executed ?? []).map((e) => e.label),
    cards,
    exports: replies.flatMap((m) => m.exports ?? []),
    turnError: replies.some((m) => m.error),
    limit: replies.some((m) => m.limit),
    ms: said.ms,
    firstReasoningMs: said.firstReasoningMs,
    firstDraftMs: said.firstDraftMs,
    reasoningChars: said.reasoningChars,
    usage,
    compacted: said.compacted ?? 0,
    retries: said.retries ?? 0,
    viewCount: messages.length,
  };
}

// —— 自己起测试实例（--start）：preview.mjs --real-model，等 READY 行拿到虚构库目录；进程退出时一起关 ——
const previews = [];
export function startPreview({ root, port, remote = false, fake = false, log }) {
  const argv = ['scripts/ui-check/preview.mjs', '--real-model', '--port', String(port), ...(remote ? ['--remote'] : []), ...(fake ? ['--fake-deepseek'] : [])];
  const child = spawn(process.execPath, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  previews.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      appendFileSync(log, chunk);
      const ready = /READY http:\/\/127\.0\.0\.1:\d+(?:\D.*)? data=(.+)/.exec(String(chunk));
      if (ready) resolve(ready[1].trim());
    });
    child.stderr.on('data', (c) => appendFileSync(log, c));
    child.on('exit', (code) => reject(new Error(`端口 ${port} 的实例退出了（${code}），看 ${log}`)));
  });
}
/** Windows 上结束 preview.mjs 不会带走它起的服务和构建监听，按进程树结束 */
export function stopPreviews() {
  for (const c of previews.splice(0))
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGINT');
}
process.on('exit', stopPreviews);
