// 前端请求地址检查（tests/checks/module-boundaries-api.ts）用的类型、常量、编译选项和语法小工具（这里的函数只看语法树，不用类型信息）。
import ts from 'typescript';
import { readdirSync, existsSync } from 'node:fs';

/** method：地址写成接口表的键（'POST /customers'）时键里的方法，别的写法看不出方法 */
export type ApiRef = { path: string; line: number; via: string; method?: string };
export type ApiUnresolved = { line: number; via: string; text: string };

export const HOLE = '\uE000',
  OPEN = '\uE001',
  CLOSE = '\uE002';
export const MAX_ALTS = 64;
const staticRoots = new Set(['assets', 'vendor', 'fonts', 'images', 'img', 'icons', 'static']);
export const apiCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  resolveJsonModule: true,
};
/** base：浏览器入口本身（fetch、href……）；否则是推出来的封装，只有实参里带了字面量才在调用处算一次。 */
export type ApiTemplate = { text: string; via: string; strict: boolean; base?: boolean };
export type ApiSite = {
  templates: ApiTemplate[];
  arg: (key: string) => ts.Expression | null;
  via: string;
};
export type ApiCtx = { params?: Map<ts.Node, string>; consumed?: Set<ts.Node>; stack: Set<ts.Node> };

export const uniq = (xs: string[]) => [...new Set(xs)].slice(0, MAX_ALTS);
export const product = (a: string[], b: string[]) => uniq(a.flatMap((x) => b.map((y) => x + y)));
export const skipOuter = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isNonNullExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isTypeAssertionExpression(e)
    ? skipOuter(e.expression)
    : e;
export const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration & { body?: ts.ConciseBody } =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);
export const nameText = (n: ts.PropertyName | ts.BindingName | ts.JsxAttributeName) =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n) ? n.text : undefined;
export const inRepo = (sf: ts.SourceFile) =>
  !sf.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(sf.fileName);
export const apiSourceFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? e.name === 'node_modules'
            ? []
            : apiSourceFiles(dir + '/' + e.name)
          : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')
            ? [dir + '/' + e.name]
            : [],
      )
    : [];

/** 接口表的键（shared/core/api-table.ts）的开头：“方法 /地址”，src/ui/call.ts 的 call 发的就是它 */
export const apiKeyStart = /^(GET|POST|PUT|PATCH|DELETE) (?=\/)/;

/** 把一条地址规范化；外部、页面跳转、相对地址返回 null，开头是变量返回 'hole'。接口表的键按后端地址算，带上键里的方法。 */
export function normalizeApiPath(
  raw: string,
): { path: string; api: boolean; static: boolean; method?: string } | null | 'hole' {
  const key = apiKeyStart.exec(raw);
  if (key) {
    const p = normalizeApiPath(raw.slice(key[0].length));
    return p && p !== 'hole' ? { ...p, api: true, static: false, method: key[1] } : p;
  }
  if (raw.startsWith(HOLE) || raw.startsWith('/' + HOLE) || raw.startsWith('/api' + HOLE))
    return 'hole';
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  let s = raw;
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  let segs = s.split('/').slice(1);
  const api = segs[0] === 'api';
  if (api) segs = segs.slice(1);
  if (segs[0]?.startsWith(HOLE)) return 'hole';
  segs = segs.filter(Boolean);
  if (!segs.length) return null;
  segs = segs.map((seg, i) => {
    if (!seg.includes(HOLE)) return seg.startsWith(':') ? ':id' : seg;
    // 末段“文字+变量”多半是 path + qs(query) 这类查询串，只留文字
    if (i === segs.length - 1 && !seg.startsWith(HOLE) && /^[^\uE000]+\uE000+$/.test(seg))
      return seg.replace(/\uE000+$/, '');
    return ':id';
  });
  if (segs[0] === ':id') return 'hole';
  const last = segs[segs.length - 1] || '';
  return {
    path: '/' + segs.join('/'),
    api,
    static: !api && (staticRoots.has(segs[0] || '') || /\.[a-z0-9]{1,5}$/i.test(last)),
  };
}

export const callTarget = (c: ts.CallExpression) => {
  const e = skipOuter(c.expression);
  return ts.isPropertyAccessExpression(e) ? e.name : e;
};
export const isStringCandidate = (n: ts.Expression) =>
  ts.isStringLiteralLike(n) ||
  ts.isTemplateExpression(n) ||
  (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
  (ts.isCallExpression(n) &&
    n.arguments.some(
      (a) =>
        ts.isStringLiteralLike(skipOuter(a)) ||
        ts.isTemplateExpression(skipOuter(a)) ||
        ts.isBinaryExpression(skipOuter(a)),
    ));
/** 往外走过括号、三元、||、??，碰到 + 或模板就说明它只是更大的字符串的一段。 */
export const isOutermost = (n: ts.Node) => {
  for (let p = n.parent, c: ts.Node = n; p; c = p, p = p.parent) {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p)
    )
      continue;
    if (ts.isConditionalExpression(p) && c !== p.condition) continue;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (k === ts.SyntaxKind.PlusToken) return false;
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) continue;
    }
    if (ts.isTemplateSpan(p)) return false;
    return true;
  }
  return true;
};
/** 不是地址的位置：import/export 的模块名、类型、属性名、动态 import()。 */
export const skipNode = (n: ts.Node) =>
  ts.isImportDeclaration(n) ||
  ts.isExportDeclaration(n) ||
  ts.isImportTypeNode(n) ||
  ts.isLiteralTypeNode(n) ||
  ts.isExternalModuleReference(n) ||
  (ts.isCallExpression(n) &&
    (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) ||
  ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
    !!n.parent &&
    (((ts.isPropertyAssignment(n.parent) ||
      ts.isPropertySignature(n.parent) ||
      ts.isMethodDeclaration(n.parent) ||
      ts.isEnumMember(n.parent)) &&
      n.parent.name === n) ||
      (ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n)));
