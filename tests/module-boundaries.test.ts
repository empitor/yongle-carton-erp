// 模块边界：每个文件属于一个模块，只能引用自己模块和“可以依赖”的模块（模块表在 module-map.ts）。
// 新加的跨模块引用被拦下时，先想能不能放进对方的对外接口或基础模块，确实需要才在 exceptions 里登记并写明原因。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { all, inModules, isCode, isEntry, moduleOf, modules, refsOf, tools, type Ref, type Rule } from './module-map.js';

/** 登记过的例外：from 文件 → to 文件（或目录前缀），每条写明为什么不能按规则来。 */
const exceptions: { from: string; to: string; why: string }[] = [];

/** 模块代码引用 scripts/、tests/ 下的文件（不属于任何模块），要登记。 */
const outsideRefs: { from: string; to: string; why: string }[] = [
  {
    from: 'server/index.ts',
    to: 'scripts/runtime-control.mjs',
    why: '启动时登记运行状态、接收停止请求；这个文件同时给开发启动脚本 scripts/dev-system.mjs 用，放在 scripts/，发布包里有',
  },
  { from: 'server/stop.ts', to: 'scripts/runtime-control.mjs', why: '同上：命令行停止正式实例' },
];

/**
 * 脚本和配置文件（scripts/、根目录的 *.config.*）引用模块，和模块之间一样只走公开入口：
 * 各模块的 index.ts、按需加载的 pages.ts，或者装配的文件（server/、src/ 根目录，比如 server/app.ts、server/index.ts）。
 * 确实要验证内部实现的工具登记在这里，写明调用方、目标和理由。tests/ 不查：测试本来就要直接验证内部实现。
 */
const toolInternalRefs: { from: string; to: string; why: string }[] = [
  {
    from: 'eslint.config.js',
    to: 'server/core/sql.ts',
    why: '“服务端不许直接读库”这条代码检查按路径放过读库函数自己所在的文件（它就是规定的唯一入口）；配置里写的是文件路径，没有引用它的代码',
  },
  ...['src/admin/settings-api.ts', 'src/import/workspace-api.ts', 'src/assistant/useAssistantChat.ts'].map((to) => ({
    from: 'eslint.config.js',
    to,
    why: '“由调用方指定回答类型的 responseData、readEventStream 只许 src/ui 用”这条代码检查按路径放过要带 AI 页面凭证头或读事件流的三份文件；配置里写的是文件路径，没有引用它的代码',
  })),
  ...[
    'shared/core/precision.ts',
    'shared/core/quantity.ts',
    'shared/core/units.ts',
    'server/finance/amounts.ts',
    'server/core/permissions.ts',
    'shared/core/account-scope.ts',
  ].map((to) => ({
    from: 'stryker.config.mjs',
    to,
    why: '变异测试配置（stryker.config.mjs）的 mutate 列表按路径点名要变异测验的核心计算文件；配置里只是路径清单，没有引用它的代码',
  })),
];

/**
 * 加载目标在代码里看不出来的动态加载（import(变量)、require(变量)、new URL(变量, import.meta.url)）。
 * 默认不允许：能写成字面量的写成字面量，确实要按变量加载的在这里登记文件和理由。现在没有。
 */
const dynamicLoads: { file: string; why: string }[] = [];

const canUse = (from: Rule, to: Rule) =>
  from.allow.includes('*') ||
  (from.allow.includes('前端-*') && to.name.startsWith('前端-')) ||
  from.allow.includes(to.name) ||
  (from.allow.includes('*共用') && to.name.startsWith('共用'));

