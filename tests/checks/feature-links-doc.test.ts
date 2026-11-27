// 拦：手写的功能链路表（docs/功能/功能链路-*.md 六份）和代码脱节——表里的 #页面 没登记或带了这页不认的参数、助手工具列写了工具目录里没有的名字、
// 后端地址（连同写了的请求方法）在服务端没有这条路由；反过来，登记的页面、工具目录里的工具没写进任何一份链路表。
// 地址缩写（a|b、{a|b}、括号里接在后面的 /x、“同四个”、<名字>）照技能 add-feature“功能链路表”展开。
// 地址列、工具列按表头文字（“后端地址”“助手工具”）找，不按第几格；每张表至少读到一条地址，列挪了、表头改了名会报错而不是空转。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flowKinds, isPageHref, pageIdOf, pageIds, pageParams } from '../../shared/core/index.js';
import { promptModules } from '../../shared/ai/index.js';
import { toolCatalog } from '../../server/assistant/tool-catalog.js';
import { hasRouteUnder, serverRouteList } from './server-routes.js';

const files = ['档案和订单', '库存和单据', '识别导入', '财务', '账号设置系统', '助手'].map(
  (n) => `docs/功能/功能链路-${n}.md`,
);

/** 地址里 <名字> 写的段：路由是一个一个写死的、不是 :变量，按这里列的逐个展开；没登记的 <名字> 当 :变量 查 */
const named: Record<string, { values: readonly string[]; why: string }> = {
  模块: {
    values: promptModules.map((m) => m.id),
    why: '每个提示词模块挂在自己的地址下（shared/ai/prompt-modules.ts 的 apiPath），表里写一行 <模块> 代替三行',
  },
};
/** 路由的 :变量 段表里写成具体的词的：哪条路由（变量段统一写 :id）、认哪些词、为什么 */
const literalParams: { route: string; values: readonly string[]; why: string }[] = [
  {
    route: 'POST /flow/:id',
    values: flowKinds,
    why: '建单据是 POST /flow/:kind 一条路由按种类分，表里照功能写成 /flow/task、/flow/delivery、/flow/arrival 更好找',
  },
];

/** 一行表格：哪份、第几行、各格（\| 已还原成 |） */
type Row = { file: string; line: number; cells: string[] };
/** 一张表：表头在哪一行、地址列表头写的前缀（“后端地址（`/finance` 下）”）、地址列和工具列是第几格、各行 */
type Table = { file: string; line: number; prefix: string; address: number; tool: number; rows: Row[] };

const cellsOf = (text: string) => text.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isDivider = (text: string | undefined) => /^\|(?:\s*:?-+:?\s*\|)+$/.test(text?.trim() ?? '');

