// 前端请求地址检查（tests/checks/module-boundaries-api.ts）的请求入口部分：认出浏览器入口和项目里自动推出来的封装，取出一个文件里的全部地址。
import ts from 'typescript';
import { ApiEvaluator } from './module-api-eval.js';
import { HOLE, OPEN, CLOSE, MAX_ALTS, apiKeyStart, normalizeApiPath, skipOuter, isFunctionLike, nameText, inRepo, uniq, callTarget, isStringCandidate, isOutermost, skipNode, type ApiCtx, type ApiRef, type ApiSite, type ApiTemplate, type ApiUnresolved } from './module-api-syntax.js';

type Fn = ts.FunctionLikeDeclaration & { body?: ts.ConciseBody };
/** 一处取到的地址：alts 是求出来的几种写法；request 是请求入口的实参，strict 是真正发请求的入口；text 是查不到时记下的原文 */
type Found = { alts: string[]; at: ts.Node; via: string; request: boolean; strict: boolean; text: string };
/** map 里这个键的值，没有就放一个新的进去 */
const entry = <K, V>(map: Map<K, V>, key: K, make: () => V) => {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
};

export class ApiAnalyzer extends ApiEvaluator {
  private sinkMemo = new Map<ts.Node, ApiTemplate[]>();
  private returnMemo = new Map<ts.Node, string[]>();
  private busy = new Set<ts.Node>();
  private callbacks?: Map<ts.Node, Map<string, Fn[]>>;

