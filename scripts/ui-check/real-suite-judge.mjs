// 助手真实模型全量测试的判定：只看记录（每轮调到的工具、卡片、回答原文、业务库每张表增删改了几行），不发请求，单元测试直接测。
// 每条检查带问题级别：A 会改错数据或越权，B 办不成事，C 答错或编造，D 啰嗦、慢、说法不对。
// 写入场景用 expect.rows 写每张表应该增删改几行（多了算 A、少了算 B，没写的表不许动），再用场景自己的 check 核对最终数据（数量、金额、状态、库存）。

/** 回答里不能出现的说法：界面词表禁用的“草稿”，英文字段名、内部编号、工具名 */
const BANNED = [
  { re: /草稿/, what: '说了“草稿”' },
  { re: /\b(?:previewId|previewDigest|requestId|expectedVersion|customerId|productId|orderId|supplierId|stockId|lineId|taskId|workspaceId|deletionDigest)\b/, what: '露了英文字段名' },
  { re: /\b(?:records|flow|order_import|inventory|management|memory|finance|inbox|documents|order_batch|purchase_return|arrival|history|diagnostics|guide|web|task|page|marks|system|accounts|settings|logs|source|jobs|exports|chat|ai|ui|overview|prompts|delivery|production|attachments|purchase)(?:\.|__)[a-z_]+\b/, what: '露了工具名' },
  { re: /\b(?:awaiting_confirmation|needs_input|business:edit|super_admin|finance:view|null|undefined)\b/, what: '露了内部代码' },
];
const ASKING = /[？?]|请(告诉|提供|确认|说明|补充|问)|哪(家|个|张|一|天|位|批|条)|还需要|需要(您|你)|您想|你想|是指|回(我)?一句|告诉我|发(给)?我|说一下|麻烦(您|你)|还要.{0,10}才能|还差.{0,10}才能/;
const REFUSAL = /不能|无法|没有权限|无权|不允许|不支持|做不了|办不了|不可以|只能查|只读|拒绝|超级管理员|本机|不提供|没法|不在.{0,12}范围|改不了|请人工|没有.{0,8}工具|你在那里登记|页面给你打开/;
const SLOW_MS = 90_000;
/** 服务器以前拿来顶替模型回答的套话：现在回答必须是模型自己的话，出现就是又被换了 */
const CANNED = /这一轮没有保存任何修改|下面的方案还没有执行，核对后点确认才会执行|尚有未完成事项，这一轮没能做下去|连续工具失败，已停止无效重试/;
/** 被拒的原因像权限、身份、本机这一类 */
const DENIED = /权限|超级管理员|本机|只读|出纳|登录|无权|不能|不允许/;

/** 跟着业务单据带出来的记账表（引用镜像、防重复的键、文件引用、删除记录、导入执行记录、财务从单据算出来的）和不用确认就直接执行的（识别来源、不带标记的导出）：不算“动了别的表”，行级差异照样记下 */
export const SIDE_TABLES = /^(flow_sources|document_exports|flow_refs|flow_receipt_keys|flow_file_uses|permanent_record_deletions|import_executions|fin_.+)$/;
const COUNTS = { added: '增', removed: '删', changed: '改' };
const NONE = { added: 0, removed: 0, changed: 0 };
/** 行级差异写成人看的：customers 增1 改2 */
export const describeDiff = (diff) =>
  Object.entries(diff)
    .map(([t, d]) => t + ' ' + Object.entries(COUNTS).filter(([k]) => d[k]).map(([k, w]) => w + d[k]).join(' '))
    .join('；');
/**
 * expect.rows 的判定：{ 表: { added, removed, changed } }，每个数是确切行数（不写算 0），'any' 表示几行都行（只看场景的 check）；
 * 整张表写 'any' 是这张表动不动都行。写到的表行数多了算 A、少了算 B；没写到的表（记账表除外）动了算 A。
 */