/** 读一份链路表里的表格：下一行是 |---| 的是表头，按表头文字找“后端地址”“助手工具”在第几格；找不到、或有不在表里的行就报错 */
function parseTables(file: string, text: string): Table[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Table[] = [];
  let current: Table | undefined;
  lines.forEach((line, i) => {
    if (!line.startsWith('|')) current = undefined;
    else if (isDivider(lines[i + 1])) {
      const cells = cellsOf(line);
      const address = cells.findIndex((c) => c.startsWith('后端地址'));
      const tool = cells.indexOf('助手工具');
      if (address < 0 || tool < 0) throw new Error(`${file}:${i + 1} 表头没有“后端地址”或“助手工具”列：链路表每张表都要有这两列`);
      current = { file, line: i + 1, prefix: /`(\/[^`]+)` 下/.exec(cells[address])?.[1] ?? '', address, tool, rows: [] };
      out.push(current);
    } else if (!isDivider(line)) {
      if (!current) throw new Error(`${file}:${i + 1} 这一行不在任何一张表里：表头下面要有 |---| 一行`);
      current.rows.push({ file, line: i + 1, cells: cellsOf(line) });
    }
  });
  return out;
}
const all = files.flatMap((file) => parseTables(file, readFileSync(file, 'utf8')));
const rows = all.flatMap((t) => t.rows);
/** 每一行连同它那张表（取地址格、工具格要按表头定的列号） */
const tableRows = all.flatMap((t) => t.rows.map((r) => ({ t, r })));
const at = (r: Row) => `${r.file}:${r.line}（${r.cells[0]}）`;
const codes = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** 缩写展开成几条：{a|b} 换中间一段；a|b 从第一个 | 前最后一个分隔符（/ 或 .）起换结尾 */
function expand(text: string, sep: '/' | '.'): string[] {
  const brace = /\{([^}]*)\}/.exec(text);
  if (brace)
    return brace[1].split('|').flatMap((alt) => expand(text.slice(0, brace.index) + alt + text.slice(brace.index + brace[0].length), sep));
  const bar = text.indexOf('|');
  if (bar < 0) return [text];
  const cut = text.lastIndexOf(sep, bar) + 1;
  return text.slice(cut).split('|').map((alt) => text.slice(0, cut) + alt);
}
/** 结尾那几个（“同四个”照搬用）：a/b|c → [b, c] */
const endings = (text: string) => {
  const bar = text.indexOf('|');
  return bar < 0 ? [text.slice(text.lastIndexOf('/') + 1)] : text.slice(text.lastIndexOf('/', bar) + 1).split('|');
};
/** <名字>：登记了的换成 {几个取值}，没登记的写成 :名字 */
const variables = (path: string) =>
  path.replace(/<([^>]+)>/g, (_, n: string) => (named[n] ? `{${named[n].values.join('|')}}` : ':' + n));

/** 表里写的一条地址：请求方法（没写的是 ''）和带 /api 的完整地址 */
type Address = { method: string; path: string };
/** 地址格里写的地址，按缩写展开、补上前缀 */
function addresses(cell: string, prefix: string): Address[] {
  const out: Address[] = [];
  let depth = 0;
  let base = '';
  for (const m of cell.matchAll(/`([^`]+)`(\s*同)?|（|）/g)) {
    if (m[0] === '（') depth++;
    else if (m[0] === '）') depth--;
    else {
      const method = /^(?:GET|POST|PUT|PATCH|DELETE)(?= )/.exec(m[1])?.[0] ?? '';
      const path = variables(m[1].slice(method.length).trim());
      if (!path.startsWith('/')) continue;
      let full: string[];
      if (depth > 0 && base) full = expand(base + path, '/');
      else if (m[2] && path.endsWith('/') && base) full = endings(base).map((e) => path + e);
      else full = expand(path, '/');
      if (depth === 0) base = path;
      out.push(...full.map((p) => ({ method, path: '/api' + prefix + (p === '/' ? '' : p) })));
    }
  }
  return out;
}

const parts = (path: string) => path.split('?')[0].split('/').filter(Boolean);
/** 服务端每条路由：方法和去掉 /api 的各段（变量段是 :id） */
const routes = serverRouteList().map((r) => ({ method: r.method, path: r.path, segments: parts(r.path) }));
/** 表里这条地址正好是服务端的一条路由：段数一样，写的 :变量 对路由的变量段，写的词对路由的同一个词（literalParams 登记的变量段也认那几个词） */
function routed({ method, path }: Address) {
  const want = parts(path).slice(1);
  return routes.some((r) => {
    if ((method && r.method !== method) || r.segments.length !== want.length) return false;
    const words = literalParams.find((l) => l.route === `${r.method} ${r.path}`)?.values ?? [];
    return r.segments.every((s, i) => (s === ':id' ? want[i].startsWith(':') || words.includes(want[i]) : s === want[i]));
  });
}

/** 助手工具格里的工具名（带点、全小写，order_import.list|get 也算），参数名之类不带点的不算 */
const toolsIn = (cell: string) =>
  codes(cell).filter((c) => /^[a-z_]+\.[a-z_]+(?:\|[a-z_]+)*$/.test(c)).flatMap((c) => expand(c, '.'));
/** 各格里写的 #页面 */
const pagesIn = (r: Row) => r.cells.flatMap(codes).filter((c) => c.startsWith('#'));

test('六份链路表都读到了表格，地址列写了前缀的只有财务（/finance）', () => {
  assert.equal(new Set(rows.map((r) => r.file)).size, files.length, '有一份链路表没读到表格：表头下面要有 |---| 一行');
  assert.deepEqual(all.map((t) => t.prefix).filter(Boolean), ['/finance']);
});

test('每张链路表都读到了后端地址（列挪了位置、表头改了名不会让地址检查空转）', () => {
  const empty = all
    .filter((t) => !t.rows.some((r) => addresses(r.cells[t.address] ?? '', t.prefix).length))
    .map((t) => `${t.file}:${t.line}：这张表一条后端地址都没读到，看表头的“后端地址”列和各行的写法`);
  assert.deepEqual(empty, []);
});

test('按表头找列：列的顺序换了、两张表头不同的表各按自己的表头读，表头缺列或行不在表里就报错', () => {
  const text = [
    '| 功能 | 助手工具 | 页面 | 后端地址 |',
    '|---|---|---|---|',
    '| 甲 | `order.list` | `#orders` | `GET /orders` |',
    '',
    '| 说明 | 后端地址（`/finance` 下） | 助手工具 |',
    '| :-- | :-- | :-- |',
    '| 乙 | `/close` | |',
  ].join('\r\n');
  const [first, second] = parseTables('虚构.md', text);
  assert.deepEqual([first.address, first.tool, second.address, second.tool], [3, 1, 1, 2]);
  assert.deepEqual(addresses(first.rows[0].cells[first.address], first.prefix), [{ method: 'GET', path: '/api/orders' }]);
  assert.deepEqual(toolsIn(first.rows[0].cells[first.tool]), ['order.list']);
  assert.deepEqual(addresses(second.rows[0].cells[second.address], second.prefix), [{ method: '', path: '/api/finance/close' }]);
  assert.throws(() => parseTables('虚构.md', '| 功能 | 页面 |\n|---|---|\n| 甲 | x |'), /后端地址/);
  assert.throws(() => parseTables('虚构.md', '| 甲 | x |'), /不在任何一张表里/);
});

test('表里写的 #页面 都是登记过的页面，带的参数这一页都认', () => {
  const bad = rows.flatMap((r) =>
    pagesIn(r).flatMap((href) => {
      const id = pageIdOf(href);
      if (!isPageHref(href) || !id) return [`${at(r)} ${href}：shared/core/pages.ts 没有这一页，照现在的页面编号改`];
      const params: Record<string, unknown> = pageParams(id, href);
      return [...new URLSearchParams(href.split('?')[1] ?? '').keys()]
        .filter((k) => params[k] === undefined || params[k] === false)
        .map((k) => `${at(r)} ${href}：${id} 页不认参数 ${k}（看 shared/core/pages.ts 的 pageReaders），照页面现在的写法改`);
    }),
  );
  assert.deepEqual(bad, []);
});

test('助手工具列写的都是工具目录里的工具', () => {
  const names = new Set(toolCatalog.map((t) => t.name));
  const bad = tableRows.flatMap(({ t: table, r }) =>
    toolsIn(r.cells[table.tool] ?? '')
      .filter((t) => !names.has(t))
      .map((t) => `${at(r)} ${t}：server/assistant/tool-catalog.ts 没有这个工具，改成现在的名字或删掉`),
  );
  assert.deepEqual(bad, []);
});

test('后端地址（连同写了的请求方法）都是服务端的一条路由，缩写照技能 add-feature“功能链路表”展开', () => {
  const bad = tableRows.flatMap(({ t, r }) =>
    addresses(r.cells[t.address] ?? '', t.prefix)
      .filter((a) => !routed(a))
      .map((a) => {
        const shown = (a.method ? a.method + ' ' : '') + a.path;
        const hint = hasRouteUnder(a.path) ? '这个地址下面有路由，但没有正好这一条（方法不对、少了 :id，或括号里的 /x 接错了地方）' : '服务端没有这个地址';
        return `${at(r)} ${shown}：${hint}；照现在注册的路由改表，缩写展开不对就换写法`;
      }),
  );
  assert.deepEqual(bad, []);
});

test('每个登记页面、工具目录里每个工具，都至少写进一份链路表', () => {
  const pages = new Set(rows.flatMap(pagesIn).map((h) => pageIdOf(h)));
  const tools = new Set(tableRows.flatMap(({ t, r }) => toolsIn(r.cells[t.tool] ?? '')));
  assert.deepEqual(
    [
      ...pageIds.filter((id) => !pages.has(id)).map((id) => `#${id}：哪份链路表都没写，在对应那份的页面列写上`),
      ...toolCatalog.filter((t) => !tools.has(t.name)).map((t) => `${t.name}：哪份链路表都没写，在对应功能那行的助手工具列写上`),
    ],
    [],
  );
});

test('两张登记表里的每条都还用得上（表里不写了、路由没了就删掉）', () => {
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const stale = [
    ...Object.keys(named).filter((n) => !text.includes(`<${n}>`)).map((n) => `named：<${n}> 表里不写了，删掉`),
    ...literalParams
      .filter((l) => !routes.some((r) => `${r.method} ${r.path}` === l.route))
      .map((l) => `literalParams：${l.route} 这条路由没了，删掉或改成现在的`),
  ];
  assert.deepEqual(stale, []);
});