  // ---------- 请求入口：浏览器入口 + 自动推出来的封装 ----------
  /** 一个节点是不是一次请求（或链接）：返回它的地址模板和取实参的办法。 */
  site(n: ts.Node): ApiSite | undefined {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = skipOuter(n.expression);
      const args = n.arguments;
      const arg = (key: string) => this.argOf(args, key);
      const base = this.baseSink(n, callee);
      if (base) return { templates: [base], arg, via: base.via };
      if (ts.isNewExpression(n)) return undefined;
      const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      if (!ts.isIdentifier(target)) return undefined;
      const templates = this.templatesOf(this.declOf(target));
      return templates.length
        ? { templates, arg, via: callee.getText().replace(/\s+/g, '') }
        : undefined;
    }
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const attr = (key: string): ts.Expression | null => {
        const [i, prop] = key.split('.');
        if (i !== '0' || !prop) return null;
        for (const a of n.attributes.properties)
          if (ts.isJsxAttribute(a) && nameText(a.name) === prop && a.initializer)
            return ts.isJsxExpression(a.initializer)
              ? (a.initializer.expression ?? null)
              : ts.isStringLiteral(a.initializer)
                ? a.initializer
                : null;
        return null;
      };
      const tag = n.tagName;
      if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) {
        const names = ['href', 'src', 'action', 'data', 'poster'].filter((x) => attr('0.' + x));
        return names.length
          ? {
              templates: names.map((x) => ({
                text: OPEN + '0.' + x + CLOSE,
                via: '<' + tag.text + ' ' + x + '>',
                strict: false,
                base: true,
              })),
              arg: attr,
              via: '<' + tag.text + '>',
            }
          : undefined;
      }
      const templates = this.templatesOf(this.declOf(tag));
      return templates.length
        ? { templates, arg: attr, via: '<' + tag.getText() + '>' }
        : undefined;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = skipOuter(n.left);
      const linkProp =
        ts.isPropertyAccessExpression(left) && ['href', 'src', 'action'].includes(left.name.text);
      if (linkProp || (ts.isIdentifier(left) && left.text === 'location'))
        return {
          templates: [
            { text: OPEN + '0' + CLOSE, via: left.getText() + ' =', strict: false, base: true },
          ],
          arg: (k) => (k === '0' ? n.right : null),
          via: left.getText() + ' =',
        };
    }
    return undefined;
  }
  private browserSink(
    n: ts.CallExpression | ts.NewExpression,
    callee: ts.Expression,
  ): ApiTemplate | undefined {
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    const owner = ts.isPropertyAccessExpression(callee)
      ? skipOuter(callee.expression).getText()
      : '';
    const t = (strict: boolean): ApiTemplate => ({
      text: OPEN + '0' + CLOSE,
      via: callee.getText().replace(/\s+/g, ''),
      strict,
      base: true,
    });
    if (ts.isNewExpression(n))
      return ['EventSource', 'WebSocket', 'Request', 'Worker'].includes(name) &&
        ts.isIdentifier(callee)
        ? t(true)
        : undefined;
    const global = (decl: ts.Declaration | undefined) => !decl || !inRepo(decl.getSourceFile());
    if (
      name === 'fetch' &&
      (ts.isIdentifier(callee)
        ? global(this.declOf(callee))
        : ['window', 'globalThis', 'self'].includes(owner))
    )
      return t(true);
    if (name === 'sendBeacon' && owner === 'navigator') return t(true);
    if (name === 'open' && owner === 'window') return t(false);
    if ((name === 'assign' || name === 'replace') && /(^|\.)location$/.test(owner)) return t(false);
    return undefined;
  }
  /** 请求入口本身：浏览器入口，或者按接口表的键发的调用 */
  private baseSink(n: ts.CallExpression | ts.NewExpression, callee: ts.Expression) {
    return this.browserSink(n, callee) ?? (ts.isCallExpression(n) ? this.keySink(n, callee) : undefined);
  }
  /**
   * 按接口表发的请求（src/ui/call.ts 的 call 返回的函数，或再包一层的）：第一个参数是“方法 /地址”的键，键本身就是地址。
   * 不看函数名，看实参：字面量、模板、拼接、三元的开头是键，或者实参（变量、属性、对象元素、数组元素、函数返回值……）
   * 的类型是键的字面量联合（keyof 接口表、按动作拼的模板类型、as const 的表）。
   */
  private keySink(n: ts.CallExpression, callee: ts.Expression): ApiTemplate | undefined {
    const first = n.arguments[0];
    if (!first || !this.isApiKey(first)) return undefined;
    return { text: OPEN + '0' + CLOSE, via: callee.getText().replace(/\s+/g, ''), strict: true, base: true };
  }
  private isApiKey(arg: ts.Expression): boolean {
    const e = skipOuter(arg);
    if (ts.isStringLiteralLike(e)) return apiKeyStart.test(e.text);
    if (ts.isTemplateExpression(e)) return apiKeyStart.test(e.head.text);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return this.isApiKey(e.left);
    if (ts.isConditionalExpression(e)) return this.isApiKey(e.whenTrue) || this.isApiKey(e.whenFalse);
    // 一看就不是文字的不问类型；别的写法（变量、属性、对象元素、数组元素、函数返回值……）看它的字面量类型
    if (
      ts.isObjectLiteralExpression(e) ||
      ts.isArrayLiteralExpression(e) ||
      isFunctionLike(e) ||
      ts.isNumericLiteral(e) ||
      ts.isNewExpression(e)
    )
      return false;
    const values = this.literalType(e);
    return !!values && values.every((v) => apiKeyStart.test(v));
  }
  /** 一个函数（或组件、回调参数）把哪些参数拼进了请求地址。结果按声明缓存。 */
  templatesOf(d: ts.Declaration | undefined): ApiTemplate[] {
    if (!d) return [];
    if (ts.isParameter(d) || ts.isBindingElement(d)) return this.callbackTemplates(d);
    const fn = this.fnOf(d);
    if (!fn) return [];
    const memo = this.sinkMemo.get(fn);
    if (memo) return memo;
    if (this.busy.has(fn)) return [];
    this.busy.add(fn);
    const params = this.paramKeys(fn);
    const out: ApiTemplate[] = [];
    if (params.size) {
      const ctx: ApiCtx = { params, stack: new Set() };
      const visit = (n: ts.Node) => {
        const s = this.site(n);
        if (s)
          for (const t of s.templates)
            for (const alt of this.substitute(t.text, (k) => this.evalArg(s.arg(k), ctx)))
              if (alt.includes(OPEN) && !out.some((o) => o.text === alt))
                out.push({ text: alt, via: t.via, strict: t.strict });
        ts.forEachChild(n, visit);
      };
      if (fn.body) visit(fn.body);
    }
    this.busy.delete(fn);
    const result = out.slice(0, MAX_ALTS);
    this.sinkMemo.set(fn, result);
    return result;
  }
  /** 函数返回值可能是哪些字符串（拼地址的函数）。 */
  returnsOf(fn: ts.FunctionLikeDeclaration & { body?: ts.ConciseBody }): string[] {
    const memo = this.returnMemo.get(fn);
    if (memo) return memo;
    if (this.busy.has(fn) || !fn.body) return [];
    this.busy.add(fn);
    const ctx: ApiCtx = { params: this.paramKeys(fn), stack: new Set() };
    let out: string[] = [];
    if (!ts.isBlock(fn.body)) out = this.eval(fn.body, ctx);
    else {
      const visit = (n: ts.Node) => {
        if (isFunctionLike(n) || ts.isClassLike(n)) return;
        if (ts.isReturnStatement(n) && n.expression)
          out = uniq([...out, ...this.eval(n.expression, ctx)]);
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
    }
    this.busy.delete(fn);
    // 全是变量的返回值不算拼地址
    if (out.every((x) => x === HOLE)) out = [];
    this.returnMemo.set(fn, out);
    return out;
  }
  /** 回调参数（比如 ArrivalDraftPanel 的 assistantRequest）：到 JSX 里找传进来的函数，用它们的模板。 */
  private callbackTemplates(d: ts.ParameterDeclaration | ts.BindingElement): ApiTemplate[] {
    let prop: string | undefined, param: ts.ParameterDeclaration | undefined;
    if (ts.isBindingElement(d)) {
      prop = d.propertyName ? nameText(d.propertyName) : nameText(d.name);
      const pattern = d.parent;
      if (ts.isObjectBindingPattern(pattern) && ts.isParameter(pattern.parent))
        param = pattern.parent;
    }
    if (!param || !prop || param.parent.parameters.indexOf(param) !== 0) return [];
    const owner = param.parent;
    const fns = this.callbackIndex().get(owner)?.get(prop) || [];
    const out: ApiTemplate[] = [];
    for (const f of fns)
      for (const t of this.templatesOf(f))
        if (!out.some((o) => o.text === t.text)) out.push(t);
    return out;
  }
  private callbackIndex() {
    if (this.callbacks) return this.callbacks;
    const index = new Map<ts.Node, Map<string, Fn[]>>();
    this.callbacks = index;
    for (const sf of this.program.getSourceFiles()) {
      if (!inRepo(sf)) continue;
      const visit = (n: ts.Node) => {
        if (
          (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
          ts.isIdentifier(n.tagName) &&
          /^[A-Z]/.test(n.tagName.text)
        ) {
          let owner: ts.Node | undefined;
          for (const a of n.attributes.properties) {
            if (
              !ts.isJsxAttribute(a) ||
              !a.initializer ||
              !ts.isJsxExpression(a.initializer) ||
              !a.initializer.expression
            )
              continue;
            const v = skipOuter(a.initializer.expression);
            const fn = isFunctionLike(v)
              ? v
              : ts.isIdentifier(v)
                ? this.fnOf(this.declOf(v))
                : undefined;
            if (!fn) continue;
            owner ??= this.fnOf(this.declOf(n.tagName));
            const name = nameText(a.name);
            if (!owner || !name) continue;
            const byProp = entry(index, owner, () => new Map<string, Fn[]>());
            entry(byProp, name, (): Fn[] => []).push(fn);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return index;
  }

  // ---------- 一个文件 ----------
  /** 一个文件里的地址；roots 是登记过的后端地址根前缀（customers、flow……），开头是它们的不在请求入口里也算 */
  refs(source: ts.SourceFile, roots: ReadonlySet<string>) {
    const refs: ApiRef[] = [];
    const unresolved: ApiUnresolved[] = [];
    const consumed = new Set<ts.Node>();
    const line = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
    const add = ({ alts, at, via, request, strict, text }: Found) => {
      for (const alt of alts) {
        const p = normalizeApiPath(alt);
        if (p === null) continue;
        if (p === 'hole') {
          if (request && !unresolved.some((u) => u.line === line(at) && u.text === text))
            unresolved.push({ line: line(at), via, text });
          continue;
        }
        const registered = roots.has(p.path.split('/')[1] || '');
        if (!(p.api || registered || (request && strict && !p.static))) continue;
        const ref: ApiRef = { path: p.path, line: line(at), via, ...(p.method ? { method: p.method } : {}) };
        if (!refs.some((r) => r.path === ref.path && r.line === ref.line && r.method === ref.method)) refs.push(ref);
      }
    };
    // 第一遍：请求入口。实参里的字面量（顺着变量追到的也算）记为已用，第二遍不再按原样算
    const visitSites = (n: ts.Node) => {
      const s = this.site(n);
      if (s)
        for (const t of s.templates) {
          const ctx: ApiCtx = { consumed, stack: new Set() };
          const keys = [...t.text.matchAll(/\uE001([^\uE002]*)\uE002/g)].map((m) => m[1]);
          const argNode = keys.map((k) => s.arg(k)).find((x): x is ts.Expression => !!x);
          if (!argNode) continue;
          const values = new Map(keys.map((k) => [k, this.evalArg(s.arg(k), ctx)]));
          let alts = this.substitute(t.text, (k) => values.get(k) ?? ['']);
          if (!t.base) {
            // 封装的地址前缀在封装自己的文件里已经算过。地址按字面量所在文件的模块算：调用处的实参没让地址多出一段
            // （只传了编号、查询参数，比如借用别的模块的组件 <BatchCard purchaseId={id} />），这里就不再算一次
            const own = new Set(
              this.substitute(t.text, () => [HOLE]).map((x) => JSON.stringify(normalizeApiPath(x))),
            );
            alts = alts.filter((x) => {
              const p = normalizeApiPath(x);
              return !!p && p !== 'hole' && !own.has(JSON.stringify(p));
            });
          }
          add({ alts, at: argNode, via: s.via, request: true, strict: t.strict, text: argNode.getText(source).slice(0, 80) });
        }
      ts.forEachChild(n, visitSites);
    };
    visitSites(source);
    // 第二遍：其余字符串表达式整体求值
    const visitStrings = (n: ts.Node) => {
      if (skipNode(n)) return;
      if (ts.isExpression(n) && isStringCandidate(n) && isOutermost(n) && !consumed.has(n)) {
        let builder = true;
        if (ts.isCallExpression(n)) {
          // 只算“实参会拼进返回地址”的函数（exportHref 这类）；别的调用只看它的字符串实参
          const fn = this.fnOf(this.declOf(callTarget(n)));
          builder = !!fn && this.returnsOf(fn).some((x) => x.includes(OPEN));
        }
        if (builder)
          add({
            alts: this.eval(n, { consumed, stack: new Set() }),
            at: n,
            via: ts.isCallExpression(n) ? n.expression.getText(source).replace(/\s+/g, '') : 'string',
            request: false,
            strict: false,
            text: '',
          });
      }
      ts.forEachChild(n, visitStrings);
    };
    visitStrings(source);
    return { refs: refs.sort((a, b) => a.line - b.line), unresolved };
  }
}