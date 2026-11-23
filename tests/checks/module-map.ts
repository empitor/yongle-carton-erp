// 模块表和取引用的解析器：每个文件属于哪个模块、能用哪些模块，一个文件引用了哪些项目文件。
// 模块表和理由见 docs/架构说明.md“模块”一节；改这里的规则要同时改那一节。
// 规则的检查在 module-boundaries.test.ts（引用、模块内分层）、module-narrow-refs.test.ts（只许用对方几个名字的窄引用）、module-api-owners.test.ts（前端请求的地址）、
// module-table-owners.test.ts（表）、css-modules.test.ts（样式的类名，前端模块和层都读这张表）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

/** 模块里的一层：paths 写法和模块的一样（目录带末尾斜杠，单个文件写全名） */
export type Layer = { name: string; paths: string[] };
/** layers：模块内部从下往上分层，同一模块里只能引同层或下层（module-boundaries 查）；模块的每个文件都要落在某一层，入口 index.ts、pages.ts 可以不登记 */
export type Rule = { name: string; paths: string[]; allow: string[]; layers?: Layer[] };

// 越往下越基础。paths 按最长前缀匹配；目录写到末尾的斜杠，单个文件写全名。
// allow 和实际用到的一致（module-boundaries 有测试查）：新用到一个模块就在这里加上，不再用了就删掉，架构图跟着改。
export const modules: Rule[] = [
  // 服务端
  {
    name: '基础',
    paths: ['server/core/'],
    allow: ['共用-基础'],
    layers: [
      { name: '请求和报错', paths: ['server/core/http/'] },
      { name: '文件校验', paths: ['server/core/files/'] },
      { name: 'SQLite 基础', paths: ['server/core/storage/sqlite/'] },
      { name: '业务库结构', paths: ['server/core/schema/'] },
      { name: '记录种类登记', paths: ['server/core/records/kinds/'] },
      { name: '业务库存储', paths: ['server/core/storage/'] },
      { name: '记录维护', paths: ['server/core/records/'] },
      { name: '备份和配置库', paths: ['server/core/backup/'] },
      { name: '出错记录', paths: ['server/core/diagnostics/'] },
    ],
  },
  { name: '账号', paths: ['server/accounts/'], allow: ['基础', '共用-基础'] },
  { name: 'AI接入', paths: ['server/ai/'], allow: ['基础', '共用-基础', '共用-AI'] },
  // 系统资料：运行日志、读程序代码、使用手册，只有助手和装配在用（出错记录是请求关卡和页面上报写的，留在基础）
  { name: '系统资料', paths: ['server/system/'], allow: ['基础', '共用-基础', '共用-系统资料'] },
  { name: '客户产品订单', paths: ['server/sales/'], allow: ['基础', '共用-基础', '共用-业务'] },
  // 业务主线只能往下：客户产品订单 ← 采购库存 ← 单据流转 ← 删除归档 ← 订单服务 ← 业务总览
  {
    name: '采购库存',
    paths: ['server/operations/'],
    allow: ['基础', '客户产品订单', '共用-基础', '共用-业务'],
    // 从下往上：账和读（写流水和采购明细、按编号读、库存品内容的规格）← 库存品、订货单 ← 采购单 ← 服务和路由（服务、路由、删除登记）；层名不用模块名，免得被当成跨模块的层
    layers: [
      { name: '账和读', paths: ['server/operations/ledger/'] },
      { name: '库存品和订货单', paths: ['server/operations/stock/', 'server/operations/batches/'] },
      { name: '采购单', paths: ['server/operations/purchases/'] },
      { name: '服务和路由', paths: ['server/operations/router.ts', 'server/operations/deletion.ts', 'server/operations/service.ts'] },
    ],
  },
  {
    name: '单据流转',
    paths: ['server/flow/'],
    allow: ['基础', '客户产品订单', '采购库存', '共用-基础', '共用-业务'],
    // 从下往上：单据存取（存取、读、关联、只读窗口）← 规则和服务（核对、预览、确认、撤销、订单进度、FlowService、采购库存的完整视图和保存入口）
    // ← 按种类（到货、生产、送货）← 更正（三种更正、编辑说明）← 路由和台账（路由、删除登记、跨种类的仓库台账）
    layers: [
      { name: '单据存取', paths: ['server/flow/documents/', 'server/flow/finance-facts/'] },
      { name: '规则和服务', paths: ['server/flow/rules/', 'server/flow/stock/'] },
      { name: '按种类', paths: ['server/flow/arrival/', 'server/flow/production/', 'server/flow/delivery/'] },
      { name: '更正', paths: ['server/flow/correction/'] },
      { name: '路由和台账', paths: ['server/flow/daily.ts', 'server/flow/deletion.ts', 'server/flow/router.ts', 'server/flow/stock-router.ts'] },
    ],
  },
  { name: '删除归档', paths: ['server/lifecycle/'], allow: ['基础', '客户产品订单', '采购库存', '单据流转', '共用-基础', '共用-业务'] },
  { name: '订单服务', paths: ['server/orders/'], allow: ['基础', '客户产品订单', '采购库存', '单据流转', '删除归档', '共用-基础', '共用-业务'] },
  { name: '业务总览', paths: ['server/overview/'], allow: ['基础', '客户产品订单', '采购库存', '单据流转', '删除归档', '订单服务', '共用-基础', '共用-业务'] },
  // 财务用单据流转只许经只读窗口 financeFacts（module-narrow-refs.test.ts）
  { name: '财务', paths: ['server/finance/'], allow: ['基础', '单据流转', '共用-基础', '共用-业务', '共用-财务'] },
  {
    name: '单据导出',
    paths: ['server/documents/'],
    allow: ['基础', '客户产品订单', '采购库存', '单据流转', '共用-基础', '共用-业务', '共用-单据'],
  },
  {
    name: '识别导入',
    paths: ['server/import/', 'server/inbox/'],
    allow: ['基础', '客户产品订单', 'AI接入', '单据流转', '共用-基础', '共用-AI', '共用-识别'],
  },
  {
    name: '数据管理',
    paths: ['server/admin/'],
    // 识别导入只引类型：识别导入的管理对象由装配传进来
    allow: ['基础', '采购库存', '单据流转', '删除归档', '订单服务', '业务总览', '识别导入', '共用-基础', '共用-业务', '共用-管理'],
  },
  {
    name: '助手',
    paths: ['server/assistant/'],
    allow: ['基础', '客户产品订单', 'AI接入', '系统资料', '采购库存', '单据流转', '删除归档', '订单服务', '业务总览', '财务', '单据导出', '识别导入', '数据管理', '*共用'],
  },
  // 服务端根目录只放启动、装配和命令行入口，可以引用全部（只算根目录的文件，新建的子目录要登记进上面的模块）
  { name: '装配', paths: ['server/'], allow: ['*'] },
  // 前后端共用，和服务端同一套分法
  { name: '共用-基础', paths: ['shared/core/'], allow: [] },
  {
    // 共用业务和服务端业务主线的层对应，走入口时按名字的来源文件算层
    name: '共用-业务',
    paths: ['shared/business/'],
    allow: ['共用-基础'],
    layers: [
      { name: '客户产品订单', paths: ['shared/business/sales/'] },
      { name: '采购库存', paths: ['shared/business/operations/'] },
      { name: '单据流转', paths: ['shared/business/flow/'] },
      { name: '删除归档', paths: ['shared/business/lifecycle/'] },
      { name: '订单服务', paths: ['shared/business/orders/'] },
      { name: '业务总览', paths: ['shared/business/overview/'] },
    ],
  },
  { name: '共用-财务', paths: ['shared/finance/'], allow: ['共用-基础'] },
  { name: '共用-单据', paths: ['shared/documents/'], allow: ['共用-基础', '共用-业务'] },
  { name: '共用-AI', paths: ['shared/ai/'], allow: [] },
  { name: '共用-系统资料', paths: ['shared/system/'], allow: [] },
  { name: '共用-识别', paths: ['shared/import/'], allow: ['共用-基础', '共用-AI'] },
  { name: '共用-管理', paths: ['shared/admin/'], allow: ['共用-基础', '共用-业务'] },
  { name: '共用-助手', paths: ['shared/assistant/'], allow: ['共用-基础', '共用-业务', '共用-AI'] },
  // 前端：和服务端同样分模块，能用的共用代码不超过服务端对应的模块；都不能引用服务端代码。
  // 前端数据管理还放着 AI 接入的模型、提示词设置页和识别导入的消息接入设置页，所以多了共用-AI、共用-识别
  { name: '前端-基础', paths: ['src/ui/'], allow: ['共用-基础'] },
  // 使用说明页
  { name: '前端-系统资料', paths: ['src/system/'], allow: ['前端-基础', '共用-基础', '共用-系统资料'] },
  // 单据导出的前端（导出窗、模板设置、文件交付）：业务页面和助手经它的 index.ts、pages.ts 用；能用的共用代码不超过服务端单据导出
  { name: '前端-单据导出', paths: ['src/documents/'], allow: ['前端-基础', '共用-基础', '共用-单据'] },
  {
    // 业务主线的前端按界面角色分四层，只往下用：上层嵌下层的窗口，下层要打开上层的页面用页面地址，不引上层的代码。
    // 单据在采购仓储下面（采购、仓储页面要显示到货单、送货单，单据窗口用不着采购窗口），和服务端业务主线的顺序不同。
    name: '前端-业务',
    paths: ['src/records/', 'src/recordkit/', 'src/flow/', 'src/warehouse/', 'src/operations/', 'src/editors/', 'src/marks/'],
    allow: ['前端-基础', '前端-单据导出', '共用-基础', '共用-业务', '共用-单据'],
    layers: [
      { name: '业务公共件', paths: ['src/recordkit/', 'src/marks/', 'src/editors/'] },
      { name: '单据', paths: ['src/flow/'] },
      { name: '采购仓储', paths: ['src/operations/', 'src/warehouse/'] },
      { name: '页面', paths: ['src/records/'] },
    ],
  },
  { name: '前端-财务', paths: ['src/finance/'], allow: ['前端-基础', '共用-基础', '共用-财务'] },
  {
    name: '前端-识别',
    paths: ['src/import/'],
    allow: ['前端-基础', '前端-业务', '共用-基础', '共用-业务', '共用-AI', '共用-识别'],
  },
  {
    name: '前端-管理',
    paths: ['src/admin/'],
    allow: ['前端-基础', '前端-业务', '共用-基础', '共用-业务', '共用-管理', '共用-AI', '共用-识别'],
  },
  {
    name: '前端-助手',
    paths: ['src/assistant/'],
    allow: ['前端-基础', '前端-业务', '前端-单据导出', '共用-基础', '共用-业务', '共用-AI', '共用-助手'],
  },
  // src 根目录和手机导航：入口、导航、登录、账号菜单、设置总页、插槽装配，把各模块的页面装起来
  { name: '前端-装配', paths: ['src/', 'src/mobile/'], allow: ['前端-*', '*共用'] },
];

