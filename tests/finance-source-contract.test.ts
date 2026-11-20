// 财务和业务之间写在两边的两条约定（只用虚构数据，不读库）：
// 1. 到货、送货、完工单的说明字段（“编辑”能改的那几项，和结构里所有叫 notes 的备注）改了，财务的来源指纹不变，
//    财务不会因为改个备注就新增、替换财务事件。说明字段从业务的 documentInfoFields 和单据结构里取，指纹用财务的 sourceHash 真算。
// 2. 财务事件快照的结构（server/finance/source-snapshot.ts）里点名去读的单据字段，业务的单据结构（shared/business/flow-document.ts）
//    里都有：业务改了字段名，财务那份宽松结构照样解析通过、只会悄悄读成空，这条把它拦下来。
//    财务那份结构没有导出，按源码的语法树读（顺着 eventSnapshot 的 doc 往下找 z.object 的字段）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { documentInfoFields } from '../server/flow/document-info.js';
import { sourceHash } from '../server/finance/source-fingerprint.js';
import { flowContentSchema } from '../shared/business/flow-document.js';
import { scriptKind } from './module-map.js';
import { fieldSteps, fieldPaths, pathText, type FieldStep } from './zod-fields.js';

/** 进财务的三种单据 */
const financeKinds = ['arrival', 'delivery', 'production'] as const;
type FinanceKind = (typeof financeKinds)[number];

// ---------- 约定 1：说明字段不进来源指纹 ----------

/** 这种单据的说明字段：“编辑”能改的几项（documentInfoFields），加上结构里每一处叫 notes 的备注（明细备注、纸板资料备注） */
function infoPaths(kind: FinanceKind): FieldStep[][] {
  const editable = (documentInfoFields[kind] ?? []).map((key) => [{ key, list: false }]);
  const notes = fieldSteps(flowContentSchema(kind)).filter((path) => path.at(-1)?.key === 'notes');
  return [...new Map([...editable, ...notes].map((path) => [pathText(path), path])).values()];
}

/** 按路径造一份只有这一项的单据内容：一组的那一层放一行 */
function docWith(path: readonly FieldStep[], value: string): Record<string, unknown> {
  const [step, ...rest] = path;
  if (!step) return {};
  const inner = rest.length ? docWith(rest, value) : value;
  return { [step.key]: step.list ? [inner] : inner };
}

type Hash = (source: { kind: string; status: string; date: string }, doc: unknown) => string;
/** 改了以后来源指纹跟着变的说明字段（应该一个都没有）：同一张单据只差这一项，算两次指纹比 */
function infoFieldsInFingerprint(kind: FinanceKind, paths: readonly FieldStep[][], hash: Hash = sourceHash) {
  const source = { kind, status: 'confirmed', date: '2026-01-01' };
  return paths.filter((path) => hash(source, docWith(path, '虚构说明甲')) !== hash(source, docWith(path, '虚构说明乙'))).map(pathText);
}

test('到货、送货、完工单的说明字段改了，财务的来源指纹不变', () => {
  for (const kind of financeKinds) {
    const paths = infoPaths(kind);
    assert.ok(paths.some((p) => pathText(p) === 'notes'), kind + ' 找到了说明字段');
    assert.deepEqual(
      infoFieldsInFingerprint(kind, paths),
      [],
      `${kind} 的这些说明字段算进了财务的来源指纹：改个备注就会让财务新增或替换事件。` +
        '请把它们加进 server/finance/source-fingerprint.ts 的 outsideFinance（不算进指纹的名单）',
    );
  }
});

test('说明字段的检查真的会拦：财务名单里没有的说明字段被报出来，名单里有的放过', () => {
  const made = [[{ key: '虚构的新说明', list: false }], [{ key: 'lines', list: true }, { key: '虚构明细说明', list: false }]];
  assert.deepEqual(infoFieldsInFingerprint('delivery', made), ['虚构的新说明', 'lines.虚构明细说明']);
  assert.deepEqual(infoFieldsInFingerprint('delivery', [[{ key: 'notes', list: false }]]), []);
});

// ---------- 约定 2：财务快照点名的字段，业务单据结构里都有 ----------

const SNAPSHOT_FILE = 'server/finance/source-snapshot.ts';
/** 财务快照里有、业务单据内容里本来就没有的字段，和原因。字段不再是这样（业务有了、或财务不再点名）时要删掉这一条 */
const financeOnlyFields: Record<string, string> = {
  number: '单号：库里的单据内容不存单号，同步时按单据表的单号列补进快照（server/finance/source-fingerprint.ts 的 withNumber）',
};

