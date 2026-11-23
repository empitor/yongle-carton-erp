// 前端请求地址归属检查用的取地址函数，给 tests/checks/module-api-owners.test.ts 和 tests/checks/feature-links-senders.test.ts 用
// （地址归哪个后端模块、哪个前端模块能用，登记在那个测试里）。
// 不是测试文件本身：只导出函数。只依赖 typescript 和 node 内置模块。
import ts from 'typescript';
import { resolve as resolvePath } from 'node:path';
import { ApiAnalyzer } from './module-api-analyzer.js';
import { apiCompilerOptions, apiSourceFiles, type ApiRef } from './module-api-syntax.js';

export type { ApiRef };

/**
 * 前端请求地址检查用的取地址函数：在语法树上找出一个文件里所有“像后端地址的字符串”，并按请求函数补前缀。
 *
 * 1. 字符串表达式（字面量、模板、`+` 拼接、三元、`||`）整体求值：标识符追到声明（本文件或 import 进来的常量、对象属性），
 *    类型是字面量联合的变量（比如 entity: 'customers' | 'products'，含 if/三元收窄后的）展开成每个值，其余变量当成 :id。
 *    求出来以 /api/ 开头或以登记过的根前缀（测试里的 apiOwners，经 apiScanner 传进来）开头的，都算一次地址，不管它是直接请求、先存变量、放对象属性还是当参数传。
 * 2. 请求函数不靠名单：fetch、<a href>、<img src>、x.href = 这些浏览器入口是起点，项目里的封装自动推出来——
 *    函数的参数（含解构出来的组件属性、JSX 里传进去的回调）拼进了请求地址，它就是请求函数，前缀跟着带上
 *    （authorizedRequest、tokenRequest → /api；ExportLink → /api/finance；exportHref 返回 /api/finance+参数，按“拼地址的函数”算；
 *    workspace-api.ts 里收地址的 importRequest → /api/ai/imports……）。地址在第几个参数都一样认（方法在前、地址第二个也算）。
 *    请求函数参数里的字面量按补好的前缀算（exportHref('/flow') 是 /finance/flow），开头没登记也报，不跳过。
 *    按接口表发的（call<表>() 建出来的函数）不看函数名：第一个实参是“方法 /地址”的键就算一次请求，键里的地址就是地址。
 * 3. 不算：http(s)://、//、data:、blob: 等外部地址，# 开头的页面跳转，不以 / 开头的相对地址，
 *    没登记的根前缀下带扩展名的静态文件（/favicon.svg、/theme-init.js）或 /assets/、/vendor/ 等静态目录；注释和 CSS 文件本来就不在语法树里。
 *    链接类入口（href、src、window.open）只认 /api 开头或登记过的根前缀；fetch 这类真正发请求的入口没登记就报。
 * 4. 地址开头就是变量、又没有字面量类型可展开的（比如 fetch(file.url)、函数参数），这里查不到，由传进来的那处字面量按第 1 条抓。
 *
 * 规范化：去掉 /api 前缀、问号和井号后面的部分、末尾斜杠；变量段和 :xxx 段都写成 :id；末段“文字+变量”（多半是 qs(query)）只留文字。
 * 需要类型信息：第一次取地址时为 src、shared 建一个 TypeScript program（约 3 秒），之后复用；
 * text 和磁盘上不同（回归测试的样例）时另建一个只换这个文件的临时程序（约 0.2 秒），样例多时用 refsMany 一次建一个。
 *
 * 同一进程里的几份测试共用一个程序和分析缓存（都只跟源码有关）；根前缀各用各的，只在最后筛地址时用。
 */
let apiBase: { program: ts.Program; host: ts.CompilerHost; analyzer: ApiAnalyzer } | undefined;
/** 这个进程里拿着取地址函数、还没用完的测试文件数；都用完才放掉程序（约 200 MB） */
let apiUsers = 0;
const apiAbs = (f: string) => resolvePath(f).replace(/\\/g, '/');

