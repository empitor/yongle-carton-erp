/**
 * 一件事一条链路（AGENTS.md）的自动检查之一：业务动作登记（shared/assistant/ui-actions.ts）对服务端的写地址和助手的写入命令。
 * - 服务端每个写地址（POST、PUT、PATCH、DELETE，装一遍应用取出来的）正好属于一条动作（写地址或预览地址）；登记了却没有路由的也拦。
 * - 同一种记录上同一个动作只许一条：再长出第二个“登记到货”地址就失败。一时合不了的登记在 knownDuplicates，写明原因。
 * - 会写库的助手命令都挂在动作上，实现命令的文件里出现这条动作登记的服务函数名（界面和助手走同一个服务）。
 * 前端只许一个文件发同一个写地址见 feature-links-senders.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { uiActions, type UiAction } from '../shared/assistant/ui-actions.js';
import { uiCapabilities } from '../shared/assistant/ui-capabilities.js';
import { toolCatalog } from '../server/assistant/tool-catalog.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { WORKFLOW_WRITES } from '../server/assistant/chat/workflow-cards.js';
import { WORKFLOW_DIRECT } from '../server/assistant/chat/workflow-direct.js';
import { serverRouteList } from './server-routes.js';
import { isWriteMethod, routeKey } from './feature-links-pending.js';

/** 同一种记录同一个动作有两条、一时合不了的：哪条记录、哪个动作、在哪、为什么还没合。合掉了要删，不然测试提醒 */
const knownDuplicates: { record: string; verb: string; where: string; why: string }[] = [];

/**
 * 写了命令名的文件里没有直接调登记的服务、而是调另一个文件里的函数：命令文件里出现 via，via 所在的 file 里出现服务函数名。
 * 只给“一次办几条、逐条调同一个服务”的包装和“命令表、实现分在两个文件”用，写明原因。
 */
const toolVia: { tool: string; via: string; file: string; why: string }[] = [
  {
    tool: 'chat.delete',
    via: 'deleteThreads',
    file: 'server/assistant/conversation.ts',
    why: '助手一次删几个会话（可带上当前会话），逐个调和页面“删除会话”同一个 removeThread',
  },
  {
    tool: 'order_import.from_inbox',
    via: 'fromInbox',
    file: 'server/assistant/order-import-intake.ts',
    why: '命令表在 order-workflow.ts，实现 fromInbox 在 order-import-intake.ts，调和页面“转订单”同一个 InboxService.toImport',
  },
  {
    tool: 'order_import.start',
    via: 'start',
    file: 'server/assistant/order-import-prepare.ts',
    why: '命令表在 order-workflow.ts，start（order-import-intake.ts）→ recognize（order-import-prepare.ts）调和页面“重新识别”同一个 ImportManager.analyze',
  },
  {
    tool: 'order_import.retry',
    via: 'recognize',
    file: 'server/assistant/order-import-prepare.ts',
    why: '同上：retry 在 order-import-edits.ts 调 recognize，再调 ImportManager.analyze',
  },
];

const methodName = (service: string) => service.split('.').at(-1) ?? service;
const word = (name: string) => new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])');
const segs = (path: string) => path.split('/').filter(Boolean);
/** 登记里的 :kind 代表路由里写死的几种段（三种提示词），:id 只对路由的变量段 */
const covers = (pattern: string, key: string) => {
  const [pm, pp] = pattern.split(' '),
    [km, kp] = key.split(' ');
  const a = segs(pp),
    b = segs(kp);
  return pm === km && a.length === b.length && a.every((s, i) => s === b[i] || (s === ':kind' && !b[i].startsWith(':')));
};
const addresses = (a: UiAction) => [...(a.api ? [a.api] : []), ...(a.previews ?? [])];
const label = (a: UiAction) => a.record + '·' + a.verb;

const routes = serverRouteList();
const routeKeys = new Set(routes.map(routeKey));
const writeKeys = [...new Set(routes.filter((r) => isWriteMethod(r.method)).map(routeKey))];

test('业务动作登记：字段写全，能力表里有这一项，命令在工具目录里，写地址写法统一', () => {
  const capabilityIds = new Set<string>(uiCapabilities.map((c) => c.id));
  const tools = new Set(toolCatalog.map((t) => t.name));
  const bad: string[] = [];
  for (const a of uiActions) {
    if (!capabilityIds.has(a.capability)) bad.push(label(a) + '：能力表里没有 ' + a.capability);
    if (!a.record || !a.verb || !a.service) bad.push(label(a) + '：记录、动作、服务要写全');
    if (a.api !== null && !/^(POST|PUT|PATCH|DELETE) \/\S*$/.test(a.api)) bad.push(label(a) + '：写地址写成“方法 /地址”：' + a.api);
    if (a.api === null && !(a.note && a.tools?.length)) bad.push(label(a) + '：没有写地址的只能是助手独有的事，要写命令和原因');
    for (const p of a.previews ?? []) if (!/^(GET|POST) \/\S*$/.test(p)) bad.push(label(a) + '：预览地址写成“方法 /地址”：' + p);
    for (const t of a.tools ?? []) if (!tools.has(t)) bad.push(label(a) + '：工具目录里没有命令 ' + t);
  }
  assert.deepEqual(bad, []);
});

