// 前端请求地址检查（tests/module-boundaries-api.ts）的求值部分：把字符串表达式求成地址（追声明、展开字面量联合类型、拼接）。
// 请求入口怎么认在子类 ApiAnalyzer（tests/module-api-analyzer.ts）。
import ts from 'typescript';
import { HOLE, OPEN, CLOSE, MAX_ALTS, product, skipOuter, isFunctionLike, nameText, inRepo, uniq, type ApiCtx } from './module-api-syntax.js';

export abstract class ApiEvaluator {
  readonly checker: ts.TypeChecker;
  constructor(readonly program: ts.Program) {
    this.checker = program.getTypeChecker();
  }
  /** 函数返回值可能是哪些字符串（拼地址的函数）；求值时要用，由子类按请求入口的规则给出。 */
  abstract returnsOf(fn: ts.FunctionLikeDeclaration & { body?: ts.ConciseBody }): string[];

  declOf(node: ts.Node): ts.Declaration | undefined {
    let s = this.checker.getSymbolAtLocation(node);
    for (let i = 0; s && i < 6; i++) {
      if (s.flags & ts.SymbolFlags.Alias) {
        s = this.checker.getAliasedSymbol(s);
        continue;
      }
      const d = s.valueDeclaration ?? s.declarations?.[0];
      if (d && ts.isShorthandPropertyAssignment(d)) {
        s = this.checker.getShorthandAssignmentValueSymbol(d);
        continue;
      }
      return d;
    }
    return undefined;
  }
  /** 声明对应的函数体：函数声明、箭头函数、const f = useCallback(() => …)、对象里的 f: () => …。 */
  fnOf(
    d: ts.Node | undefined,
    depth = 0,
  ): (ts.FunctionLikeDeclaration & { body?: ts.ConciseBody }) | undefined {
    if (!d || depth > 4 || !inRepo(d.getSourceFile())) return undefined;
    if (isFunctionLike(d)) return d.body ? d : undefined;
    if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) {
      let init = skipOuter(d.initializer);
      if (
        ts.isCallExpression(init) &&
        init.arguments[0] &&
        isFunctionLike(skipOuter(init.arguments[0]))
      )
        init = skipOuter(init.arguments[0]);
      if (isFunctionLike(init)) return init.body ? init : undefined;
      if (ts.isIdentifier(init)) return this.fnOf(this.declOf(init), depth + 1);
    }
    return undefined;
  }
  /** 字面量类型（含收窄）：'a' | 'b' → ['a', 'b']；不是全字面量返回 undefined。 */
  literalType(node: ts.Node): string[] | undefined {
    const t = this.checker.getTypeAtLocation(node);
    const parts = t.isUnion() ? t.types : [t];
    if (parts.length > MAX_ALTS) return undefined;
    const out: string[] = [];
    for (const p of parts) {
      if (p.isStringLiteral()) out.push(p.value);
      else if (p.isNumberLiteral()) out.push(String(p.value));
      else if (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      else return undefined;
    }
    return out.length ? out : undefined;
  }
  paramKeys(fn: ts.FunctionLikeDeclaration) {
    const keys = new Map<ts.Node, string>();
    fn.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) keys.set(p, String(i));
      else if (ts.isObjectBindingPattern(p.name))
        for (const el of p.name.elements) {
          const prop = el.propertyName ? nameText(el.propertyName) : nameText(el.name);
          if (prop && ts.isIdentifier(el.name)) keys.set(el, i + '.' + prop);
        }
    });
    return keys;
  }

  // ---------- 求值：一个表达式可能是哪些字符串（变量部分是 HOLE，所在函数的参数是 OPEN key CLOSE） ----------
  eval(e: ts.Expression, ctx: ApiCtx): string[] {
    e = skipOuter(e);
    if (ts.isStringLiteralLike(e)) {
      ctx.consumed?.add(e);
      return [e.text];
    }
    if (ts.isNumericLiteral(e)) return [e.text];
    if (ts.isTemplateExpression(e)) {
      ctx.consumed?.add(e);
      let acc = [e.head.text];
      for (const span of e.templateSpans)
        acc = product(product(acc, this.eval(span.expression, ctx)), [span.literal.text]);
      return acc;
    }
    if (ts.isBinaryExpression(e)) return this.evalBinary(e, ctx);
    if (ts.isConditionalExpression(e))
      return uniq([...this.eval(e.whenTrue, ctx), ...this.eval(e.whenFalse, ctx)]);
    if (ts.isIdentifier(e)) return this.evalIdentifier(e, ctx);
    if (ts.isPropertyAccessExpression(e)) return this.evalProperty(e, ctx);
    if (ts.isElementAccessExpression(e)) return this.literalType(e) ?? [HOLE];
    if (ts.isCallExpression(e)) return this.evalCall(e, ctx);
    return [HOLE];
  }
  /** 拼接算乘积，|| 和 ?? 两边都算，&& 算右边，别的运算是变量 */
  private evalBinary(e: ts.BinaryExpression, ctx: ApiCtx): string[] {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      ctx.consumed?.add(e);
      return product(this.eval(e.left, ctx), this.eval(e.right, ctx));
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
      return uniq([...this.eval(e.left, ctx), ...this.eval(e.right, ctx)]);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.eval(e.right, ctx);
    return [HOLE];
  }
  /** 属性：字面量类型展开；对象字面量里的属性（const paths = { list: '/customers' }; paths.list）追到属性的初始值 */
  private evalProperty(e: ts.PropertyAccessExpression, ctx: ApiCtx): string[] {
    const lit = this.literalType(e);
    if (lit) return lit;
    const decls = this.checker.getSymbolAtLocation(e.name)?.declarations || [];
    const inits = decls.flatMap((d): { d: ts.Node; init: ts.Expression }[] =>
      ts.isPropertyAssignment(d) && inRepo(d.getSourceFile())
        ? [{ d, init: d.initializer }]
        : ts.isShorthandPropertyAssignment(d)
          ? [{ d, init: d.name }]
          : [],
    );
    if (inits.length && inits.length === decls.length && inits.length <= 8)
      return uniq(inits.flatMap(({ d, init }) => this.evalDeclared(d, init, ctx)));
    return [HOLE];
  }
  private evalDeclared(d: ts.Node, init: ts.Expression, ctx: ApiCtx): string[] {
    if (ctx.stack.has(d)) return [HOLE];
    ctx.stack.add(d);
    try {
      return this.eval(init, ctx);
    } finally {
      ctx.stack.delete(d);
    }
  }
  evalIdentifier(id: ts.Identifier, ctx: ApiCtx): string[] {
    const d = this.declOf(id);
    const lit = this.literalType(id);
    if (!d) return lit ?? [HOLE];
    if (ctx.params?.has(d)) return lit ?? [OPEN + ctx.params.get(d) + CLOSE];
    if (
      ts.isVariableDeclaration(d) &&
      d.initializer &&
      ts.isIdentifier(d.name) &&
      inRepo(d.getSourceFile())
    ) {
      const v = this.evalDeclared(d, d.initializer, ctx);
      // 收窄后的字面量类型更准（const kind = x.kind; if (kind === 'a') …）
      return lit && lit.every((x) => v.includes(x) || v.some((y) => y.includes(HOLE))) ? lit : v;
    }
    if (lit) return lit;
    // 带默认值的参数（baseUrl = '/api/ai/prompts'）：默认值和“调用方传进来的”两种都算
    if ((ts.isParameter(d) || ts.isBindingElement(d)) && d.initializer)
      return uniq([...this.evalDeclared(d, d.initializer, ctx), HOLE]);
    return [HOLE];
  }
  /** 调用拼地址的函数（exportHref、lookupPath、qs……）：代入实参求它的返回值。 */
  evalCall(call: ts.CallExpression, ctx: ApiCtx): string[] {
    const callee = skipOuter(call.expression);
    const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const fn = this.fnOf(this.declOf(target));
    if (!fn) return [HOLE];
    // 返回值里和实参无关的固定地址（lookupPath 的 '/warehouse/items'）在那个函数自己的文件里算，这里不再算一次
    const rets = this.returnsOf(fn).filter((x) => x.includes(OPEN) || !x.startsWith('/'));
    if (!rets.length) return [HOLE];
    const arg = (key: string) => this.argOf(call.arguments, key);
    return uniq(rets.flatMap((t) => this.substitute(t, (k) => this.evalArg(arg(k), ctx))));
  }
  evalArg(e: ts.Expression | null, ctx: ApiCtx) {
    return e ? this.eval(e, ctx) : [''];
  }
  argOf(args: readonly ts.Expression[] | undefined, key: string): ts.Expression | null {
    const [i, prop] = key.split('.');
    const a = args?.[Number(i)];
    if (!a) return null;
    if (prop === undefined) return a;
    const o = skipOuter(a);
    if (!ts.isObjectLiteralExpression(o)) return null;
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && nameText(p.name) === prop) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop) return p.name;
    }
    return null;
  }
  substitute(text: string, valueOf: (key: string) => string[]): string[] {
    const parts = text.split(/\uE001([^\uE002]*)\uE002/);
    const memo = new Map<string, string[]>();
    let acc = [''];
    parts.forEach((p, i) => {
      if (i % 2 === 0) acc = product(acc, [p]);
      else {
        let values = memo.get(p);
        if (!values) {
          values = valueOf(p);
          memo.set(p, values);
        }
        acc = product(acc, values);
      }
    });
    return acc;
  }

}