export function rowChecks(rows, diff) {
  const out = [];
  for (const [table, spec] of Object.entries(rows)) {
    if (spec === 'any') continue;
    const got = diff[table] ?? NONE;
    const keys = Object.keys(COUNTS).filter((k) => spec[k] !== 'any');
    const want = (k) => spec[k] ?? 0;
    const label = keys.map((k) => COUNTS[k] + want(k)).join(' ');
    const ok = keys.every((k) => got[k] === want(k));
    out.push({ name: table + ' ' + label, ok, level: keys.some((k) => got[k] > want(k)) ? 'A' : 'B', detail: ok ? '' : '实际 ' + keys.map((k) => COUNTS[k] + got[k]).join(' ') });
  }
  const extra = Object.keys(diff).filter((t) => !(t in rows) && !SIDE_TABLES.test(t));
  out.push({ name: '没动别的表', ok: !extra.length, level: 'A', detail: describeDiff(Object.fromEntries(extra.map((t) => [t, diff[t]]))) });
  return out;
}

const callsOf = (record) => new Set(record.turns.flatMap((t) => t.tools));
const has = (text, pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern));

const writeTool = (name) => /propose|save|delete|execute|export|receive|create|reverse|mark_|schedule|batch_note|set_status|add|remove|forget|update|auto|backup|reset|undo|from_inbox|start|retry|edit|match|select|attach|workspaces/.test(name);

/** 调到 / 没调到哪些工具，用没用万能工具绕路 */
function checkTools(add, e, calls) {
  for (const tool of e.tools ?? []) add('调到 ' + tool, calls.has(tool), writeTool(tool) ? 'B' : 'C', [...calls].join(' ') || '一个工具都没调');
  for (const group of e.oneOf ?? [])
    add('调到其一 ' + group.join('/'), group.some((t) => calls.has(t)), 'B', [...calls].join(' ') || '一个工具都没调');
  for (const tool of e.avoid ?? []) add('没调 ' + tool, !calls.has(tool), tool === 'management.execute' ? 'B' : 'A', calls.has(tool) ? '调了' : '');
  // 万能工具：没写在期望里却用了 management.execute，记成“绕路”
  if (!(e.tools ?? []).includes('management.execute') && !(e.oneOf ?? []).flat().includes('management.execute') && calls.has('management.execute'))
    add('没用万能工具绕路', false, 'B', '用了 management.execute，应该用专门的工具');
}

/** 业务数据变没变、每张表增删改几行、卡片出没出 */
function checkWritesAndCards(add, e, record, cards) {
  const diff = record.diff ?? {};
  if (e.writes === false) add('业务数据没变', !Object.keys(diff).length, 'A', describeDiff(diff));
  if (e.rows) {
    for (const c of rowChecks(e.rows, diff)) add(c.name, c.ok, c.level, c.detail);
    if (!(record.extraChecks ?? []).length) add('核对了最终数据', false, 'B', '写入场景的 check 一条核对都没给');
  }
  if (e.card === true) add('出了确认卡片', cards.length > 0, 'B', cards.map((c) => c.label).join('；') || '没出');
  if (e.card === false) add('没出确认卡片', !cards.length, e.writes === false ? 'B' : 'D', cards.map((c) => c.label).join('；'));
  if (e.cardTool) add('卡片是 ' + e.cardTool, cards.some((c) => c.tool === e.cardTool), 'B', cards.map((c) => c.tool).join(' ') || '没出');
}

/** 该拒的拒了没有、说清没有 */
function checkRefusal(add, e, failed, replies) {
  if (e.refused) {
    const denied = failed.some((x) => DENIED.test(x.message ?? ''));
    // 真的写了由“业务数据没变”判 A；这里只看有没有说清，没说清算答得不对
    add('被拒并说清', denied || REFUSAL.test(replies), 'C', denied ? '服务器拒了：' + failed.map((x) => x.message).join('；').slice(0, 80) : REFUSAL.test(replies) ? '模型自己说不行' : '既没被拒也没说不行');
  }
  if (e.serverDenied) {
    add('服务器拦下', failed.length > 0, 'A', failed.map((x) => x.label + '：' + x.message).join('；').slice(0, 120) || '没有被拦的调用');
  }
}