/** 目录下的全部文件（跳过 node_modules），路径用正斜杠、从项目根目录写起 */
export const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === 'node_modules' ? [] : files(dir + '/' + e.name)) : [dir + '/' + e.name],
      )
    : [];
/** 源码：TypeScript 和 JavaScript 都算（server/import/parse-worker.mjs 这类 .mjs 也是模块代码），类型声明不算 */
export const isCode = (f: string) => /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(f) && !/\.d\.[cm]?ts$/.test(f);
/** 模块代码：server、shared、src 下的全部源码 */
export const all = ['server', 'shared', 'src'].flatMap(files).filter(isCode);
/** 工具：scripts/ 下的脚本和根目录的配置文件，不属于模块，但引用模块时也查 */
export const tools = [...files('scripts'), ...readdirSync('.').filter((f) => /\.config\.[cm]?[jt]s$/.test(f))].filter(isCode);
/** 能被引用到的项目文件（含样式、数据等非代码文件），解析引用时用 */
const projectFiles = new Set([
  ...['server', 'shared', 'src', 'scripts', 'tests'].flatMap(files),
  ...readdirSync('.', { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
]);
/** 模块表、层表里的一项路径管不管这个文件：目录按前缀，单个文件要全名相同 */
export const covers = (p: string, f: string) => (p.endsWith('/') ? f.startsWith(p) : f === p);
/** 文件按最长前缀落到的那一项：模块和它登记的路径；不在任何模块的路径下（tests、根目录的配置）是 undefined */
export const matchOf = (f: string): { m: Rule; p: string } | undefined =>
  modules
    .flatMap((m) => m.paths.map((p) => ({ m, p })))
    .filter(({ p }) => covers(p, f))
    .sort((a, b) => b.p.length - a.p.length)[0];
/** 文件属于哪个模块；不在任何模块的路径下（tests、根目录的配置）是 undefined */
export const moduleOf = (f: string): Rule | undefined => matchOf(f)?.m;
/** 模块 from 能不能用模块 to（* 是全部，前端-* 是前端的全部，*共用 是共用的全部） */
export const canUse = (from: Rule, to: Rule) =>
  from.allow.includes('*') ||
  (from.allow.includes('前端-*') && to.name.startsWith('前端-')) ||
  from.allow.includes(to.name) ||
  (from.allow.includes('*共用') && to.name.startsWith('共用'));
/** 文件在模块的第几层（0 是最下层）；模块没分层、或文件没登记进任何一层是 undefined */
export const layerOf = (f: string, rule: Rule | undefined = moduleOf(f)): number | undefined => {
  const i = rule?.layers?.findIndex((l) => l.paths.some((p) => covers(p, f))) ?? -1;
  return i < 0 ? undefined : i;
};
/** server、shared、src 下的文件属于哪个模块；没登记进模块表就让测试失败 */
export const ownerModule = (f: string): Rule => {
  const m = moduleOf(f);
  if (!m) throw new Error(f + ' 没有登记进 tests/checks/module-map.ts 的模块表');
  return m;
};
export const inModules = (f: string) => /^(server|shared|src)\//.test(f);
/**
 * pages.ts 之外另立的按需加载入口：别的模块只用页面里的一小段、不该连带下载整套页面时才登记，写明理由。
 * 和 pages.ts 一样只许 import()、只列自己模块的东西。
 */
export const lazyEntries: { file: string; why: string }[] = [
  {
    file: 'src/finance/related-pages.ts',
    why:
      '订单、送货、到货详情里的财务段：业务页面用，走 pages.ts 会把整套财务页面一起下载；' +
      '在 pages.ts 里给整套页面再套一层 lazy 会让页面变成两层按需加载、入口名不对应实际组件，' +
      '新开一个顶层目录放一个组件又要把财务模块拆到两个目录，都比登记一个入口更绕',
  },
];
/** 按需加载的入口：各模块的 pages.ts 和上面登记的 */
export const isLazyEntry = (t: string) => /^src\/[a-z]+\/pages\.ts$/.test(t) || lazyEntries.some((e) => e.file === t);
/** 模块的对外接口文件：index.ts，按需加载的入口 */
export const isEntry = (t: string) => /^(server|shared|src)\/[a-z]+\/(index|pages)\.ts$/.test(t) || isLazyEntry(t);
/** 引用写法里 ? 和后面的部分（Vite 的 ?no-inline、?url 这类）不是文件名，解析时去掉；引用里照原样记 */
const withoutQuery = (spec: string) => spec.replace(/\?.*$/, '');
/** 相对路径 → 项目里的文件（.js 写法对应 .ts 源文件，目录对应 index.ts）；找不到返回 null */
export const resolve = (from: string, spec: string) => {
  const raw = posix.normalize(posix.join(posix.dirname(from), withoutQuery(spec))).replace(/\/$/, '');
  const stem = raw.replace(/\.(js|mjs|cjs|jsx)$/, '');
  return (
    [raw, stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts', raw + '.ts', raw + '.tsx', raw + '/index.ts', raw + '/index.tsx'].find((c) =>
      projectFiles.has(c),
    ) ?? null
  );
};
export const scriptKind = (f: string) =>
  f.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(js|mjs|cjs|jsx)$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

/**
 * 一处引用。how：
 * - import：import、export ... from、import('x').类型（静态）
 * - import()、require：加载目标是能算出来的字符串（字面量、模板、拼接、同文件的 const）
 * - url：new URL('相对路径', import.meta.url) 指向代码文件（比如起 worker）
 * - path：脚本里写的项目路径 'server/xxx.ts'（起子进程、拼路径）
 * target：解析到的项目文件；null 是相对路径找不到文件。unresolved：加载目标算不出来，记下原文。
 * names：import { a, b } 引进来的名字、export { a, b } from 转出去的名字（都按对方导出的名字），import('x').A 的 A。
 */
export type Ref = {
  spec: string;
  target: string | null;
  how: 'import' | 'import()' | 'require' | 'url' | 'path';
  typeOnly: boolean;
  line: number;
  unresolved?: string;
  names?: string[];
};
const parsed = new Map<string, Ref[]>();

/**
 * 同一文件里只声明过一次、也没有同名参数或解构变量遮住的 const（算加载目标时可以代进去），
 * 和 createRequire 造出来的 require（换了名字也认）
 */
function declarations(source: ts.SourceFile) {
  const consts = new Map<string, ts.Expression | null>();
  const requireNames = new Set(['require']);
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const init = n.initializer;
      const isConst = !!(ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const);
      consts.set(n.name.text, consts.has(n.name.text) || !isConst || !init ? null : init);
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'createRequire')
        requireNames.add(n.name.text);
    } else if ((ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) consts.set(n.name.text, null);
    ts.forEachChild(n, collect);
  };
  collect(source);
  return { consts, requireNames };
}

