// 样式的模块边界（docs/架构/模块规则.md）：每个模块的样式放在自己的目录，只管自己的类名。模块、能用谁、分层都读 tests/checks/module-map.ts。
// 类名归哪个模块，看哪个模块的组件代码写出了它（className 里的字面量、classList），几个模块都写的归它们都能用的那个模块；
// 全站公共的按钮变体、提示、表单小件（PUBLIC_CLASSES）归基础。
// 一条选择器：
// - 用到的类名只能是本模块的、或本模块能用的模块的（不往上、不往旁边改别人的类）；
// - 除了基础，至少有一个本模块自己的类名（不在自己的文件里改别的模块的东西）；
// - 分了层的模块（前端业务四层）里，只能写本层和下层的类名（类名的层按写它的最低一层目录算）；
// - 类名要“有人用”：组件代码的 className、classList 或字符串字面量里出现过（找不到的规则就是没人用的，删掉）。
// 确实要跨模块的写进 exceptions，写明原因。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { all, canUse, files, layerOf, matchOf, ownerModule, scriptKind, type Rule } from './module-map.js';

/** 全站公共的类名：哪个模块写都归基础。动态拼出来的（tone-success、span-2 这种）按前缀算。 */
const PUBLIC_CLASSES = ['danger', 'link', 'link-button', 'line-card', 'form-inline', 'form-error', 'form-alert', 'sr-only', 'button', 'empty'];
const PUBLIC_PREFIXES = ['tone-', 'span-', 'cols-', 'editor-', 'col-'];
/** 组件里拼出来的类名：后半截是代码字符串里出现过的词就算找得到，归拼它的那个目录 */
const DYNAMIC_PREFIXES: [prefix: string, dir: string][] = [
  ['ga-yield-', 'src/assistant/'], // 'ga-yield-' + 让位的方向（小人按钮）
  ['ga-resize-', 'src/assistant/'], // 'ga-resize-' + 拖动的边（助手窗口）
  ['ga-', 'src/assistant/'], // 'ga-' + 消息的角色（助手消息）
  ['paper-', 'src/documents/'], // 'paper-' + 纸张、方向（单据纸样预览）
];

/** 登记过的跨模块写法：样式文件 + 选择器 → 原因 */
export const exceptions: { file: string; selector: string; why: string }[] = [
  ...['body:has(.ga-launcher) .aii-footer', 'body:has(.ga-launcher) .order-import'].map((selector) => ({
    file: 'src/cross-module.css',
    selector,
    why: '右下角有小甬小勒时，识别导入的底栏和整页要让开：助手和识别导入互相不能引用，只能由装配层写',
  })),
];

/**
 * 收紧“类名有人用”（只认 className、classList、字符串字面量）后新报出来、还没定怎么办的规则：只许减少。
 * 删掉规则、或查明确实有人用并补上认法后，从这里删。
 */
export const pendingRules: { file: string; selector: string; why: string }[] = [];

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
/** 代码里字符串字面量（含模板字符串的固定部分、JSX 属性值）里的词；变量名、属性名这些标识符不算 */
function literalWords(f: string, text: string) {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      for (const m of n.text.matchAll(/[A-Za-z_][\w-]*/g)) out.add(m[0]);
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, scriptKind(f)));
  return out;
}

/** 类名索引：written 是 className、classList 写出的类名 → 文件；words 是字符串字面量里的词 → 文件；vocab 是 shared/ 词表里的词 */
type ClassIndex = { written: Map<string, Set<string>>; words: Map<string, Set<string>>; vocab: Set<string> };
function classIndex(code: [file: string, text: string][], shared: [file: string, text: string][]): ClassIndex {
  const written = new Map<string, Set<string>>();
  const words = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, k: string, f: string) => map.set(k, (map.get(k) ?? new Set<string>()).add(f));
  for (const [f, raw] of code) {
    // main.tsx 引样式的那几行不算（文件名不是类名）
    const text = raw.replace(/^import '[^']+\.css';$/gm, '');
    for (const c of writtenClasses(text)) add(written, c, f);
    for (const w of literalWords(f, text)) add(words, w, f);
  }
  // shared/ 里的词表（单据状态、纸张规格）会拼进类名：只用来判断“找得到”，不决定归属
  return { written, words, vocab: new Set(shared.flatMap(([f, text]) => [...literalWords(f, text)])) };
}