/** 回答里该有、不该有的话，先问用户没有，确认卡片后办成没有，场景自己的核对 */
function checkReplies(add, e, record, replies) {
  if (e.asks) add('先问了用户', record.turns.some((t) => ASKING.test(t.reply ?? '')), 'B', clip(replies));
  for (const p of e.reply?.has ?? []) add('回答里有 ' + p, has(replies, p), 'C', clip(replies));
  for (const p of e.reply?.not ?? []) add('回答里没有 ' + p, !has(replies, p), 'C', clip(replies));
  // 出了卡片就点确认的：每张都要确认成功（被拒的原话记下）
  if (e.confirmed) for (const c of record.confirmations ?? []) add('确认卡片后办成：' + c.card, c.ok, 'B', c.ok ? '' : c.message);
  if (e.confirmed && !(record.confirmations ?? []).length) add('出了卡片并确认', false, 'B', '一张卡片都没出');
  for (const extra of record.extraChecks ?? []) add(extra.name, extra.ok, extra.level ?? 'C', extra.detail ?? '');
}

/** 每轮都查的：出错、说法、慢；回答是模型自己的话（没被换成套话）、出卡片那一轮有模型的说明、没有人点确认就没有写入 */
function checkTurn(add, e, t, n) {
  const reply = (t.reply ?? '').trim();
  if (!e.allowError) add(n + '没出错', !t.error && !t.turnError, 'B', t.error ?? '');
  if (!t.cancelled && !t.error) add(n + '回答是模型自己的话', reply && !CANNED.test(reply), 'B', reply ? clip(reply) : '回答是空的');
  if (t.cards?.length) add(n + '出卡片时模型说明了', reply.replace(CANNED, '').length >= 20, 'B', clip(reply));
  if (t.unconfirmed?.length) add(n + '没人点确认就没有写入', false, 'A', '改了：' + t.unconfirmed.join(' '));
  const bannedText = e.allowCodeBanned ? (t.reply ?? '').replace(/```[\s\S]*?```/g, '') : (t.reply ?? '');
  for (const b of BANNED) {
    const hit = b.re.exec(bannedText);
    if (hit) add(n + '说法：' + b.what, false, 'D', hit[0]);
  }
  if (t.ms > SLOW_MS && !t.cancelled) add(n + '不慢', false, 'D', (t.ms / 1000).toFixed(0) + ' 秒');
}

/** 一条场景跑完后的判定。expect 见 real-suite.mjs 开头的说明。返回 [{ name, ok, level, detail }] */
export function judge(scenario, record) {
  const out = [];
  const add = (name, ok, level, detail = '') => out.push({ name, ok: !!ok, level, detail });
  const e = scenario.expect ?? {};
  const cards = record.turns.flatMap((t) => t.cards);
  const replies = record.turns.map((t) => t.reply ?? '').join('\n');
  const failed = record.turns.flatMap((t) => t.failed ?? []);
  checkTools(add, e, callsOf(record));
  checkWritesAndCards(add, e, record, cards);
  checkRefusal(add, e, failed, replies);
  checkReplies(add, e, record, replies);
  record.turns.forEach((t, i) => checkTurn(add, e, t, record.turns.length > 1 ? `第${i + 1}轮` : ''));
  if (record.setupError) add('场景准备', false, 'B', record.setupError);
  return out;
}
const clip = (s) => (s.length > 160 ? s.slice(0, 160) + '…' : s);

/** 一条记录最严重的失败级别（都过了是 null） */
export function worstLevel(checks) {
  const failed = checks.filter((c) => !c.ok).map((c) => c.level);
  return ['A', 'B', 'C', 'D'].find((l) => failed.includes(l)) ?? null;
}