/** 算加载目标的字符串：字面量、模板、拼接、同文件的 const；算不出来是 null */
const evaluator = (consts: Map<string, ts.Expression | null>) => {
  const evaluate = (n: ts.Expression, depth = 0): string | null => {
    if (depth > 8) return null;
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return evaluate(n.expression, depth + 1);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = evaluate(n.left, depth + 1);
      const b = a === null ? null : evaluate(n.right, depth + 1);
      return a === null || b === null ? null : a + b;
    }
    if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      for (const span of n.templateSpans) {
        const v = evaluate(span.expression, depth + 1);
        if (v === null) return null;
        s += v + span.literal.text;
      }
      return s;
    }
    if (ts.isIdentifier(n)) {
      const init = consts.get(n.text);
      return init ? evaluate(init, depth + 1) : null;
    }
    return null;
  };
  return evaluate;
};

const isImportMetaUrl = (n: ts.Node | undefined) =>
  !!n && ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url';

/** 记一处引用要的东西；fromRoot：spec 是从项目根目录写的路径 */
type Found = { spec: string; how: Ref['how']; typeOnly: boolean; at: ts.Node; fromRoot?: boolean; names?: string[] };
/** 一个文件的取引用过程：记引用、记算不出来的加载目标、算字符串 */
type Collector = {
  source: ts.SourceFile;
  requireNames: Set<string>;
  evaluate: (n: ts.Expression) => string | null;
  add: (found: Found) => void;
  unresolved: (how: Ref['how'], at: ts.Node, expr: ts.Node) => void;
};