/** 模块代码一个文件的方向违规：只能用规则里允许的模块 */
function directionViolations(f: string, refs: Ref[] = refsOf(f)) {
  const from = moduleOf(f);
  if (!from) return [f + '：不属于任何模块'];
  const out: string[] = [];
  for (const r of refs) {
    const target = r.target;
    if (!target || !inModules(target)) continue;
    const to = moduleOf(target);
    if (!to || to === from || canUse(from, to)) continue;
    if (exceptions.some((e) => e.from === f && (e.to.endsWith('/') ? target.startsWith(e.to) : target === e.to))) continue;
    out.push(f + ':' + r.line + '（' + from.name + '）→ ' + target + '（' + to.name + '）');
  }
  return out;
}

/**
 * 模块代码一个文件的接口违规：引用别的模块只能引它的 index.ts，按需加载的页面只能 import() 它的 pages.ts。
 * 样式只能由前端装配（src/main.tsx）统一引入，别的模块不能引别的模块的样式。
 */
function interfaceViolations(f: string, refs: Ref[] = refsOf(f)) {
  const from = moduleOf(f);
  const out: string[] = [];
  for (const r of refs) {
    if (!r.target || !inModules(r.target)) continue;
    const to = moduleOf(r.target);
    if (!to || to === from || to.name === '装配' || to.name === '前端-装配') continue;
    if (!isCode(r.target)) {
      if (from?.name !== '前端-装配') out.push(f + ':' + r.line + ' → ' + r.target + '（别的模块的样式、资源）');
      continue;
    }
    if (/^(server|shared|src)\/[a-z]+\/index\.ts$/.test(r.target) && (r.how === 'import' || r.how === 'import()')) continue;
    if (r.how === 'import()' && /^src\/[a-z]+\/pages\.ts$/.test(r.target)) continue;
    out.push(f + ':' + r.line + ' → ' + r.target + (r.how === 'import' ? '' : '（' + r.how + '）'));
  }
  return out;
}

/**
 * 加载方式的违规（模块代码和工具都查）：
 * - 加载目标算不出来的（import(变量) 等），除非登记在 dynamicLoads；
 * - 相对路径找不到文件的；
 * - 模块代码引用 scripts/、tests/ 的，除非登记在 outsideRefs；
 * - 工具引用模块的内部文件（不是 index.ts、pages.ts、装配入口），除非登记在 toolInternalRefs。
 */
function loadViolations(f: string, refs: Ref[] = refsOf(f)) {
  const out: string[] = [];
  const isTool = !inModules(f);
  for (const r of refs) {
    const at = f + ':' + r.line;
    if (r.unresolved !== undefined) {
      if (!dynamicLoads.some((e) => e.file === f)) out.push(at + '：' + r.how + ' 的目标看不出来（' + r.unresolved + '）');
      continue;
    }
    if (!r.target) {
      out.push(at + '：找不到 ' + r.spec);
      continue;
    }
    if (!isTool && !inModules(r.target)) {
      if (!outsideRefs.some((e) => e.from === f && e.to === r.target)) out.push(at + ' → ' + r.target + '（模块外的文件）');
      continue;
    }
    if (isTool && inModules(r.target)) {
      const to = moduleOf(r.target);
      if (isEntry(r.target) || to?.name === '装配' || to?.name === '前端-装配') continue;
      if (!toolInternalRefs.some((e) => e.from === f && e.to === r.target)) out.push(at + ' → ' + r.target + '（' + to?.name + ' 的内部文件）');
    }
  }
  return out;
}

test('模块之间只按规定的方向引用', () => {
  assert.deepEqual(all.flatMap((f) => directionViolations(f)), []);
});