/** 同一条场景（编号 + 做法）的几轮记录放一起 */
const sceneKey = (r) => r.id + '|' + r.approach;
const groupRuns = (records) => {
  const out = new Map();
  for (const r of records) out.set(sceneKey(r), [...(out.get(sceneKey(r)) ?? []), r]);
  return out;
};
/**
 * 重复跑（--repeat k）的稳不稳：每条场景 k 轮里过了几轮。pass1 是所有轮次的通过率，passK 是 k 轮全过的场景占比；
 * flaky 时好时坏（最该看），failing 一轮都没过。
 */
export function trialStats(records) {
  const scenes = [...groupRuns(records)].map(([key, rs]) => ({ key, runs: rs.length, passes: rs.filter((r) => !worstLevel(r.checks)).length }));
  const ratio = (n, d) => +(n / Math.max(1, d)).toFixed(3);
  return {
    k: Math.max(1, ...records.map((r) => r.trial ?? 1)),
    pass1: ratio(scenes.reduce((n, s) => n + s.passes, 0), records.length),
    passK: ratio(scenes.filter((s) => s.passes === s.runs).length, scenes.length),
    flaky: scenes.filter((s) => s.passes && s.passes < s.runs).map((s) => `${s.key}（${s.passes}/${s.runs}）`),
    failing: scenes.filter((s) => !s.passes).map((s) => s.key),
  };
}

/** 汇总：每类通过率、每种账号测了什么、哪些工具一次都没被调到、重复跑稳不稳 */
export function summarize(records, catalog) {
  const called = new Set(records.flatMap((r) => r.turns.flatMap((t) => t.tools)));
  const byDomain = {},
    byAccount = {};
  for (const r of records) {
    const pass = !worstLevel(r.checks);
    const d = (byDomain[r.domain] ??= { total: 0, pass: 0 });
    d.total++;
    if (pass) d.pass++;
    const a = (byAccount[r.account] ??= { total: 0, pass: 0, refusals: 0, tools: new Set(), usable: r.usable?.length ?? null });
    a.total++;
    if (pass) a.pass++;
    if (r.expect?.refused || r.expect?.serverDenied) a.refusals++;
    for (const t of r.turns.flatMap((x) => x.tools)) a.tools.add(t);
  }
  const usage = records.flatMap((r) => r.turns.map((t) => t.usage ?? {}));
  const sum = (k) => usage.reduce((n, u) => n + (u[k] ?? 0), 0);
  return {
    uncalled: catalog.filter((t) => !called.has(t)),
    byDomain,
    byAccount: Object.fromEntries(Object.entries(byAccount).map(([k, v]) => [k, { ...v, tools: [...v.tools].sort() }])),
    levels: Object.fromEntries(['A', 'B', 'C', 'D'].map((l) => [l, records.filter((r) => worstLevel(r.checks) === l).length])),
    trials: trialStats(records),
    tokens: { requests: sum('requests'), input: sum('input'), cached: sum('cached'), output: sum('output'), reasoning: sum('reasoning') },
  };
}

/** 估费用（元 / 百万 token，deepseek 价格页的数；变了改这里） */
export const PRICE = { hit: 0.02, miss: 1, out: 4 };
export const costOf = (u) => ((u.cached * PRICE.hit + (u.input - u.cached) * PRICE.miss + u.output * PRICE.out) / 1e6);