function collector(f: string, source: ts.SourceFile, out: Ref[]): Collector {
  const { consts, requireNames } = declarations(source);
  const lineOf = (at: ts.Node) => source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1;
  return {
    source,
    requireNames,
    evaluate: evaluator(consts),
    add: ({ spec, how, typeOnly, at, fromRoot = false, names }) =>
      void out.push({
        spec,
        target: fromRoot ? (projectFiles.has(spec) ? spec : null) : resolve(f, spec),
        how,
        typeOnly,
        line: lineOf(at),
        ...(names ? { names } : {}),
      }),
    unresolved: (how, at, expr) =>
      void out.push({ spec: '', target: null, how, typeOnly: false, line: lineOf(at), unresolved: expr.getText(source) }),
  };
}

/** import 语句：只引类型（import type，或者引的名字全是 type）算类型引用；记下引进来的名字 */
function importRef(n: ts.ImportDeclaration, spec: string, c: Collector) {
  const clause = n.importClause;
  const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
  const typeOnly =
    !!clause &&
    (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || (!clause.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
  const names = named?.map((e) => (e.propertyName || e.name).text);
  if (spec.startsWith('.')) c.add({ spec, how: 'import', typeOnly, at: n, names });
}
/** import、export ... from、import('x').类型：静态引用；认出来返回 true */
function staticRef(n: ts.Node, c: Collector) {
  if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
    importRef(n, n.moduleSpecifier.text, c);
    return true;
  }
  if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
    // export { a, b as c } from：记下按对方导出的名字（a、b）；export * 不记
    const clause = n.exportClause;
    const names = clause && ts.isNamedExports(clause) ? clause.elements.map((e) => (e.propertyName || e.name).text) : undefined;
    if (n.moduleSpecifier.text.startsWith('.')) c.add({ spec: n.moduleSpecifier.text, how: 'import', typeOnly: n.isTypeOnly, at: n, names });
    return true;
  }
  if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
    const names = n.qualifier ? [n.qualifier.getText(c.source).split('.')[0]] : undefined;
    if (n.argument.literal.text.startsWith('.')) c.add({ spec: n.argument.literal.text, how: 'import', typeOnly: true, at: n, names });
    return true;
  }
  return false;
}

