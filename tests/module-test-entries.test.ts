/**
 * 测试也只走模块的入口：tests/ 下的文件引用登记了的模块，只许引它的 index.ts；
 * 只有测模块内部件（入口不导出的类、常量）的“本模块测试”登记进 moduleTests 并写明原因，才能直接引内部文件。
 * 这样模块内部怎么拆、怎么改名，只牵动它自己的测试；别的测试按入口测，换了实现也不用跟着改。
 * 认的引用：import、export ... from、import()、require（tests/module-map.ts 的 refsOf）；字符串里写的路径不算。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { files, isCode, refsOf } from './module-map.js';

type ModuleTests = { module: string; dir: string; own: { file: string; why: string }[] };

const moduleTests: ModuleTests[] = [
  {
    module: '采购库存',
    dir: 'server/operations/',
    own: [
      {
        file: 'tests/operations-core.test.ts',
        why: '测采购库存的内部件：写入共用的 priorRecord、库存品规则 StockItems、流水查询 MovementQueries、成品库存跟着产品的 syncFinishedStock，入口都不导出',
      },
      { file: 'tests/purchase-save.test.ts', why: '直接测保存采购单的 PurchaseWriter（入口只导出 OperationsService）' },
      { file: 'tests/stock-identity.test.ts', why: '要按类判断查重冲突 StockConflictError，只有测试用，入口不导出' },
      {
        file: 'tests/schema-constraints.test.ts',
        why: '比对建表的枚举和流水动作常量 stockMovementActions，这个常量只有测试用，进不了入口',
      },
    ],
  },
];

/** 引用方式里算“用代码”的：静态引用、import()、require */
const codeRef = new Set(['import', 'import()', 'require']);

/** 模块目录的最后一段（如 operations）：文字里出现它才可能引到这个模块 */
const dirName = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir;

/**
 * 测试文件 f（内容 text，不给就读文件）里绕过入口直接引模块内部的地方。
 * 加载目标看不出来的动态加载（import(变量)、带变量的模板字符串、require(变量)）：加载的文字或整个文件里出现模块目录
 * （如 server/operations/）就算可能绕过入口，也报，改成写明路径的字面量走 index.ts。
 */
function violations(f: string, text: string = readFileSync(f, 'utf8')) {
  return moduleTests.flatMap(({ module, dir, own }) => {
    if (own.some((o) => o.file === f)) return [];
    const refs = refsOf(f, text).filter((r) => codeRef.has(r.how));
    const inner = refs
      .filter((r) => r.target?.startsWith(dir) && r.target !== dir + 'index.ts')
      .map((r) => f + ':' + r.line + ' 引了 ' + r.target + '：测试引' + module + '只走 ' + dir + 'index.ts；是本模块自己的测试登记进 moduleTests 并写明原因');
    const hidden = refs
      .filter((r) => r.unresolved !== undefined && (r.unresolved.includes(dirName(dir)) || text.includes(dir)))
      .map((r) => f + ':' + r.line + ' 的 ' + r.how + '（' + r.unresolved + '）看不出加载哪个文件，可能绕过' + module + '的入口：改成写明路径的字面量，只引 ' + dir + 'index.ts');
    return [...inner, ...hidden];
  });
}

/** import(…)、require(…) 里不是一个写死的字符串（拼接、模板、变量）：目标可能看不出来 */
const dynamicLoad = /\b(?:import|require)\s*\(\s*(?!(['"])[^'"`]*\1\s*\))/;
/**
 * 要解析的文件（全量解析 tests/ 太慢）：文字里出现模块目录名，并且写了“目录名/某个不是 index 的文件”（如 operations/ledger），
 * 或者有看不出目标的加载。只引 index.js 的文件很多，跳过它们。
 */
const mayRefer = (text: string) =>
  moduleTests.some(({ dir }) => text.includes(dirName(dir)) && (new RegExp(dirName(dir) + '/(?!index\\.)').test(text) || dynamicLoad.test(text)));

test('测试引登记了的模块只走 index.ts，本模块测试登记过才能引内部', () => {
  const found = files('tests')
    .filter(isCode)
    .flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return mayRefer(text) ? violations(f, text) : [];
    });
  assert.deepEqual(found, []);
});

test('本模块测试名单不留过期登记：文件还在，确实直接引了模块内部，原因写了', () => {
  for (const { module, dir, own } of moduleTests)
    for (const { file, why } of own) {
      assert.ok(existsSync(file), module + '的本模块测试 ' + file + ' 已经没有了，删掉这条登记');
      assert.ok(why.trim(), file + ' 没写原因');
      const inner = refsOf(file).filter((r) => codeRef.has(r.how) && r.target?.startsWith(dir) && r.target !== dir + 'index.ts');
      assert.ok(inner.length, file + ' 已经只走 ' + dir + 'index.ts，删掉这条登记');
    }
});

test('回归样例：引内部文件、export from、require、import() 内部文件、看不出目标的加载各报一条；引 index.js、登记过的本模块测试不报', () => {
  const sample = 'tests/虚构样例.test.ts';
  assert.equal(violations(sample, "import { stockLedger } from '../server/operations/ledger.js';").length, 1);
  assert.equal(violations(sample, "export { insertMovement } from '../server/operations/ledger.js';").length, 1, 'export from 也算');
  assert.equal(violations(sample, "const ledger = require('../server/operations/ledger.js');").length, 1, 'require 也算');
  assert.equal(violations(sample, "const m = await import('../server/operations/batches.js');").length, 1);
  assert.equal(violations(sample, "export async function load(n: string) { return import('../server/operations/' + n); }").length, 1, '拼出来的目标看不出来');
  assert.equal(violations(sample, 'export async function load(n: string) { return import(`../server/operations/${n}.js`); }').length, 1, '模板字符串也一样');
  assert.equal(violations(sample, "export async function load(n: string) { return import('../server/flow/' + n); }").length, 0, '和这个模块无关的不报');
  assert.equal(violations(sample, "import { stockLedger } from '../server/operations/index.js';").length, 0);
  assert.equal(violations(sample, "import type { RecordIds } from '../server/operations/record-scope.js';").length, 1, '只引类型也算');
  assert.equal(violations('tests/operations-core.test.ts', "import { MovementQueries } from '../server/operations/movements.js';").length, 0);
});