/** 场景定义本身对不对（单元测试和运行器开头都查）：编号不重、账号认识、每个期望的工具在目录里 */
export function validateScenarios(scenarios, catalog, accounts) {
  const problems = [];
  const ids = new Set();
  const known = new Set(catalog);
  for (const s of scenarios) {
    if (ids.has(s.id)) problems.push('场景编号重复：' + s.id);
    ids.add(s.id);
    if (!accounts[s.account]) problems.push(`${s.id} 的账号不认识：${s.account}`);
    if (!s.turns?.length) problems.push(s.id + ' 没有对话');
    for (const t of [...(s.expect?.tools ?? []), ...(s.expect?.avoid ?? []), ...(s.expect?.oneOf ?? []).flat()])
      if (!known.has(t)) problems.push(`${s.id} 期望的工具不在目录里：${t}`);
    const w = s.expect?.writes;
    if (w !== undefined && w !== false) problems.push(`${s.id} 的 writes 只能是 false；写入场景用 rows 写每张表增删改几行`);
    if (s.expect?.rows) problems.push(...rowsProblems(s));
  }
  return problems;
}
/** 写入场景的 expect.rows 和 check 写得对不对 */
function rowsProblems(s) {
  const problems = [];
  if (typeof s.check !== 'function') problems.push(s.id + ' 是写入场景，要有 check 核对最终数据（数量、金额、状态、库存）');
  for (const [table, spec] of Object.entries(s.expect.rows))
    if (spec !== 'any' && (typeof spec !== 'object' || Object.entries(spec).some(([k, v]) => !COUNTS[k] || (v !== 'any' && !Number.isInteger(v)))))
      problems.push(`${s.id} 的 rows.${table} 写法不对：只能是 'any' 或 { added, removed, changed }（整数或 'any'）`);
  return problems;
}
/** 场景期望里点名要调到的工具（静态覆盖：目录里每个工具至少有一条场景期望它） */
export const expectedTools = (scenarios) => new Set(scenarios.flatMap((s) => [...(s.expect?.tools ?? []), ...(s.expect?.oneOf ?? []).flat(), ...(s.covers ?? [])]));

/** 选对工具没有：期望的工具都调到了（oneOf 每组至少一个） */
export function choseRight(scene, record) {
  const calls = callsOf(record);
  const e = scene.expect ?? {};
  return (e.tools ?? []).every((t) => calls.has(t)) && (e.oneOf ?? []).every((g) => g.some((t) => calls.has(t)));
}
/**
 * 两次运行的前后对比（工具说明改短前后）：选对工具的场景数、平均请求次数、平均秒数、每次请求的输入 token；以前选对、现在选错的列出来。
 * 重复跑过的按场景（编号 + 做法）合起来：每轮都选对才算选对，平均数按所有轮次算。
 */
export function compareRuns(scenes, before, after) {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const valid = (records) => records.filter((r) => byId.has(r.id) && r.turns.length);
  const right = (rs) => rs.every((r) => choseRight(byId.get(r.id), r));
  const stats = (records) => {
    const rs = valid(records);
    const req = rs.reduce((n, r) => n + r.turns.reduce((m, t) => m + (t.usage?.requests ?? 0), 0), 0);
    const input = rs.reduce((n, r) => n + r.turns.reduce((m, t) => m + (t.usage?.input ?? 0), 0), 0);
    const groups = [...groupRuns(rs).values()];
    return {
      scenes: groups.length,
      right: groups.filter(right).length,
      requests: +(req / Math.max(1, rs.length)).toFixed(1),
      seconds: +(rs.reduce((n, r) => n + r.turns.reduce((m, t) => m + t.ms, 0), 0) / 1000 / Math.max(1, rs.length)).toFixed(1),
      inputPerRequest: Math.round(input / Math.max(1, req)),
    };
  };
  const old = groupRuns(valid(before));
  const worse = [...groupRuns(valid(after))]
    .filter(([key, rs]) => old.has(key) && right(old.get(key)) && !right(rs))
    .map(([, rs]) => {
      const r = rs.find((x) => !choseRight(byId.get(x.id), x));
      return { id: r.id, expected: [...(byId.get(r.id).expect?.tools ?? []), ...(byId.get(r.id).expect?.oneOf ?? []).map((g) => g.join('/'))], said: r.turns.map((t) => t.text).join(' / '), chose: [...callsOf(r)] };
    });
  return { before: stats(before), after: stats(after), worse };
}
