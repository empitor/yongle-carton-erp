// 样式的模块边界（AGENTS.md“模块”）：每个模块的样式放在自己的目录，只管自己的类名。
// 类名归哪个模块，看哪个模块的组件代码写出了它（className 里的字面量、classList），几个模块都写的归它们都能用的那个模块；
// 全站公共的按钮变体、提示、表单小件（PUBLIC_CLASSES）归基础。模块的先后和 tests/module-boundaries.test.ts 的前端部分一致。
// 一条选择器：
// - 用到的类名只能是本模块的、或本模块能用的模块的（不往上、不往旁边改别人的类）；
// - 除了基础，至少有一个本模块自己的类名（不在自己的文件里改别的模块的东西）；
// - 类名在组件代码里都找得到（找不到的规则就是没人用的，删掉）。
// 确实要跨模块的写进 exceptions，写明原因。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import test from 'node:test';

type Mod = '基础' | '业务' | '财务' | '识别' | '管理' | '助手' | '装配';
const dirs: [prefix: string, mod: Mod][] = [
  ['src/ui/', '基础'],
  ...['records', 'recordkit', 'flow', 'warehouse', 'operations', 'editors', 'marks', 'documents'].map(
    (d): [string, Mod] => ['src/' + d + '/', '业务'],
  ),
  ['src/finance/', '财务'],
  ['src/import/', '识别'],
  ['src/admin/', '管理'],
  ['src/assistant/', '助手'],
  ['src/mobile/', '装配'],
  ['src/', '装配'],
];
const uses: Record<Mod, Mod[]> = {
  基础: [],
  业务: ['基础'],
  财务: ['基础'],
  识别: ['基础', '业务'],
  管理: ['基础', '业务'],
  助手: ['基础', '业务'],
  装配: ['基础', '业务', '财务', '识别', '管理', '助手'],
};
/** 全站公共的类名：哪个模块写都归基础。动态拼出来的（tone-success、span-2 这种）按前缀算。 */
const PUBLIC_CLASSES = ['danger', 'link', 'link-button', 'line-card', 'form-inline', 'form-error', 'form-alert', 'sr-only', 'button', 'empty'];
const PUBLIC_PREFIXES = ['tone-', 'span-', 'cols-', 'editor-', 'col-'];
/** 组件里拼出来的类名（'ga-' + 角色、'paper-' + 纸张这种）：后半截是代码里出现过的词就算找得到，归拼它的模块 */
const DYNAMIC_PREFIXES: [prefix: string, mod: Mod][] = [
  ['ga-yield-', '助手'],
  ['ga-resize-', '助手'],
  ['ga-', '助手'],
  ['paper-', '业务'],
];

/** 登记过的跨模块写法：样式文件 + 选择器 → 原因 */
export const exceptions: { file: string; selector: string; why: string }[] = [
  ...['body:has(.ga-launcher) .aii-footer', 'body:has(.ga-launcher) .order-import'].map((selector) => ({
    file: 'src/cross-module.css',
    selector,
    why: '右下角有小甬小勒时，识别导入的底栏和整页要让开：助手和识别导入互相不能引用，只能由装配层写',
  })),
  ...['.list-toolbar .filter-popover-fields .list-filter-field', '.list-toolbar .filter-popover-fields .list-filter-field > span'].map(
    (selector) => ({
      file: 'src/cross-module.css',
      selector,
      why: '业务的列表工具栏（list-toolbar）里，基础的筛选弹层放着财务页写的筛选字段（list-filter-field），三个模块的类名凑在一起，只能由装配层写',
    }),
  ),
];

const modOf = (f: string) => {
  const found = dirs.find(([p]) => f.startsWith(p));
  if (!found) throw new Error(f + ' 不在登记的任何模块目录里');
  return found[1];
};
const canUse = (a: Mod, b: Mod) => a === b || uses[a].includes(b);
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative('.', join(dir, e.name)).split(sep).join(posix.sep)],
  );
const files = walk('src');
const code = files.filter((f) => /\.tsx?$/.test(f));
const styles = files.filter((f) => f.endsWith('.css'));
// shared/ 里的词表（单据状态、纸张规格）会拼进类名：只用来判断“找得到”，不决定归属
const vocabWords = new Set(
  walk('shared')
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/[A-Za-z_][\w-]*/g)].map((m) => m[0])),
);

