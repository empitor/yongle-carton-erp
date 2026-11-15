// 给 tests/feature-links-*.test.ts 用的静态扫描（只导出函数，不是测试文件本身）：
// 前端的按钮文字、前端哪个文件发了哪个写地址、服务端把单据改成哪种状态的写法。都只读源码的语法树，不加载业务代码。
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { all, resolve, scriptKind } from './module-map.js';
import type { ApiRef } from './module-boundaries-api.js';

const parsed = new Map<string, ts.SourceFile>();
const source = (f: string, text?: string) => {
  const got = text === undefined ? parsed.get(f) : undefined;
  if (got) return got;
  const sf = ts.createSourceFile(f, text ?? readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(f));
  if (text === undefined) parsed.set(f, sf);
  return sf;
};
const visit = (n: ts.Node, fn: (n: ts.Node) => void) => {
  fn(n);
  n.forEachChild((c) => visit(c, fn));
};
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
/** 字符串字面量和三元两边的字面量；别的写法（变量、函数）取不到，返回空 */
const literals = (e: ts.Expression | undefined): string[] => {
  if (!e) return [];
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e)) return literals(e.expression);
  if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)];
  return [];
};

export type Found = { text: string; file: string; line: number };

// ---------- 按钮文字 ----------

/** 按钮上的字：<button>、<XxxButton> 里的文字和字面量，带数量的只取开头那段（“安排送货（3 张）”取“安排送货（”） */
function buttonChildren(sf: ts.SourceFile, el: ts.JsxElement, file: string): Found[] {
  const out: Found[] = [];
  const texts = el.children.filter(ts.isJsxText).map((t) => t.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (texts.length) out.push({ text: texts[0], file, line: lineOf(sf, el) });
  for (const c of el.children)
    if (ts.isJsxExpression(c)) for (const text of literals(c.expression)) out.push({ text, file, line: lineOf(sf, c) });
  return out;
}
const labelKeys = new Set(['label', 'submitLabel', 'confirmLabel']);
const valueOf = (n: ts.PropertyAssignment | ts.JsxAttribute): ts.Expression | undefined => {
  if (ts.isPropertyAssignment(n)) return n.initializer;
  const init = n.initializer;
  if (init && ts.isStringLiteral(init)) return init;
  return init && ts.isJsxExpression(init) ? init.expression : undefined;
};
const isButtonTag = (name: string) => name === 'button' || name.endsWith('Button');
/** 词表文件里像按钮叫法的字：不长、不带句读（整句的提示不算） */
const wordLike = (t: string) => t.length <= 12 && !/[，。：；！？“”（）,.]/.test(t);

/**
 * 前端的按钮文字：按钮元素里的字，属性或对象里 label、submitLabel、confirmLabel 的字面量，词表文件（*-words.ts）里像叫法的字面量。
 * 只取写死的字；拼出来的、从函数返回的取不到。
 */
export function buttonTexts(): Found[] {
  const out: Found[] = [];
  for (const file of all.filter((f) => /^src\/.*\.tsx?$/.test(f))) {
    const sf = source(file),
      words = /-words\.ts$/.test(file);
    visit(sf, (n) => {
      if (ts.isJsxElement(n) && isButtonTag(n.openingElement.tagName.getText(sf))) out.push(...buttonChildren(sf, n, file));
      if ((ts.isPropertyAssignment(n) || ts.isJsxAttribute(n)) && labelKeys.has(n.name.getText(sf)))
        for (const text of literals(valueOf(n))) out.push({ text, file, line: lineOf(sf, n) });
      if (words && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && wordLike(n.text.trim()))
        out.push({ text: n.text.trim(), file, line: lineOf(sf, n) });
    });
  }
  return out.map((f) => ({ ...f, text: f.text.trim() })).filter((f) => f.text);
}

// ---------- 前端发写请求的文件 ----------

/** 前端请求的地址落在哪条路由上：段数一样，写死的段对上算 2 分、路由的变量段算 1 分，取分最高的；对不上返回 undefined */
export function routeFor(path: string, routePaths: string[]): string | undefined {
  const want = path.split('/');
  let best: string | undefined,
    top = -1;
  for (const p of routePaths) {
    const segs = p.split('/');
    if (segs.length !== want.length) continue;
    let score = 0;
    for (const [i, s] of segs.entries()) score = score < 0 ? score : s === want[i] ? score + 2 : s === ':id' ? score + 1 : -1;
    if (score > top) [best, top] = [p, score];
  }
  return best;
}

/** 这一行上、写法正好是 via 的调用；没有（写在属性、链接、单独的字面量里）返回 undefined */
function callAt(sf: ts.SourceFile, ref: ApiRef): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || n.expression.getText(sf).replace(/\s+/g, '') !== ref.via) return;
    const from = lineOf(sf, n),
      to = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
    if (from <= ref.line && ref.line <= to) found = n;
  });
  return found;
}
/** via 的开头是从别的文件引进来的：返回那个文件（src/ui 的请求入口不算，算调用它的文件） */
function importedFrom(sf: ts.SourceFile, file: string, name: string): string | undefined {
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const named = s.importClause?.namedBindings;
    if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === name)) {
      const target = resolve(file, s.moduleSpecifier.text);
      return target && !target.startsWith('src/ui/') ? target : undefined;
    }
  }
  return undefined;
}
/** 调用带了要写的内容：fetch 看第二个参数里写没写 method，tokenRequest 内容在第三个参数，别的看有没有第二个参数 */
function sendsBody(call: ts.CallExpression, via: string): boolean {
  const args = call.arguments;
  if (via === 'fetch') {
    const init = args[1];
    return !!init && ts.isObjectLiteralExpression(init) && init.properties.some((p) => p.name?.getText() === 'method');
  }
  const body = args[via === 'tokenRequest' ? 2 : 1];
  return !!body && !(ts.isIdentifier(body) && body.text === 'undefined');
}