const base = ownerModule('src/ui/');
const known = (ix: ClassIndex, w: string) => ix.words.has(w) || ix.vocab.has(w) || /^\d+$/.test(w);
/** 写出类名的文件（动态拼的算拼它的目录）；公共类名、只在词表里的、找不到的是空 */
function writersOf(ix: ClassIndex, c: string): string[] {
  const users = ix.written.get(c) ?? ix.words.get(c);
  if (users) return [...users];
  const p = DYNAMIC_PREFIXES.find(([x]) => c.startsWith(x) && known(ix, c.slice(x.length)));
  return p ? [p[1]] : [];
}
/** 类名归哪个模块；只在 shared 词表里出现的是“值”（状态名之类），不归模块；都找不到返回 null */
function owner(ix: ClassIndex, c: string): Rule | '值' | null {
  if (PUBLIC_CLASSES.includes(c) || PUBLIC_PREFIXES.some((p) => c.startsWith(p))) return base;
  const users = writersOf(ix, c);
  if (!users.length) return ix.vocab.has(c) ? '值' : null;
  const mods = [...new Set(users.map(ownerModule))];
  return mods.find((x) => mods.every((y) => y === x || canUse(y, x))) ?? base;
}
/** 类名在所属模块的第几层：写它的、在这个模块里的文件所在的最低一层 */
const classLayer = (ix: ClassIndex, c: string, mod: Rule) =>
  Math.min(...writersOf(ix, c).flatMap((f) => layerOf(f, mod) ?? []));

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

/** 一条选择器在模块这一级的问题：类名找不到、用了不能用的模块的类名、没有本模块自己的类名 */
function moduleProblems(ix: ClassIndex, f: string, sel: string) {
  const mod = ownerModule(f);
  const out: string[] = [];
  const cls = classesIn(sel);
  const missing = outsideNot(sel).filter((c) => !owner(ix, c));
  if (missing.length) out.push(f + '：' + sel + '（组件代码里找不到 ' + missing.join('、') + '，没人用就删掉这条规则）');
  const foreign = cls.flatMap((c) => {
    const o = owner(ix, c);
    return o !== null && o !== '值' && o !== mod && !canUse(mod, o) ? [c + ' 归' + o.name] : [];
  });
  if (foreign.length) out.push(f + '：' + sel + '（' + foreign.join('、') + '，' + mod.name + '不能用，规则搬到类名主人的样式里）');
  else if (mod !== base && !missing.length && !cls.some((c) => owner(ix, c) === mod))
    out.push(f + '：' + sel + '（没有' + mod.name + '自己的类名，改的是别的模块的东西；加上本模块自己的类名，或把规则搬到类名主人的样式里）');
  return out;
}

/** 一条选择器在分层这一级的问题：分了层的模块里，写了比样式文件所在层更高的类名；没问题返回 null */
function layerProblem(ix: ClassIndex, f: string, sel: string) {
  const mod = ownerModule(f);
  const at = layerOf(f, mod);
  if (at === undefined || !mod.layers) return null;
  const upper = classesIn(sel).flatMap((c) => {
    const l = owner(ix, c) === mod ? classLayer(ix, c, mod) : -1;
    return l > at ? [c + ' 归' + mod.layers?.[l]?.name] : [];
  });
  if (!upper.length) return null;
  return f + '：' + sel + '（' + upper.join('、') + '，' + mod.layers[at]?.name + '的样式只能写本层和下层的类名，规则搬到类名主人所在目录的样式里）';
}

const read = (fs: string[]) => fs.map((f): [string, string] => [f, readFileSync(f, 'utf8')]);
const index = classIndex(read(all.filter((f) => f.startsWith('src/'))), read(all.filter((f) => f.startsWith('shared/'))));
const styles = files('src').filter((f) => f.endsWith('.css'));
const rules = styles.flatMap((f) => [...new Set(selectors(readFileSync(f, 'utf8')))].map((sel) => ({ f, sel })));