/** 组件代码写出的类名：className="…"、className={…} 里的字面量、classList.xxx('…') */
function writtenClasses(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/className=(\{|")/g)) {
    let i = m.index + m[0].length;
    let s = '';
    if (m[1] === '"') s = '"' + text.slice(i, text.indexOf('"', i)) + '"';
    else for (let depth = 1; i < text.length && depth; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      s += text[i];
    }
    for (const lit of s.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g))
      for (const w of (lit[1] ?? lit[2] ?? lit[3]).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/))
        if (/^[A-Za-z_][\w-]*$/.test(w)) out.add(w);
  }
  for (const m of text.matchAll(/classList\.\w+\(\s*'([\w-]+)'/g)) out.add(m[1]);
  return out;
}
const written = new Map<string, Set<string>>();
const words = new Map<string, Set<string>>();
const add = (map: Map<string, Set<string>>, k: string, f: string) => {
  const files = map.get(k) ?? new Set<string>();
  files.add(f);
  map.set(k, files);
};
for (const f of code) {
  // main.tsx 引样式的那几行不算（文件名不是类名）
  const text = readFileSync(f, 'utf8').replace(/^import '[^']+\.css';$/gm, '');
  for (const c of writtenClasses(text)) add(written, c, f);
  for (const m of text.matchAll(/[A-Za-z_][\w-]*/g)) add(words, m[0], f);
}
const known = (w: string) => words.has(w) || vocabWords.has(w) || /^\d+$/.test(w);
/** 类名归哪个模块；只在 shared 词表里出现的是“值”（状态名之类），不归模块；都找不到返回 null */
function owner(c: string): Mod | '值' | null {
  if (PUBLIC_CLASSES.includes(c) || PUBLIC_PREFIXES.some((p) => c.startsWith(p))) return '基础';
  const users = written.get(c) || words.get(c);
  if (!users) {
    const p = DYNAMIC_PREFIXES.find(([x]) => c.startsWith(x) && known(c.slice(x.length)));
    if (p) return p[1];
    return vocabWords.has(c) ? '值' : null;
  }
  const mods = [...new Set([...users].map(modOf))];
  return mods.find((x) => mods.every((y) => canUse(y, x))) ?? '基础';
}

/** 样式文件里的选择器（去掉注释，@media 等里面的也算，@keyframes 里的不算） */
function selectors(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let buf = '',
    depth = 0,
    skip = -1;
  for (const ch of text) {
    if (ch === '{') {
      const head = buf.trim();
      if (skip < 0) {
        if (/^@(keyframes|font-face)/.test(head)) skip = depth;
        else if (!head.startsWith('@')) out.push(...splitTop(head));
      }
      depth++;
      buf = '';
    } else if (ch === '}') {
      depth--;
      if (depth === skip) skip = -1;
      buf = '';
    } else if (ch === ';') buf = '';
    else buf += ch;
  }
  return out;
}
function splitTop(s: string) {
  const out: string[] = [];
  let depth = 0,
    cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && !depth) {
      out.push(cur.trim().replace(/\s+/g, ' '));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}
const classesIn = (sel: string) => [...sel.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);
/** :not() 里的类名不存在也照样匹配，不要求找得到 */
const outsideNot = (sel: string) => classesIn(sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ''));

function violations() {
  const out: string[] = [];
  for (const f of styles) {
    const mod = modOf(f);
    for (const sel of selectors(readFileSync(f, 'utf8'))) {
      if (exceptions.some((e) => e.file === f && e.selector === sel)) continue;
      const cls = classesIn(sel);
      const missing = outsideNot(sel).filter((c) => !owner(c));
      if (missing.length) out.push(f + '：' + sel + '（组件代码里找不到 ' + missing.join('、') + '）');
      const foreign = cls.filter((c) => {
        const o = owner(c);
        return o !== null && o !== '值' && !canUse(mod, o);
      });
      if (foreign.length)
        out.push(f + '：' + sel + '（' + foreign.map((c) => c + ' 归' + owner(c)).join('、') + '，' + mod + '不能用）');
      else if (mod !== '基础' && !missing.length && !cls.some((c) => owner(c) === mod))
        out.push(f + '：' + sel + '（没有' + mod + '自己的类名，改的是别的模块的东西）');
    }
  }
  return out;
}

test('样式文件只管自己模块的类名', () => {
  assert.deepEqual(violations(), []);
});

test('登记的例外都还用得上', () => {
  const all = new Set(styles.flatMap((f) => selectors(readFileSync(f, 'utf8')).map((s) => f + '\0' + s)));
  assert.deepEqual(
    exceptions.filter((e) => !all.has(e.file + '\0' + e.selector)).map((e) => e.file + '：' + e.selector),
    [],
  );
});

test('样式目录都登记了归哪个模块', () => {
  const unknown = styles.filter((f) => !/^src\/([^/]+\.css|(ui|records|recordkit|flow|warehouse|operations|editors|marks|documents|finance|import|admin|assistant|mobile)\/)/.test(f));
  assert.deepEqual(unknown, []);
});