test('server、src 下的每个子目录都登记进了模块（装配只管根目录的文件，新目录不会悄悄变成能引用一切的装配）', () => {
  const unregistered = all.filter((f) => {
    if (f.split('/').length < 3) return false;
    const matched = modules
      .flatMap((m) => m.paths)
      .filter((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
      .sort((a, b) => b.length - a.length)[0];
    return matched === 'server/' || matched === 'src/';
  });
  assert.deepEqual(unregistered, []);
});

test('规则里允许的每个依赖都确实用到了（规则和代码一致，架构图不会画出不存在的箭头）', () => {
  const used = new Set<string>();
  for (const f of all) {
    const from = moduleOf(f);
    if (!from) continue;
    for (const r of refsOf(f)) {
      const to = r.target && inModules(r.target) && isCode(r.target) ? moduleOf(r.target) : undefined;
      if (to && to !== from) used.add(from.name + ' → ' + to.name);
    }
  }
  const unused = modules.flatMap((m) =>
    m.allow.filter((a) => !a.includes('*') && !used.has(m.name + ' → ' + a)).map((a) => m.name + ' → ' + a),
  );
  assert.deepEqual(unused, []);
});

test('每条例外都还用得上，不留过期的登记', () => {
  const uses = (from: string, to: string) =>
    existsSync(from) && refsOf(from).some((r) => !!r.target && (to.endsWith('/') ? r.target.startsWith(to) : r.target === to));
  const stale = [...exceptions, ...outsideRefs, ...toolInternalRefs].filter((e) => !uses(e.from, e.to)).map((e) => e.from + ' → ' + e.to);
  const staleDynamic = dynamicLoads.filter((e) => !existsSync(e.file) || !refsOf(e.file).some((r) => r.unresolved !== undefined));
  assert.deepEqual([...stale, ...staleDynamic.map((e) => e.file)], []);
});

/** Tarjan 强连通分量：图里大于一个文件的分量就是循环（每个分量里的文件排好序） */
function cyclesIn(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [], on = new Set<string>(), ix = new Map<string, number>(), low = new Map<string, number>();
  const cycles: string[][] = [];
  // 访问过的点一定有编号；取不到说明算法写错了
  const numbered = (m: Map<string, number>, v: string) => {
    const n = m.get(v);
    if (n === undefined) throw new Error('循环检查：' + v + ' 还没编号');
    return n;
  };
  const popGroup = (v: string) => {
    const group: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop();
      if (w === undefined) throw new Error('循环检查：栈里找不到 ' + v);
      on.delete(w);
      group.push(w);
    } while (w !== v);
    return group;
  };
  const visit = (v: string) => {
    ix.set(v, index), low.set(v, index++), stack.push(v), on.add(v);
    for (const w of graph.get(v) || [])
      if (!ix.has(w)) visit(w), low.set(v, Math.min(numbered(low, v), numbered(low, w)));
      else if (on.has(w)) low.set(v, Math.min(numbered(low, v), numbered(ix, w)));
    if (low.get(v) === ix.get(v)) {
      const group = popGroup(v);
      if (group.length > 1) cycles.push(group.sort());
    }
  };
  for (const v of graph.keys()) if (!ix.has(v)) visit(v);
  return cycles;
}

test('整个项目没有循环引用（server、shared、src；只看运行时的 import，不算 import type）', () => {
  const graph = new Map(
    all.map((f) => [f, refsOf(f).flatMap((x) => (!x.typeOnly && x.target && isCode(x.target) ? [x.target] : []))]),
  );
  assert.deepEqual(cyclesIn(graph), []);
});

/**
 * 模块之间只走对外接口：引用别的模块时只能引它目录下的 index.ts；按需加载的页面（lazy(() => import(...))）
 * 只能引它的 pages.ts，pages.ts 也不许静态引用（不然页面就被提前打进主包）。
 * 多个目录的模块（识别导入、前端业务页面）每个目录各有一个 index.ts（有按需加载页面的目录另有 pages.ts），模块内部跨目录直接引用。
 */
test('引用别的模块只走它的 index.ts（按需加载的页面走 pages.ts）', () => {
  assert.deepEqual(all.flatMap((f) => interfaceViolations(f)), []);
});

test('动态加载、require、文件地址都看得出加载的是哪个文件；模块代码不引用 scripts、tests（登记的除外）', () => {
  assert.deepEqual(all.flatMap((f) => loadViolations(f)), []);
});

test('脚本和配置文件引用模块也只走公开入口（index.ts、pages.ts、装配入口），验证内部实现的登记了理由', () => {
  assert.deepEqual(tools.flatMap((f) => loadViolations(f)), []);
});

test('接口文件只列自己模块的东西，不转手别的模块的', () => {
  const bad = all
    .filter(isEntry)
    .flatMap((f) => refsOf(f).filter((x) => !x.spec.startsWith('./')).map((x) => f + ' → ' + (x.spec || x.unresolved)));
  assert.deepEqual(bad, []);
});

test('入口文件里列的名字都有别的模块在用（接口清单和实际一致，不越积越多）', () => {
  const used = new Map<string, Set<string>>();
  const mark = (file: string, name: string) => {
    const names = used.get(file) ?? new Set<string>();
    names.add(name);
    used.set(file, names);
  };
  // 脚本也算使用者：单据导出的排版自检那几个名字只有 scripts/linux 的部署自检在用
  for (const f of [...all, ...tools]) {
    for (const { target, names } of refsOf(f)) if (target && names) names.forEach((n) => mark(target, n));
    // 按需加载的页面：lazy(() => import('./x/pages').then((m) => ({ default: m.Page })))
    if (!f.startsWith('src/')) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/import\('([^']+\/pages)'\)\.then\(\(m\) => \(\{ default: m\.(\w+) \}\)\)/g)) {
      const t = refsOf(f).find((r) => r.spec === m[1])?.target;
      if (t) mark(t, m[2]);
    }
  }
  const unused: string[] = [];
  for (const f of all.filter(isEntry)) {
    const names = [...readFileSync(f, 'utf8').matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) =>
      m[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          // “a as b”取 as 后面的名字
          const parts = x.split(/\s+as\s+/);
          return parts[parts.length - 1].trim();
        }),
    );
    for (const n of names) if (!used.get(f)?.has(n)) unused.push(f + '：' + n);
  }
  assert.deepEqual(unused, []);
});