type Constants = Map<string, ts.Expression>;
/** 文件顶层 const 的初值 */
function constantsOf(source: ts.SourceFile): Constants {
  const out: Constants = new Map();
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
  return out;
}
/** z.<名字>(…) 这种调用 */
const isZodCall = (n: ts.CallExpression, names: readonly string[]) =>
  ts.isPropertyAccessExpression(n.expression) &&
  ts.isIdentifier(n.expression.expression) &&
  n.expression.expression.text === 'z' &&
  names.includes(n.expression.name.text);
const MAX_DEPTH = 12;
/** 建对象的 z.* */
const objectMakers = ['object', 'strictObject', 'looseObject'];
/** 建单个值的 z.*：读到它就是叶子字段，没有下一层 */
const leafMakers = ['string', 'number', 'boolean', 'bigint', 'enum', 'literal', 'json', 'null', 'unknown', 'any', 'date', 'iso', 'uuid'];
/** 只加限制、不改字段的链式方法：顺着前面的结构往下读 */
const passThrough = [
  ...['optional', 'nullable', 'nullish', 'default', 'prefault', 'catch', 'catchall', 'readonly', 'describe', 'meta'],
  ...['refine', 'superRefine', 'check', 'trim', 'min', 'max', 'length', 'int', 'positive', 'nonnegative', 'regex'],
];

/** 认不出的写法：写明哪个字段、什么写法、怎么改 */
const unreadable = (where: string, expr: ts.Node, why: string) =>
  new Error(
    `${SNAPSHOT_FILE} 的快照结构里“${where}”这一项认不出（${expr.getText()}）：${why}。` +
      '请在本文件里直接用 z.object({…}) 列字段，或改 tests/finance-source-contract.test.ts 的读法',
  );

/**
 * 顺着表达式找到 z.object({…}) 的字段表（.extend({…}) 加的字段并进来）：同文件的常量、.optional() 这类链式调用、
 * z.array(…) 都跟进去；z.string() 这类单个值返回 null（叶子）；认不出的写法一律报错，不当成叶子悄悄放过
 */
function objectLiteralsOf(expr: ts.Expression, consts: Constants, where: string, depth = 0): ts.ObjectLiteralExpression[] | null {
  if (depth > MAX_DEPTH) throw unreadable(where, expr, '嵌套太深');
  const next = (e: ts.Expression) => objectLiteralsOf(e, consts, where, depth + 1);
  if (ts.isParenthesizedExpression(expr)) return next(expr.expression);
  if (ts.isIdentifier(expr)) {
    const init = consts.get(expr.text);
    if (!init) throw unreadable(where, expr, `本文件找不到“${expr.text}”的定义（可能是从别的文件引进来的结构）`);
    return next(init);
  }
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression))
    throw unreadable(where, expr, '不是 z.xxx(…) 或 结构.方法(…) 的写法');
  const [first] = expr.arguments,
    method = expr.expression.name.text;
  if (isZodCall(expr, objectMakers)) {
    if (first && ts.isObjectLiteralExpression(first)) return [first];
    throw unreadable(where, expr, '字段表要直接写在 z.object({…}) 的括号里');
  }
  if (isZodCall(expr, ['array']) && first) return next(first);
  if (isZodCall(expr, leafMakers)) return null;
  if (isZodCall(expr, [method])) throw unreadable(where, expr, `不认识 z.${method}`);
  if (method === 'extend') {
    const base = next(expr.expression.expression);
    if (!base || !first || !ts.isObjectLiteralExpression(first)) throw unreadable(where, expr, '.extend 要接在对象结构后面，参数直接写 {…}');
    return [...base, first];
  }
  if (passThrough.includes(method)) return next(expr.expression.expression);
  throw unreadable(where, expr, `不认识 .${method}(…)`);
}

/** 字段表里每个字段的路径（数组那一层不写），嵌套的对象跟进去；认不出的写法（展开、算出来的键名）直接报错 */
function literalPaths(literals: readonly ts.ObjectLiteralExpression[], consts: Constants, prefix = ''): string[] {
  return literals.flatMap((literal) =>
    literal.properties.flatMap((p) => {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
        throw unreadable(prefix || 'doc', p, '只认“字段名: 结构”的写法，不认展开和算出来的键名');
      const path = prefix + p.name.text,
        nested = objectLiteralsOf(p.initializer, consts, path);
      return [path, ...(nested ? literalPaths(nested, consts, path + '.') : [])];
    }),
  );
}