function baseProgram() {
  if (apiBase) return apiBase;
  const host = ts.createCompilerHost(apiCompilerOptions, true);
  const cache = new Map<string, ts.SourceFile | undefined>();
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, fresh) => {
    if (!cache.has(name)) cache.set(name, read(name, lang, onError, fresh));
    return cache.get(name);
  };
  const program = ts.createProgram(['src', 'shared'].flatMap(apiSourceFiles), apiCompilerOptions, host);
  apiBase = { program, host, analyzer: new ApiAnalyzer(program) };
  return apiBase;
}
const sourceOf = (program: ts.Program, file: string) => {
  const sf = program.getSourceFile(apiAbs(file));
  if (!sf) throw new Error('类型程序里没有 ' + file);
  return sf;
};
/** files 里和磁盘不同的文件（样例）另建一个只换这几个文件的程序 */
function overlayProgram(base: { program: ts.Program; host: ts.CompilerHost }, files: { file: string; text: string }[]) {
  const overrides = new Map(
    files.map((f) => {
      const abs = apiAbs(f.file);
      const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      return [abs.toLowerCase(), { abs, text: f.text, sf: ts.createSourceFile(abs, f.text, ts.ScriptTarget.Latest, true, kind) }];
    }),
  );
  const find = (n: string) => overrides.get(apiAbs(n).toLowerCase());
  const host = base.host;
  const overlay: ts.CompilerHost = {
    ...host,
    getSourceFile: (n, l, e, f) => find(n)?.sf ?? host.getSourceFile(n, l, e, f),
    fileExists: (n) => !!find(n) || host.fileExists(n),
    readFile: (n) => find(n)?.text ?? host.readFile(n),
  };
  const roots = [...base.program.getRootFileNames()];
  for (const o of overrides.values()) if (!roots.some((r) => r.toLowerCase() === o.abs.toLowerCase())) roots.push(o.abs);
  return ts.createProgram(roots, apiCompilerOptions, overlay, base.program);
}
/** 取这几个文件的分析器和语法树：和磁盘上一样的用共用的程序，有样例的另建 */
function apiProgram(files: { file: string; text: string }[]) {
  const base = baseProgram();
  const own = files.map((f) => base.program.getSourceFile(apiAbs(f.file)));
  if (own.every((sf, i) => sf?.text === files[i].text)) return { analyzer: base.analyzer, sources: files.map((f) => sourceOf(base.program, f.file)) };
  const program = overlayProgram(base, files);
  return { analyzer: new ApiAnalyzer(program), sources: files.map((f) => sourceOf(program, f.file)) };
}

/**
 * 按一组登记过的后端地址根前缀（比如 /customers、/flow、/ai，由测试按 apiOwners 或服务端路由给）取地址。
 * 每份测试文件开头建一个，最后一次取完调 release()：这个进程里都用完了才放掉共用的程序。
 */
export function apiScanner(prefixes: string[]) {
  const roots = new Set(prefixes.map((p) => p.split('/')[1]).filter((r) => !!r && !r.startsWith(':')));
  apiUsers++;
  let released = false;
  return {
    /** 一个前端（或共用）文件里的后端地址，已规范化（去 /api、去末尾斜杠、变量段写成 :id、封装的前缀已补上）。 */
    refs(file: string, text: string): ApiRef[] {
      const { analyzer, sources } = apiProgram([{ file, text }]);
      return analyzer.refs(sources[0], roots).refs;
    },
    /** 一次取多个文件（回归样例用：文件名各不相同，只建一个临时程序）。 */
    refsMany(files: { file: string; text: string }[]): ApiRef[][] {
      const { analyzer, sources } = apiProgram(files);
      return sources.map((sf) => analyzer.refs(sf, roots).refs);
    },
    /** 这份测试文件不再取地址了；同进程里别的测试文件也都用完时放掉程序（约 200 MB） */
    release() {
      if (released) return;
      released = true;
      if (--apiUsers <= 0) apiBase = undefined;
    },
  };
}