/** 加载目标：相对路径算项目文件；包名、node: 内置是外部依赖，不管；绝对路径、file: 地址看不出是项目里的哪个文件，算看不出来 */
function load(c: Collector, how: Ref['how'], at: ts.Node, arg: ts.Expression | undefined) {
  if (!arg) return;
  const spec = c.evaluate(arg);
  if (spec === null || /^(\/|file:|[a-zA-Z]:[\\/])/.test(spec)) c.unresolved(how, at, arg);
  else if (spec.startsWith('.')) c.add({ spec, how, typeOnly: false, at });
}
const isRequireCall = (n: ts.CallExpression, requireNames: Set<string>) =>
  (ts.isIdentifier(n.expression) && requireNames.has(n.expression.text)) ||
  (ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    requireNames.has(n.expression.expression.text) &&
    n.expression.name.text === 'resolve');

/** import()、require、new URL(…, import.meta.url)：运行时加载；认出来返回 true */
function dynamicRef(n: ts.Node, c: Collector) {
  if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
    load(c, 'import()', n, n.arguments[0]);
    return true;
  }
  if (ts.isCallExpression(n) && isRequireCall(n, c.requireNames)) {
    load(c, 'require', n, n.arguments[0]);
    return true;
  }
  const target = ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' ? n.arguments : undefined;
  if (!target || !isImportMetaUrl(target[1])) return false;
  // 文件地址：指向代码文件的算引用（比如起 worker），指向目录、模型、数据等资源的不算
  const spec = c.evaluate(target[0]);
  if (spec === null) c.unresolved('url', n, target[0]);
  else if (isCode(withoutQuery(spec))) c.add({ spec, how: 'url', typeOnly: false, at: n });
  return true;
}