/** 财务快照（eventSnapshot 的 doc）点名的单据字段路径；text 不给就读源文件 */
function snapshotDocPaths(text = readFileSync(SNAPSHOT_FILE, 'utf8')): string[] {
  const source = ts.createSourceFile(SNAPSHOT_FILE, text, ts.ScriptTarget.Latest, true, scriptKind(SNAPSHOT_FILE));
  const consts = constantsOf(source),
    snapshot = consts.get('eventSnapshot'),
    root = snapshot ? objectLiteralsOf(snapshot, consts, 'eventSnapshot') : null;
  const doc = root
    ?.flatMap((literal) => literal.properties)
    .find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'doc');
  const docLiteral = doc && ts.isPropertyAssignment(doc) ? objectLiteralsOf(doc.initializer, consts, 'doc') : null;
  if (!docLiteral)
    throw new Error(`${SNAPSHOT_FILE} 里找不到 eventSnapshot 的 doc 这一项的 z.object 字段表：快照结构换了写法或位置，请同步改这条检查`);
  return literalPaths(docLiteral, consts);
}

/** 财务点名、业务结构里没有又没登记原因的字段；登记了但已经不是这样的（业务有了，或财务不再点名）也报 */
function snapshotFieldProblems(finance: readonly string[], flow: ReadonlySet<string>, registered: Record<string, string>) {
  const missing = finance.filter((p) => !flow.has(p) && !Object.hasOwn(registered, p));
  const stale = Object.keys(registered).filter((p) => flow.has(p) || !finance.includes(p));
  return { missing, stale };
}

/** 三种单据库里内容的全部字段路径 */
const flowPaths = () => new Set(financeKinds.flatMap((kind) => fieldPaths(flowContentSchema(kind))));

test('财务快照点名去读的单据字段，业务的单据结构里都有', () => {
  const finance = snapshotDocPaths();
  assert.ok(finance.includes('lines.quantity') && finance.includes('lines.item.name'), '读到了财务快照的明细和纸板资料字段');
  const { missing, stale } = snapshotFieldProblems(finance, flowPaths(), financeOnlyFields);
  assert.deepEqual(
    missing,
    [],
    `${SNAPSHOT_FILE} 的财务快照点名了这些字段，可 shared/business/flow-document.ts 的单据结构里没有：业务改名或删了字段，` +
      '财务会悄悄读成空。请让两边用同一个字段名；确实是财务自己补进快照的，在本测试的 financeOnlyFields 登记原因',
  );
  assert.deepEqual(stale, [], '本测试 financeOnlyFields 里这几条已经不成立（业务结构里有了，或财务快照不再点名），请删掉');
});

test('快照字段的检查真的会拦：业务结构里没有的报出来，有的放过，过期的登记也报', () => {
  const made = `const z = {};
const item = z.object({ name: z.string(), 虚构纸板项: z.string() });
const line = z.object({ quantity: z.string(), item: item.optional() }).catchall(z.json());
const eventSnapshot = z.strictObject({ doc: z.object({ number: z.string(), lines: z.array(line).optional() }).optional() });`;
  const paths = snapshotDocPaths(made);
  assert.deepEqual(paths, ['number', 'lines', 'lines.quantity', 'lines.item', 'lines.item.name', 'lines.item.虚构纸板项']);
  const flow = new Set(['lines', 'lines.quantity', 'lines.item', 'lines.item.name']);
  assert.deepEqual(snapshotFieldProblems(paths, flow, { number: '虚构原因' }), { missing: ['lines.item.虚构纸板项'], stale: [] });
  assert.deepEqual(snapshotFieldProblems(paths, flow, { number: '虚构原因', 虚构旧字段: '虚构原因' }).stale, ['虚构旧字段']);
  assert.throws(() => snapshotDocPaths('const eventSnapshot = z.strictObject({ money: z.number() });'), /找不到 eventSnapshot 的 doc/);
});

test('快照结构的读法认不出的写法一律报错，.extend 加的字段并进来', () => {
  const withDoc = (doc: string, extra = '') => `${extra}\nconst eventSnapshot = z.strictObject({ doc: ${doc} });`;
  const extended = withDoc('base.extend({ 虚构加的字段: z.string() }).optional()', 'const base = z.object({ number: z.string() });');
  assert.deepEqual(snapshotDocPaths(extended), ['number', '虚构加的字段']);
  // 别的文件引进来的结构、自己写的辅助函数、不认识的方法：都报错，写明是哪一项
  assert.throws(() => snapshotDocPaths(withDoc('z.object({ lines: z.array(importedLine) })')), /“lines”这一项认不出.*找不到“importedLine”的定义/);
  assert.throws(() => snapshotDocPaths(withDoc('z.object({ item: helper(z.object({})) })')), /“item”这一项认不出.*不是 z\.xxx/);
  assert.throws(() => snapshotDocPaths(withDoc('z.object({ item: z.object({}).merge(other) })')), /“item”这一项认不出.*不认识 \.merge/);
  assert.throws(() => snapshotDocPaths(withDoc('z.object({ item: z.union([a, b]) })')), /“item”这一项认不出.*不认识 z\.union/);
  assert.throws(() => snapshotDocPaths(withDoc('z.object({ ...rest })')), /“doc”这一项认不出.*不认展开/);
});