test('前端模块之间的事件只用 src/ui/events.ts 的 emit、listen，不直接写事件名', () => {
  const bad: string[] = [];
  for (const f of all.filter((x) => x.startsWith('src/') && x !== 'src/ui/events.ts')) {
    const text = readFileSync(f, 'utf8');
    for (const [i, line] of text.split(/\r?\n/).entries())
      if (/window\.dispatchEvent\(|new CustomEvent\(|(?:add|remove)EventListener\(\s*['"`](?:erp-|finance-)/.test(line))
        bad.push(f + ':' + (i + 1) + '  ' + line.trim());
  }
  assert.deepEqual(bad, []);
});

/*
 * 回归：检查器自己也要测。每组都有违规样例（必须拦住）和合法样例（不能误报），
 * 防止检查器一律放行，或者一律拒绝却看起来“有效”。样例只在内存里解析，不写文件。
 */
const codeCheck = (f: string, text: string) => {
  const refs = refsOf(f, text);
  // 脚本和配置文件不属于模块，只查加载方式和引用的入口
  return [...(inModules(f) ? [...directionViolations(f, refs), ...interfaceViolations(f, refs)] : []), ...loadViolations(f, refs)];
};
test('回归：代码引用检查认得出 .mjs、变量动态导入、require、文件地址、脚本路径，合法写法不误报', () => {
  const blocked: [file: string, text: string, expect: string][] = [
    ['server/import/parse-worker.mjs', "import '../flow/service.ts';", '→ server/flow/service.ts'],
    ['server/operations/service.ts', "const target = '../flow/service.js';\nexport const load = () => import(target);", '（采购库存）→ server/flow/service.ts'],
    ['server/operations/service.ts', 'export const load = (p: string) => import(p);', '的目标看不出来'],
    ['server/business/sample.ts', "const m = require('../flow/service.js');", '→ server/flow/service.ts（require）'],
    ['server/business/sample.ts', "export const w = new URL('../import/manager.ts', import.meta.url);", '→ server/import/manager.ts（url）'],
    ['server/business/sample.ts', 'export const w = (name: string) => new URL(name, import.meta.url);', '的目标看不出来'],
    // 带 ? 后缀（Vite 的 ?no-inline、?raw）去掉后缀再认文件，越界照样拦
    ['server/business/sample.ts', "export const w = new URL('../import/manager.ts?no-inline', import.meta.url);", '→ server/import/manager.ts（url）'],
    ['server/business/sample.ts', "import text from '../flow/service.ts?raw';", '→ server/flow/service.ts'],
    ['server/business/sample.ts', "import '../../scripts/runtime-control.mjs';", '（模块外的文件）'],
    ['server/business/sample.ts', "import './no-such-file.js';", '找不到'],
    // 同名参数遮住了常量：不能把参数当成那个常量算
    ['server/business/sample.ts', "const p = '../flow/index.js';\nexport const load = (p: string) => import(p);", '的目标看不出来'],
    // createRequire 换了名字、require.resolve 也算
    ['scripts/sample.mjs', "const req = createRequire(import.meta.url);\nreq('../server/flow/service.ts');", '（单据流转 的内部文件）'],
    ['scripts/sample.mjs', "require.resolve('../server/core/db.ts');", '（基础 的内部文件）'],
    // 登记过的工具才放行：别的脚本引同一个内部文件照样拦
    ['scripts/linux/verify-package.mjs', "await import('../../server/inbox/service.ts');", '（识别导入 的内部文件）'],
    ['src/records/Sample.tsx', "import '../finance/finance.css';", '（别的模块的样式、资源）'],
    ['scripts/sample.mjs', "await import('../server/core/db.ts');", '（基础 的内部文件）'],
    ['scripts/sample.mjs', "const P = new URL('../', import.meta.url).href;\nawait import(P + 'server/core/index.ts');", '的目标看不出来'],
    ['scripts/sample.mjs', "spawnSync(process.execPath, ['--import', 'tsx', 'server/flow/service.ts']);", '（单据流转 的内部文件）'],
    ['vite.config.ts', "import { AI_HTTP_TIMEOUT_MS } from './shared/ai/ai-runtime';", '（共用-AI 的内部文件）'],
  ];
  for (const [f, text, expect] of blocked)
    assert.ok(codeCheck(f, text).some((x) => x.includes(expect)), f + ' 应拦住：' + text + '\n实际：' + JSON.stringify(codeCheck(f, text)));
  const allowed: [file: string, text: string][] = [
    ['server/business/sample.ts', "import { FlowService } from '../flow/index.js';\nexport const m = () => import('../flow/index.js');"],
    ['server/business/sample.ts', "import fs from 'node:fs';\nexport const x = () => import('xlsx');\nconst y = require('express');"],
    ['server/import/sample.ts', "new URL('./manager.ts', import.meta.url);"],
    ['server/import/sample.ts', "const worker = './manager.ts';\nnew URL(worker, import.meta.url);"],
    ['server/import/sample.ts', "new URL('./manager.ts?no-inline', import.meta.url);"],
    ['src/main.tsx', "import './finance/finance.css';\nimport './ui/list-layout.css';"],
    ['src/App.tsx', "const FinancePages = lazy(() => import('./finance/pages'));"],
    ['scripts/sample.mjs', "await import('../server/core/index.ts');\nawait import('../server/app.ts');\nspawnSync('node', ['server/index.ts']);"],
    ['scripts/sample.mjs', "await import('../tests/assistant-workflow-fixture.ts');\nconst { createCanvas } = require('@napi-rs/canvas');"],
    ['scripts/linux/verify-package.mjs', "await import('../../server/speech/index.ts');"],
    ['server/index.ts', "import { createRuntimeControl } from '../scripts/runtime-control.mjs';"],
  ];
  for (const [f, text] of allowed) assert.deepEqual(codeCheck(f, text), [], f + ' 不该拦：' + text);
});