/** 脚本里按项目路径写的文件（起子进程、拼路径），从项目根目录算 */
function projectPathRef(n: ts.Node, c: Collector) {
  if (!ts.isStringLiteralLike(n) || !/^(server|shared|src)\/[\w./-]+\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(n.text)) return;
  const parent = n.parent;
  const isSpecifier = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === n;
  if (!isSpecifier) c.add({ spec: n.text, how: 'path', typeOnly: false, at: n, fromRoot: true });
}

/** 入口文件 export { a, b as c } from './x' 转出去的名字 → 来源文件（c 对应 x）；别的模块经入口引的名字按来源文件算层 */
export function exportSources(entry: string, text?: string): Map<string, string> {
  const source = ts.createSourceFile(entry, text ?? readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(entry));
  const out = new Map<string, string>();
  for (const n of source.statements) {
    if (!ts.isExportDeclaration(n) || !n.moduleSpecifier || !ts.isStringLiteral(n.moduleSpecifier)) continue;
    const target = resolve(entry, n.moduleSpecifier.text);
    if (target && n.exportClause && ts.isNamedExports(n.exportClause))
      for (const e of n.exportClause.elements) out.set(e.name.text, target);
  }
  return out;
}

/** 用 TypeScript 自己的解析器取一个文件的全部引用（text 不给就读文件并记住结果；回归测试直接喂样例） */
export function refsOf(f: string, text?: string): Ref[] {
  const cached = text === undefined ? parsed.get(f) : undefined;
  if (cached) return cached;
  const source = ts.createSourceFile(f, text ?? readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(f));
  const out: Ref[] = [];
  const c = collector(f, source, out);
  const visit = (n: ts.Node) => {
    if (!staticRef(n, c) && !dynamicRef(n, c)) projectPathRef(n, c);
    ts.forEachChild(n, visit);
  };
  visit(source);
  if (text === undefined) parsed.set(f, out);
  return out;
}