export type Sender = { route: string; file: string; at: string };
/**
 * 前端发写请求的地方：apiRefs 取出的每个地址先对上路由，路由有写方法的才看。
 * - 算在哪个文件：直接调请求入口（call() 建的函数、tokenRequest、uploadFile、fetch……）或本文件的函数的，算本文件；
 *   调别的文件里包好的函数（saveBot、requestLifecycle）的，算那个函数所在的文件。链接、组件属性、单独的字面量不算发请求。
 * - 调用带了要写的内容才算写（不带内容是 GET）：同一个地址既能读又能写（GET /customers、POST /customers）也分得开。
 *   按接口表的键发的（call()，键 'POST /customers'），方法就是键里写的，不看带没带内容。
 */
export function writeSenders(
  refs: { file: string; text?: string; refs: ApiRef[] }[],
  routes: { method: string; path: string }[],
): Sender[] {
  const methods = new Map<string, Set<string>>();
  for (const r of routes) (methods.get(r.path) ?? methods.set(r.path, new Set()).get(r.path))?.add(r.method);
  const writePaths = new Set([...methods].filter(([, m]) => [...m].some((x) => x !== 'GET')).map(([p]) => p));
  const paths = [...methods.keys()];
  const out: Sender[] = [];
  for (const { file, text, refs: list } of refs) {
    const sf = source(file, text);
    for (const ref of list) {
      const route = routeFor(ref.path, paths);
      if (!route || !writePaths.has(route) || ref.method === 'GET') continue;
      const call = callAt(sf, ref);
      if (!call) continue;
      if (!ref.method && !sendsBody(call, ref.via)) continue;
      const sender = importedFrom(sf, file, ref.via.split('.')[0]) ?? file;
      out.push({ route, file: sender, at: file + ':' + ref.line });
    }
  }
  return out;
}

// ---------- 服务端改单据状态的写法 ----------

/** 写单据表的两个函数（server/flow/document-store.ts）：参数对象里的 status 就是把单据改成什么状态 */
const flowWriters = new Set(['writeFlowDocument', 'insertFlowDocument']);
const VARIABLE = '（变量）';
/** 调写单据的函数时参数对象里的 status：字面量（含三元两边）取值，别的写法记成“（变量）” */
const flowStatuses = (sf: ts.SourceFile, call: ts.CallExpression) =>
  call.arguments
    .filter(ts.isObjectLiteralExpression)
    .flatMap((arg) => arg.properties.filter((p) => p.name?.getText(sf) === 'status'))
    .flatMap((p) => {
      const values = ts.isPropertyAssignment(p) ? literals(p.initializer) : [];
      return (values.length ? values : [VARIABLE]).map((status) => ({ status, line: lineOf(sf, p) }));
    });

export type StatusWrite = { table: string; status: string; file: string; line: number };
/**
 * 服务端改状态的写法：调 writeFlowDocument、insertFlowDocument 时参数对象里写的 status（单据表），
 * 以及语句里 UPDATE <表> SET … status 的（每张表一条，status 记成“语句”）。
 */
export function statusWrites(tables: string[], files: { file: string; text?: string }[]): StatusWrite[] {
  const out: StatusWrite[] = [];
  const sql = new RegExp('UPDATE\\s+(' + tables.join('|') + ')\\s+SET\\b[^;]*\\bstatus\\s*=', 'i');
  for (const { file, text } of files) {
    const sf = source(file, text);
    visit(sf, (n) => {
      if (ts.isCallExpression(n) && flowWriters.has(n.expression.getText(sf)))
        for (const s of flowStatuses(sf, n)) out.push({ table: 'flow_documents', file, ...s });
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const m = sql.exec(n.text);
        if (m) out.push({ table: m[1].toLowerCase(), status: '语句', file, line: lineOf(sf, n) });
      }
    });
  }
  return out;
}
