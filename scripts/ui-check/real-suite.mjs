// 助手真实模型全量测试：连真实 DeepSeek，按领域跑场景，每条自动判定（调到的工具、业务库每张表增删改了几行、最终数据、卡片、拒绝、回答里的字），
// 最后打印每类通过率、每种账号测了什么、哪些工具一次都没被调到（应为空）、重复跑时稳不稳。场景在 real-scenes-*.mjs，判定在 real-suite-judge.mjs。
//
//   node scripts/ui-check/real-suite.mjs --list                       只列场景，不发请求
//   node scripts/ui-check/real-suite.mjs --start --fake               自己起两个测试实例（连假 DeepSeek）自测脚本，跑完关掉
//   node scripts/ui-check/real-suite.mjs --start --yes                自己起两个真实模型实例跑（会花钱），跑完关掉
//   --only access,gate               只跑这几个领域（access gate tools flows files context memory diagnose web quality longctx）
//   --scenarios G1,G2 或 --scenarios G   只跑这几条（写前缀就是这一组）
//   --approaches high,low  思考档位（默认 high；另有 low、off、max）
//   --repeat 3                            同一批场景跑 3 轮，每轮重新起实例（种子一样、互不污染），报 3 轮全过的比例；只能和 --start 一起用
//   --local 3196 --remote 3194            两个实例的端口：本机管理员模式、模拟从域名访问（--start 时就用这两个端口起）
//   --local-data 目录 --remote-data 目录    不用 --start 时，传实例 READY 行里的 data= 目录（判数据变没变要读它）
//   --out 目录                            结果放哪（默认系统临时目录下 erp-real-suite-时间）
//   --rejudge 目录                        按现在的判定重判一批已有的结果，不发请求（改了场景的 rows、check 后用）
// 账号：本机管理员、从域名访问的超级管理员（进 / 不进模式）、业务员、只读、财务（开头现建）、出纳，见 real-suite-client.mjs。
// 只走 HTTP 和实例临时目录里的虚构库；不读密钥。连真实 DeepSeek 时必须带 --yes。
//
// 场景写法（每个 real-scenes-*.mjs 导出 scenes 数组）：
//   { id, domain, account, title, look（人看的要点）, approaches?（固定做法）,
//     setup?(ctx) → vars, turns: [文字 | (ctx)=>文字 | { say, attach: ['orderXlsx'…], thinking, confirm, policy, cancel, as, newThread }],
//     expect: { tools, oneOf, avoid, writes: false, rows: { 表: { added, removed, changed } | 'any' }, card, cardTool, refused, serverDenied, asks, reply: { has, not }, allowError },
//     check?(ctx, record) → [{ name, ok, level, detail }] }
//   写入场景必须写 rows（每张表增删改几行，没写的表不许动）和 check（最终的数量、金额、状态、库存），判定见 real-suite-judge.mjs 的 rowChecks。
// ctx：{ s 场景账号的会话, admin 同一实例的管理员会话, q(sql,…) 查虚构库, vars, thread, record, files }
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, FINANCE_ACCOUNT, Session, query, rowDiff, rowSnapshot, runUsage, startPreview, stopPreviews, turnRecord } from './real-suite-client.mjs';
import { compareRuns, costOf, judge, summarize, validateScenarios, worstLevel } from './real-suite-judge.mjs';
import { FILES } from './real-suite-files.mjs';
import { loadScenes } from './real-scenes.mjs';
import { toolListChecks } from './real-scenes-kit.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
export const APPROACHES = {
  high: { thinking: 'high' },
  low: { thinking: 'low' },
  off: { thinking: 'off' },
  max: { thinking: 'max' },
};
const scenes = await loadScenes();
// 前后对比两批结果（比如工具说明改短前后）：--compare 旧目录 新目录 [--only tools]
const loadRecords = (dir) => readFileSync(join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
if (option('--compare')) {
  const load = (dir) => loadRecords(dir).filter((r) => !option('--only') || option('--only').split(',').includes(r.domain));
  const i = args.indexOf('--compare');
  const c = compareRuns(scenes, load(args[i + 1]), load(args[i + 2]));
  console.log('| | 场景数 | 选对工具 | 平均请求次数 | 平均秒数 | 每次请求输入 token |\n|---|---|---|---|---|---|');
  for (const [k, v] of [['改前', c.before], ['改后', c.after]]) console.log(`| ${k} | ${v.scenes} | ${v.right} | ${v.requests} | ${v.seconds} | ${v.inputPerRequest} |`);
  console.log('\n以前选对、现在选错的：');
  for (const w of c.worse) console.log(`- ${w.id}：期望 ${w.expected.join(' ')}；原话「${w.said}」；选成了 ${w.chose.join(' ') || '没调工具'}`);
  process.exit(0);
}
// 只按现在的判定重判一批已有的结果（records.jsonl），不发请求。行级差异（diff）是后来加的，没有它的旧记录判不了写入，不重判
if (option('--rejudge')) {
  const old = loadRecords(option('--rejudge')).filter((r) => r.diff);
  const byId = new Map(scenes.map((s) => [s.id, s]));
  for (const r of old) if (byId.has(r.id) && r.turns.length) r.checks = judge(byId.get(r.id), r);
  writeFileSync(join(option('--rejudge'), 'records-rejudged.jsonl'), old.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const r of old) console.log((worstLevel(r.checks) ? '✗' + worstLevel(r.checks) : '✓ ') + ' ' + r.id.padEnd(8) + ' ' + r.checks.filter((c) => !c.ok).map((c) => `[${c.level}]${c.name}`).join('；'));
  process.exit(0);
}

if (args.includes('--list')) {
  for (const s of scenes) console.log(`${s.id.padEnd(8)} ${s.domain.padEnd(9)} ${ACCOUNTS[s.account]?.label.padEnd(12) ?? s.account} ${s.title}：${s.look ?? ''}`);
  console.log(`共 ${scenes.length} 条`);
  process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const ports = { local: option('--local', '3196'), remote: option('--remote', '3194') };
const dirs = { local: option('--local-data'), remote: option('--remote-data') };
const only = option('--only')?.split(',');
const picks = option('--scenarios')?.split(',');
const approaches = option('--approaches', 'high').split(',');
for (const a of approaches) if (!APPROACHES[a]) throw new Error('没有这个做法：' + a);
const repeat = Number(option('--repeat', '1'));
if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat 要写正整数');
const starting = args.includes('--start');
if (repeat > 1 && !starting) throw new Error('--repeat 每轮要重新起实例，只能和 --start 一起用');
const out = option('--out', join(tmpdir(), 'erp-real-suite-' + new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(out, { recursive: true });
const chosen = scenes.filter((s) => (!only || only.includes(s.domain)) && (!picks || picks.some((p) => s.id === p || (s.id.startsWith(p) && !/\d$/.test(p)))));
const needed = [...new Set(chosen.map((s) => ACCOUNTS[s.account].instance))];

const sessions = new Map();
/** instance 不给就用这个账号默认的实例（换账号的那几条要在同一个实例上换） */
async function session(account, fresh = false, instance = ACCOUNTS[account].instance) {
  const key = account + '@' + instance;
  if (!fresh && sessions.has(key)) return sessions.get(key);
  const a = ACCOUNTS[account];
  const s = await new Session('http://127.0.0.1:' + ports[instance], a, dirs[instance]).login();
  sessions.set(key, s);
  return s;
}
const adminOf = (instance) => session(instance === 'local' ? 'local' : 'remote');

/** 不用确认就能直接执行、会动到业务库的：识别送货单记的识别来源、不带标记的导出记录 */
const DIRECT_TABLES = ['flow_sources', 'document_exports'];
const records = [];
let trial = 1;
function keep(record) {
  record.trial = trial;
  records.push(record);
  appendFileSync(join(out, 'records.jsonl'), JSON.stringify(record) + '\n');
  const level = worstLevel(record.checks);
  const failed = record.checks.filter((c) => !c.ok).map((c) => `[${c.level}]${c.name}${c.detail ? '（' + c.detail.slice(0, 60) + '）' : ''}`);
  const u = record.turns.reduce((t, x) => ({ input: t.input + (x.usage?.input ?? 0), cached: t.cached + (x.usage?.cached ?? 0), output: t.output + (x.usage?.output ?? 0) }), { input: 0, cached: 0, output: 0 });
  console.log([level ? '✗' + level : '✓ ', ...(repeat > 1 ? ['第' + trial + '轮'] : []), record.id.padEnd(8), record.approach.padEnd(11), ACCOUNTS[record.account].label.slice(0, 10).padEnd(10), record.title.slice(0, 22).padEnd(22),
    (record.turns.reduce((n, t) => n + t.ms, 0) / 1000).toFixed(0) + '秒', '工具 ' + ([...new Set(record.turns.flatMap((t) => t.tools))].join(' ') || '无'), '约' + costOf(u).toFixed(3) + '元', failed.join('；')].join(' | '));
}

/** 一句话里带的附件先传上去，返回传成功的附件编号 */
async function uploadAttachments(speaker, turn, ctx, record) {
  const attachmentIds = [];
  for (const f of turn.attach ?? []) {
    const file = typeof f === 'function' ? await f(ctx) : await FILES[f](ctx.vars);
    const up = await speaker.upload(ctx.thread, file.name, file.bytes);
    record.uploads.push({ name: file.name, size: up.size, ok: up.ok, status: up.status, message: up.message });
    if (up.ok) attachmentIds.push(up.id);
  }
  return attachmentIds;
}

/** 删除卡片上改“库存怎么处理” */
async function applyPolicy(speaker, turn, t, record) {
  for (const card of t.cards.filter((c) => c.destructive)) {
    const r = await speaker.inventoryPolicy(card, turn.policy);
    if (r.ok) Object.assign(card, { args: r.body?.args ?? card.args });
    record.confirmations.push({ card: card.label, action: '改库存处理：' + turn.policy, ok: r.ok, message: r.message });
  }
}

/** 像人在浏览器里那样把导出的单据下载下来（交付完成后才标已订货、出库） */
async function keepDownload(speaker, record, exportId) {
  record.downloads = [...(record.downloads ?? []), { exportId, ...(await speaker.download(exportId)) }];
}

const decisionOf = (turn) => (turn.confirm ? 'confirmed' : turn.reject ? 'rejected' : null);
const continuationText = (stale, sent, card) =>
  '（' + (stale ? '卡片作废' : sent === 'confirmed' ? '确认' : '不执行') + '：' + card.label + '，接着办）';

/** 人在卡片上点确认（confirm）或不执行（reject），再像页面那样发一条“接着办”，模型拿到结果接着说；那一轮也记下来 */
async function decideCards({ speaker, ctx, record, instance }, turn, t) {
  const decision = decisionOf(turn);
  let seen = t.viewCount;
  // confirm: 'chain' 时，确认后模型在“接着办”里又出的卡片也接着点（像人一路点下去），最多再点三轮
  const queue = decision ? t.cards.filter((c) => c.state === 'waiting') : [];
  // 出卡片之后、点确认之前，场景可以动一下数据（看作废的卡片拦不拦）
  if (queue.length) await turn.beforeConfirm?.(ctx, t);
  let most = queue.length + (turn.confirm === 'chain' ? 3 : 0);
  for (let rounds = 0; queue.length && rounds < most; rounds++) {
    const card = queue.shift();
    const r = decision === 'confirmed' ? await speaker.confirm(card) : await speaker.reject(card);
    record.confirmations.push({ card: card.label, tool: card.tool, decision, ok: r.ok, status: r.status, code: r.code, message: r.message });
    if (r.exportId) await keepDownload(speaker, record, r.exportId);
    // 出卡片以后数据变了、卡片被作废：页面会把它当“不执行”交回助手，让它按最新数据重新出一张
    const stale = !r.ok && r.code === 'card-stale';
    if (!r.ok && !stale) continue;
    const sent = stale ? 'rejected' : decision;
    const next = await speaker.say(ctx.thread, '', { card: { id: card.id, decision: sent } });
    const cont = turnRecord(continuationText(stale, sent, card), next, runUsage(dirs[instance], next.requestId), seen);
    seen = cont.viewCount;
    record.turns.push({ ...cont, continuation: true });
    // 作废后助手重新出的卡片也点（再点一轮）
    if (stale) most += 1;
    if (turn.confirm === 'chain' || stale) queue.push(...cont.cards.filter((c) => c.state === 'waiting'));
  }
}

/** 场景里的一句话：换人或换会话、传附件、说话并记下这一轮、改库存处理、点卡片、下载导出。run.speaker 换人时跟着换 */
async function runTurn(raw, run, approach) {
  const { ctx, record, instance } = run;
  const turn = typeof raw === 'object' ? raw : { say: raw };
  if (turn.as) {
    run.speaker = await ctx.session(turn.as);
    ctx.thread = await run.speaker.newThread();
  } else if (turn.newThread) ctx.thread = await run.speaker.newThread();
  if (turn.pause) await new Promise((r) => setTimeout(r, turn.pause));
  const attachmentIds = await uploadAttachments(run.speaker, turn, ctx, record);
  if (turn.uploadOnly) return;
  const text = typeof turn.say === 'function' ? turn.say(ctx) : turn.say;
  const thinking = turn.thinking ?? approach.thinking;
  const pre = rowSnapshot(dirs[instance]);
  const said = await run.speaker.say(ctx.thread, text, { ...(thinking ? { thinking } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) }, turn.cancel);
  const t = turnRecord(text, said, runUsage(dirs[instance], said.requestId));
  // 没有人点确认就不该有任何写入：这一句说完、点确认之前，业务表除了直接执行也算数的那几张（识别来源、不带标记的导出）都不该变
  t.unconfirmed = Object.keys(rowDiff(pre, rowSnapshot(dirs[instance]))).filter((x) => !DIRECT_TABLES.includes(x));
  record.turns.push(t);
  if (turn.policy) await applyPolicy(run.speaker, turn, t, record);
  await decideCards(run, turn, t);
  // 不带标记的导出直接生成文件：也像人那样下载
  for (const e of t.exports.filter((x) => x.exportId)) await keepDownload(run.speaker, record, e.exportId);
  await turn.after?.(ctx, t);
}

async function runScene(scene, approachKey) {
  const approach = APPROACHES[approachKey];
  const instance = ACCOUNTS[scene.account].instance;
  const admin = await adminOf(instance);
  if (scene.session) await admin.smoke('agent', { session: scene.session });
  const s = await session(scene.account, ACCOUNTS[scene.account].superMode); // 超级管理员模式 15 分钟过期，每条重新进
  const ctx = { s, admin, dataDir: dirs[instance], q: (sql, ...p) => query(dirs[instance], sql, ...p), vars: {}, files: FILES, session: (account) => session(account, false, instance) };
  const record = { id: scene.id, domain: scene.domain, account: scene.account, approach: approachKey, title: scene.title, look: scene.look, expect: scene.expect, turns: [], uploads: [], confirmations: [] };
  try {
    ctx.vars = (await scene.setup?.(ctx)) ?? {};
  } catch (e) {
    record.setupError = e.message;
  }
  ctx.thread = await s.newThread();
  ctx.record = record;
  const before = rowSnapshot(dirs[instance]);
  const run = { speaker: s, ctx, record, instance };
  for (const raw of record.setupError ? [] : scene.turns) await runTurn(raw, run, approach);
  if (scene.session) await admin.smoke('agent', { session: null });
  record.diff = rowDiff(before, rowSnapshot(dirs[instance]));
  try {
    record.extraChecks = (await scene.check?.(ctx, record)) ?? [];
  } catch (e) {
    record.extraChecks = [{ name: '场景自己的核对', ok: false, level: 'B', detail: '核对时出错：' + e.message }];
  }
  record.checks = judge(scene, record);
  keep(record);
}

// —— 一轮：起实例（--start 时自己起、跑完关；否则连已经起好的）、每个实例的管理员会话和财务账号、工具清单、全部场景。返回这一轮向模型发的请求数 ——
let fakeMode = null,
  catalog = null;
/** 每个实例：密钥保存了没有、记下开头的请求数、建好财务账号。返回 { 实例: 开头的请求数 } */
async function prepareInstances() {
  const startCalls = {};
  for (const k of needed) {
    const admin = await adminOf(k);
    const count = await admin.smoke('count');
    if (!count.hasKey) throw new Error(`${k} 实例还没保存 DeepSeek 密钥：在它的 设置 → API 配置 里填好再跑`);
    fakeMode = count.fake;
    startCalls[k] = count.calls;
    const maker = k === 'remote' ? await session('remote-super', true) : admin;
    const made = await maker.request('/api/auth/users', { name: FINANCE_ACCOUNT.name, password: FINANCE_ACCOUNT.password, level: FINANCE_ACCOUNT.level });
    if (!made.ok && made.status !== 409) throw new Error('建财务账号失败：' + made.message);
  }
  return startCalls;
}
/** 第一轮：连真实模型要有 --yes；读工具目录，查场景定义 */
async function loadCatalog() {
  if (!fakeMode && !args.includes('--yes')) {
    console.log(`会调用真实 DeepSeek 并产生费用（${chosen.length} 条场景 × ${approaches.length} 种做法 × ${repeat} 轮）。确认要跑就加 --yes。`);
    process.exit(2);
  }
  console.log(`${fakeMode ? '连的是假 DeepSeek（自测）' : '连的是真实 DeepSeek'}；${chosen.length} 条场景 × ${approaches.length} 种做法 × ${repeat} 轮；结果写到 ${out}`);
  catalog = (await (await adminOf(needed.includes('local') ? 'local' : 'remote')).api('/api/assistant/tools')).tools.map((t) => t.name);
  const problems = validateScenarios(scenes, catalog, ACCOUNTS);
  if (problems.length) throw new Error('场景定义有问题：\n' + problems.join('\n'));
}
/** 账号的工具清单（不用发请求）：清单里不该有它用不了的 */
async function keepToolLists() {
  for (const account of Object.keys(ACCOUNTS)) {
    if (only && !only.includes('access')) break;
    if (!needed.includes(ACCOUNTS[account].instance)) continue;
    const usable = await (await session(account)).usableTools();
    keep({ id: 'T-' + account, domain: 'access', account, approach: '-', title: '工具清单', usable, turns: [], diff: {}, checks: toolListChecks(account, usable) });
  }
}
/** 两个实例各一队，同时跑；同一实例里按顺序（做法开关是整个实例的，行快照也要前后对得上） */
async function runQueues() {
  const queues = { local: [], remote: [] };
  // 场景自己定了思考档位的（思考档位那几条）按它的，其余按 --approaches
  for (const s of chosen) for (const a of s.approaches ?? approaches) queues[ACCOUNTS[s.account].instance].push([s, a]);
  await Promise.all(Object.values(queues).map(async (queue) => {
    for (const [s, a] of queue)
      await runScene(s, a).catch((e) => keep({ id: s.id, domain: s.domain, account: s.account, approach: a, title: s.title, turns: [], diff: {}, checks: [{ name: '运行', ok: false, level: 'B', detail: '脚本出错：' + e.message }] }));
  }));
}
async function runTrial() {
  sessions.clear();
  if (starting)
    for (const k of needed) dirs[k] = await startPreview({ root, port: ports[k], remote: k === 'remote', fake: args.includes('--fake'), log: join(out, `instance-${k}-${trial}.log`) });
  for (const k of needed) if (!dirs[k]) throw new Error(`没给 ${k} 实例的 data 目录：加 --${k}-data，或用 --start 让脚本自己起`);
  const startCalls = await prepareInstances();
  if (!catalog) await loadCatalog();
  await keepToolLists();
  await runQueues();
  let requests = 0;
  for (const k of needed) requests += (await (await adminOf(k)).smoke('count')).calls - startCalls[k];
  if (starting) stopPreviews();
  return requests;
}

let requests = 0;
for (; trial <= repeat; trial++) requests += await runTrial();
const summary = summarize(records, catalog);
summary.requests = requests;
summary.cost = costOf(summary.tokens).toFixed(2);
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('\n—— 每类通过率 ——');
for (const [d, v] of Object.entries(summary.byDomain)) console.log(`${d.padEnd(10)} ${v.pass}/${v.total}`);
console.log('—— 失败按最严重级别 ——  A 改错数据或越权 ' + summary.levels.A + '，B 办不成 ' + summary.levels.B + '，C 答错或编造 ' + summary.levels.C + '，D 啰嗦慢说法 ' + summary.levels.D);
console.log('—— 每种账号 ——');
for (const [a, v] of Object.entries(summary.byAccount)) console.log(`${ACCOUNTS[a].label.padEnd(16)} 场景 ${v.pass}/${v.total}，其中拒绝类 ${v.refusals}，调到的工具 ${v.tools.length} 个：${v.tools.join(' ')}`);
console.log(`—— 一次都没被调到的工具（${summary.uncalled.length} 个，应为空）——\n${summary.uncalled.join(' ') || '（无）'}`);
if (repeat > 1) {
  const t = summary.trials;
  console.log(`—— 重复跑 ${t.k} 轮 —— 每轮通过率 pass^1 ${t.pass1}，${t.k} 轮全过 pass^${t.k} ${t.passK}`);
  console.log(`时好时坏（最该看）：${t.flaky.join('、') || '（无）'}\n一轮都没过：${t.failing.join('、') || '（无）'}`);
}
console.log(`\n向 DeepSeek 共发 ${requests} 次请求；输入 ${summary.tokens.input}（命中 ${summary.tokens.cached}）输出 ${summary.tokens.output}（思考 ${summary.tokens.reasoning}）；估约 ${summary.cost} 元。详细：${out}`);
stopPreviews();
process.exit(0);