test('样式文件只管自己模块的类名', () => {
  const found = rules.filter(({ f, sel }) => ![...exceptions, ...pendingRules].some((e) => e.file === f && e.selector === sel));
  assert.deepEqual(found.flatMap(({ f, sel }) => moduleProblems(index, f, sel)), []);
});

test('待定的规则都还在、也确实还报问题（定下来处理掉了就从 pendingRules 里删）', () => {
  const have = new Set(rules.map(({ f, sel }) => f + '\0' + sel));
  assert.deepEqual(
    pendingRules
      .filter((e) => !have.has(e.file + '\0' + e.selector) || !moduleProblems(index, e.file, e.selector).length)
      .map((e) => e.file + '：' + e.selector + '：规则已经不在或不再报问题，从 pendingRules 删掉'),
    [],
  );
});

test('前端业务四层的样式只写本层和下层的类名', () => {
  assert.deepEqual(rules.flatMap(({ f, sel }) => layerProblem(index, f, sel) ?? []), []);
});

test('登记的例外都还用得上', () => {
  const have = new Set(rules.map(({ f, sel }) => f + '\0' + sel));
  assert.deepEqual(
    exceptions.filter((e) => !have.has(e.file + '\0' + e.selector)).map((e) => e.file + '：' + e.selector + '：规则已经不在了，从 exceptions 删掉'),
    [],
  );
});

test('样式目录都登记了归哪个模块，分了层的模块里也登记了层', () => {
  const unknown = styles.flatMap((f) => {
    const p = matchOf(f)?.p;
    if (!p || (p === 'src/' && f.split('/').length > 2)) return [f + '：所在目录没登记进 tests/checks/module-map.ts 的模块表，在它所属模块的 paths 里加上'];
    const mod = ownerModule(f);
    return mod.layers && layerOf(f, mod) === undefined ? [f + '：没登记进' + mod.name + '的任何一层，在 tests/checks/module-map.ts 这个模块的 layers 里加上'] : [];
  });
  assert.deepEqual(unknown, []);
});

test('回归：样式检查拦住往上层写、改别的模块、没人用的类名，合规写法不误报', () => {
  const ix = classIndex(
    [
      ['src/flow/A.tsx', 'export const A = () => <div className="flow-x">{\'used-word\'}</div>;'],
      ['src/recordkit/B.tsx', "export const B = () => <div className={'kit-x ' + tone} />;\nconst orphanName = 1;"],
      ['src/finance/C.tsx', 'export const C = () => <div className="fin-x" />;'],
      ['src/documents/D.tsx', "export const D = (p: string) => <div className={'paper-' + p} />;"],
    ],
    [['shared/business/operations/E.ts', "export const papers = ['a4'];"]],
  );
  const problems = (f: string, sel: string) => [...moduleProblems(ix, f, sel), layerProblem(ix, f, sel) ?? ''].filter(Boolean);
  const blocked: [file: string, sel: string, expect: string][] = [
    ['src/recordkit/kit.css', '.kit-x .flow-x', 'flow-x 归单据'],
    ['src/flow/flow.css', '.flow-x .fin-x', 'fin-x 归前端-财务'],
    ['src/flow/flow.css', '.flow-x .orphanName', '找不到 orphanName'],
    ['src/flow/flow.css', '.flow-x .no-such', '找不到 no-such'],
  ];
  for (const [f, sel, expect] of blocked)
    assert.ok(problems(f, sel).some((x) => x.includes(expect)), f + ' 应拦住：' + sel + '\n实际：' + JSON.stringify(problems(f, sel)));
  const allowed: [file: string, sel: string][] = [
    ['src/flow/flow.css', '.flow-x .kit-x'],
    ['src/flow/flow.css', '.flow-x .used-word'],
    ['src/records/records.css', '.flow-x .paper-a4'],
    ['src/documents/paper.css', '.paper-a4'],
    ['src/recordkit/kit.css', '.kit-x .danger'],
  ];
  for (const [f, sel] of allowed) assert.deepEqual(problems(f, sel), [], f + ' 不该拦：' + sel);
});
