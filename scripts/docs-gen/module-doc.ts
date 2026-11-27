// 生成 docs/生成/模块表.md：全部照 tests/checks/module-map.ts 写（模块、目录、能用谁、分层、说明、守规则的检查），
// 服务端模块之间的依赖图按 allow 去掉能顺着走到的边画出来。
import { existsSync, readdirSync } from 'node:fs';
import { canUse, lazyEntries, moduleChecks, modules, type ModuleRule } from '../../tests/checks/module-map.js';
import { code, docHeader, table } from './markdown.js';

export const MODULE_DOC = 'docs/生成/模块表.md';

const HEADER = docHeader(
  '模块表',
  '加文件、目录、跨模块引用时，查每个模块管什么、目录在哪、能用哪些模块、模块里怎么分层，以及守模块规则的检查',
  '全部来自 `tests/checks/module-map.ts`（模块的 `what`、`layerNote` 和 `moduleChecks` 是写给这份的说明）。' +
    '改了那份就跑 `npm run docs:gen`；`tests/checks/docs-generated.test.ts` 核对这份是不是最新。五条规则和怎么用这张表，相关的见 `docs/架构/模块规则.md`。',
);

/** allow 里的通配写法换成人话 */
const allowText = (allow: string[]) =>
  allow.length
    ? allow.map((name) => (name === '*' ? '全部' : name === '*共用' ? '全部共用' : name === '前端-*' ? '全部前端' : name)).join('、')
    : '不用别的模块';

const pathsText = (rule: ModuleRule) => rule.paths.map(code).join('、');
const side = (rule: ModuleRule) => rule.paths[0].split('/')[0];

function moduleTable(rules: ModuleRule[]) {
  return table(
    ['模块', '目录', '管什么', '能用'],
    rules.map((rule) => [rule.name, pathsText(rule), rule.what, allowText(rule.allow)]),
  );
}

/** 一组模块之间的依赖图：只画直接一层（a 能用 c、又能经 b 走到 c 的，不画 a → c） */
function graph(rules: ModuleRule[]) {
  const id = (rule: ModuleRule) => 'm' + rules.indexOf(rule);
  const uses = (from: ModuleRule) => rules.filter((to) => to !== from && canUse(from, to));
  const reach = new Map<ModuleRule, Set<ModuleRule>>();
  const reachable = (from: ModuleRule): Set<ModuleRule> => {
    const known = reach.get(from);
    if (known) return known;
    const found = new Set<ModuleRule>();
    reach.set(from, found);
    for (const to of uses(from)) for (const next of [to, ...reachable(to)]) found.add(next);
    return found;
  };
  const lines = ['```mermaid', 'flowchart BT'];
  for (const rule of rules) lines.push(`  ${id(rule)}[${rule.name}]`);
  for (const from of rules)
    for (const to of uses(from))
      if (!uses(from).some((via) => via !== to && reachable(via).has(to))) lines.push(`  ${id(from)} --> ${id(to)}`);
  lines.push('```', '', '箭头读作“用”，只画直接一层，顺着能走到的都能用。', '');
  return lines;
}

/** 分了层的模块：从下往上的层和目录，加说明 */
function layerTable() {
  const layered = modules.filter((rule) => rule.layers?.length);
  const missing = layered.filter((rule) => !rule.layerNote).map((rule) => rule.name);
  if (missing.length) throw new Error(`分了层的模块要在 tests/checks/module-map.ts 写 layerNote：${missing.join('、')}`);
  return table(
    ['模块', '从下往上', '说明'],
    layered.map((rule) => [
      rule.name,
      (rule.layers ?? []).map((layer) => `${layer.name}（${layer.paths.map(code).join('、')}）`).join(' ← '),
      rule.layerNote ?? '',
    ]),
  );
}

/** 守模块规则的检查：登记的文件要在，tests/checks/ 下 module- 开头的检查都要登记 */
function checkTable() {
  const listed = new Set(moduleChecks.map((check) => check.file));
  const gone = moduleChecks.filter((check) => !existsSync(check.file)).map((check) => check.file);
  const unlisted = readdirSync('tests/checks')
    .filter((name) => /^module-.*\.test\.ts$/.test(name))
    .map((name) => 'tests/checks/' + name)
    .filter((file) => !listed.has(file));
  if (gone.length || unlisted.length)
    throw new Error(
      `tests/checks/module-map.ts 的 moduleChecks 要和检查文件对上：文件不在了 ${gone.join('、') || '无'}，没登记 ${unlisted.join('、') || '无'}`,
    );
  return table(
    ['检查', '拦什么'],
    moduleChecks.map((check) => [code(check.file), check.blocks]),
  );
}

/** 模块表文档的全文 */
export function moduleDoc() {
  const server = modules.filter((rule) => side(rule) === 'server');
  const front = modules.filter((rule) => side(rule) === 'src');
  const lines = [
    ...HEADER,
    '## 服务端',
    '',
    ...moduleTable(server),
    ...graph(server),
    '## 共用',
    '',
    ...moduleTable(modules.filter((rule) => side(rule) === 'shared')),
    '## 前端',
    '',
    '前端模块之间的用法和服务端不同，见下图（只画前端模块）。',
    '',
    ...moduleTable(front),
    ...graph(front),
    '## 模块里的分层',
    '',
    ...layerTable(),
    '## 按需加载的入口',
    '',
    '各模块的 `pages.ts` 之外另立的按需加载入口：',
    '',
    ...table(['入口', '为什么'], lazyEntries.map((entry) => [code(entry.file), entry.why])),
    '## 守模块规则的检查',
    '',
    ...checkTable(),
  ];
  return lines.join('\n').trimEnd() + '\n';
}