test('写地址都登记、不重复：服务端每个写地址正好属于一条动作，登记的地址都有路由', () => {
  const bad: string[] = [];
  for (const key of writeKeys) {
    const exact = uiActions.filter((a) => addresses(a).includes(key));
    const owners = exact.length ? exact : uiActions.filter((a) => addresses(a).some((p) => covers(p, key)));
    if (owners.length !== 1)
      bad.push(key + (owners.length ? ' 属于 ' + owners.length + ' 条动作：' + owners.map(label).join('、') : ' 没有登记在哪条动作上'));
  }
  for (const a of uiActions)
    for (const p of addresses(a))
      if (![...routeKeys].some((k) => k === p || covers(p, k))) bad.push(label(a) + ' 登记的 ' + p + ' 服务端没有这个路由');
  assert.deepEqual(bad, []);
});

test('认路由认得接口表的写法：route() 注册的写地址照样要登记在动作上，注册文件算调 route() 的文件', () => {
  const records = routes.filter((r) => r.file === 'server/business/records-router.ts').map(routeKey);
  for (const key of ['GET /customers', 'PUT /customers/:id', 'POST /orders/:id/cancel', 'POST /stock_items/batch'])
    assert.ok(records.includes(key), 'records-router.ts 用 route() 注册的 ' + key + ' 没认出来');
  assert.ok(writeKeys.includes('PUT /customers/:id'), '“写地址都登记”那条查的写地址里要有 route() 注册的');
  assert.deepEqual(routes.filter((r) => r.file === 'server/core/route.ts'), [], '注册文件不能算成 route() 自己');
});

test('同一种记录上同一个动作只有一条（已知两套的除外，合掉了要删登记）', () => {
  const seen = new Map<string, number>();
  for (const a of uiActions) seen.set(label(a), (seen.get(label(a)) ?? 0) + 1);
  const known = new Set(knownDuplicates.map((d) => d.record + '·' + d.verb));
  assert.deepEqual([...seen].filter(([k, n]) => n > 1 && !known.has(k)).map(([k, n]) => k + ' 有 ' + n + ' 条'), []);
  assert.deepEqual([...known].filter((k) => (seen.get(k) ?? 0) < 2), [], '已知两套已经合掉了，删掉登记');
});

/** 实现一个命令的文件：server/assistant 下写了 '命令名' 的文件（工具目录、分组、命令目录、注册表这几张名单不算） */
const listFiles = new Set(['tool-catalog.ts', 'plugins.ts', 'command-directory.ts', 'tool-registry.ts']);
const assistantFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? assistantFiles(dir + '/' + e.name) : /\.ts$/.test(e.name) && !listFiles.has(e.name) ? [dir + '/' + e.name] : [],
  );
const sources = assistantFiles('server/assistant').map((f) => [f, readFileSync(f, 'utf8')] as const);
const implementing = (tool: string) => sources.filter(([, text]) => text.includes("'" + tool + "'"));

test('助手和界面同一个服务：会写库的助手命令都挂在动作上，命令的实现里调的是这条动作登记的服务', () => {
  const registry = new AssistantToolRegistry(':memory:', () => true);
  const kinds = new Map(registry.view().tools.map((t) => [t.name, t.kind]));
  registry.close();
  // 会写库的：业务类（都出卡片）、登记成写入的流程类、直接执行但会改东西的流程类（记忆、识别结果）
  const writes = new Set(
    toolCatalog
      .map((t) => t.name)
      .filter((n) => kinds.get(n) === 'business' || Object.hasOwn(WORKFLOW_WRITES, n) || !!WORKFLOW_DIRECT[n]?.does),
  );
  const bad: string[] = [];
  const attached = new Set(uiActions.flatMap((a) => a.tools ?? []));
  for (const t of writes) if (!attached.has(t)) bad.push(t + ' 会写库，没挂在任何一条动作上');
  for (const a of uiActions)
    for (const t of a.tools ?? []) {
      if (!writes.has(t)) bad.push(label(a) + '：' + t + ' 不写库，不挂在动作上');
      const files = implementing(t),
        name = methodName(a.service),
        via = toolVia.find((v) => v.tool === t);
      if (!files.length) bad.push(t + '：server/assistant 下找不到实现它的文件');
      else if (via) {
        if (!files.some(([, text]) => word(via.via).test(text))) bad.push(t + '：实现里没有登记的 ' + via.via);
        if (!word(name).test(readFileSync(via.file, 'utf8'))) bad.push(t + '：' + via.file + ' 里没有 ' + name);
      } else if (!files.some(([, text]) => word(name).test(text)))
        bad.push(label(a) + '：' + t + ' 的实现（' + files.map(([f]) => f).join('、') + '）里没有 ' + a.service);
    }
  for (const v of toolVia) if (!uiActions.some((a) => a.tools?.includes(v.tool))) bad.push('经由登记的 ' + v.tool + ' 已经不挂在动作上，删掉');
  assert.deepEqual(bad, []);
});

test('登记的服务函数真有：注册写地址的文件或它所在的模块目录里写着这个名字', () => {
  const files = new Map(routes.map((r) => [routeKey(r), r.file]));
  const dirText = new Map<string, string>();
  const textOf = (dir: string) =>
    dirText.get(dir) ??
    dirText
      .set(dir, readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(dir + '/' + f, 'utf8')).join('\n'))
      .get(dir) ??
    '';
  const bad: string[] = [];
  for (const a of uiActions) {
    if (!a.api) continue;
    const key = [...files.keys()].find((k) => k === a.api || covers(a.api ?? '', k));
    const file = key ? files.get(key) : undefined;
    if (!file) continue; // 没有路由的上一条测试报
    const name = methodName(a.service);
    if (!word(name).test(readFileSync(file, 'utf8')) && !word(name).test(textOf(file.slice(0, file.lastIndexOf('/')))))
      bad.push(label(a) + '：' + file + ' 和它的目录里都没有 ' + a.service);
  }
  assert.deepEqual(bad, []);
});
