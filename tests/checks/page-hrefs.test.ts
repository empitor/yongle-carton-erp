/**
 * 页面地址一本册子（shared/core/pages.ts）：
 * 1) 全站代码（server/、shared/、src/）里 `#页面`、`#页面?参数`、未登记 `#slug`、模板或拼接出的页面地址只许出现在 shared/core/pages.ts，
 *    别处一律调 pageHref / flowDocHref / withPageQuery / withPageTab（跳过测试文件与文档）；
 * 2) 核对 pageHref、pageParams、withPageQuery、withPageTab、flowDocHref、isPageHref、pageIdOf、分组与短名的行为。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import {
  financePageIds,
  flowDocHref,
  isFinancePage,
  isFlowKind,
  isPageHref,
  isPageId,
  pageHref,
  pageIdOf,
  pageIds,
  pageParams,
  pageShortTitle,
  pageTitle,
  pages,
  pagesInGroup,
  productionViews,
  warehouseViews,
  withPageQuery,
  withPageTab,
} from '../../shared/core/index.js';
import { files, isCode } from './module-map.js';

const PAGES_FILE = 'shared/core/pages.ts';
const sortedIds = [...pageIds].sort((a, b) => b.length - a.length);
const pageAlternation = sortedIds.join('|');
/** `#页面` 或 `#页面?参数`（如 #orders、#orders?order=、#finance-ar?tab=soon） */
const hashPageLiteral = new RegExp(`(?:^|[^a-z0-9_#-])#(?:${pageAlternation})(?=$|[?&=])`);
/** 任何 `#xxx?` 形态（未登记的旧页面链接也一并拦下） */
const anyHashQuery = /^#[a-z][a-z0-9-]*\?/;
/** 裸 `#slug`（未登记的过期页面如 #obsolete；排除 #fff / #ff00aa 这类颜色值） */
const bareHashSlug = /^#[a-z][a-z0-9-]*$/;
const hexColor = /^#[0-9a-f]{3,8}$/;
/** 不带 `#` 的页面查询串开头（防止用 `'#' + 'orders?order='` 绕过） */
const barePageQuery = new RegExp(`^(?:${pageAlternation})\\?`);
/** 模板或 `+` 拼接出的动态哈希地址（如 `#${page}?q=${q}`、'#' + 'orders' + '?order=' + id） */
const dynamicHashPattern = /^#(?:\$\{\}|[a-z][a-z0-9-]*)(?:$|\?)/;
/** 粗筛：全文没出现 `#` 或 `<页面>?` 就跳过语法树解析，保持快测 */
const mayContainPageHref = new RegExp(`#|(?:${pageAlternation})\\?`);

const isPageHrefLiteral = (value: string) =>
  hashPageLiteral.test(value) ||
  anyHashQuery.test(value) ||
  barePageQuery.test(value) ||
  (bareHashSlug.test(value) && !hexColor.test(value));

/** 把左结合的 `+` 拼接链展平为骨架串（静态字面原样、动态表达式记为 `${}`） */
function plusSkeleton(node: ts.BinaryExpression): string {
  const parts: string[] = [];
  const collect = (expr: ts.Expression) => {
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collect(expr.left);
      collect(expr.right);
    } else if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      parts.push(expr.text);
    } else {
      parts.push('${}');
    }
  };
  collect(node);
  return parts.join('');
}

/** 扫描一个代码文件的字面量、模板和 `+` 拼接链（跳过注释），找出手写的页面链接 */
function literalViolations(file: string, text: string = readFileSync(file, 'utf8')): string[] {
  if (file === PAGES_FILE || !mayContainPageHref.test(text)) return [];
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const report = (node: ts.Node, snippet: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push(`${file}:${line} 出现手写页面链接 ${JSON.stringify(snippet)}：改用 shared/core/pages.ts 的 pageHref 或 flowDocHref`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isPageHrefLiteral(node.text)) report(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      const skeleton = node.head.text + node.templateSpans.map((s) => '${}' + s.literal.text).join('');
      if (dynamicHashPattern.test(skeleton) || isPageHrefLiteral(node.head.text)) report(node, skeleton);
      for (const span of node.templateSpans) {
        if (isPageHrefLiteral(span.literal.text)) report(span.literal, span.literal.text);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const skeleton = plusSkeleton(node);
      if (dynamicHashPattern.test(skeleton) && skeleton !== '#${}') report(node, skeleton);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('页面链接字面（#页面、#页面?参数、未登记 #slug 及拼接写法）只许出现在 shared/core/pages.ts', () => {
  const dirs = ['server', 'shared', 'src'];
  const found = dirs
    .flatMap((dir) => files(dir))
    .filter(isCode)
    .flatMap((file) => literalViolations(file));
  assert.deepEqual(found, []);
});

test('页面链接检查回归样例：手写链接、过期页面、模板与拼接都拦下，颜色、注释、Markdown 标题与数字格式不误报', () => {
  const sample = 'src/虚构样例.tsx';
  for (const code of [
    "const a = '#orders';",
    "const b = '#orders?order=' + id;",
    'const c = `#warehouse?kind=finished&deliveries=1&doc=${id}`;',
    "const d = '#finance-ar?tab=soon';",
    "const e = '#old-page?x=1';",
    "const f = '#' + 'purchases?record=' + id;",
    "const g = '[打开](#orders?order=1)';",
    "const h = '#obsolete';",
    "const i = '#' + 'orders' + '?order=' + id;",
    'const j = `#${page}?q=${q}`;',
  ])
    assert.ok(literalViolations(sample, code).length >= 1, code);

  for (const code of [
    "// 注释里写 #orders?order=1 和 #obsolete 不算代码字面",
    "const color = '#fff';",
    "const hex = '#ff00aa';",
    "const heading = '## 订单';",
    "const fmt = '#,##0.00';",
    "const num = '#123';",
    "const label = '#' + id;",
    "const plain = 'orders';",
  ])
    assert.equal(literalViolations(sample, code).length, 0, code);

  assert.equal(literalViolations(PAGES_FILE, "export const x = '#orders?order=1';").length, 0);
});

test('pageHref 按登记表拼地址，忽略未登记参数、空值、false、非法正整数和空数组，并编码特殊字符', () => {
  assert.equal(pageHref('dashboard'), '#dashboard');
  assert.equal(pageHref('orders', {}), '#orders');
  assert.equal(pageHref('orders', { order: 12 }), '#orders?order=12');
  assert.equal(pageHref('orders', { create: true, customer: 3, products: [1, 2], n: 9 }), '#orders?create=1&customer=3&products=1,2&n=9');
  assert.equal(pageHref('orders', { create: false, order: 0, products: [], q: '' }), '#orders');
  assert.equal(pageHref('purchases', { businessStatus: '待订货' }), '#purchases?businessStatus=%E5%BE%85%E8%AE%A2%E8%B4%A7');
  assert.equal(pageHref('warehouse', { deliveries: true, kind: 'finished' }), '#warehouse?deliveries=1&kind=finished');
  assert.equal(pageHref('ai-settings', { tab: 'tools' }), '#ai-settings?tab=tools');

  // 通过变量或对象展开绕过对象字面量检查时，未登记的键也不能出现在输出地址里
  const extra = { order: 42, id: 77 };
  assert.equal(pageHref('orders', extra), '#orders?order=42');
  assert.equal(pageHref('orders', { ...extra }), '#orders?order=42');

  // 中文与 URL 特殊字符可完整往返
  const special = '中 +&#?=%';
  const encoded = pageHref('orders', { q: special });
  assert.equal(pageParams('orders', encoded).q, special);
});

test('pageParams 按登记表解析参数：守住安全整数边界、含问号查询值与未知页面前缀', () => {
  assert.deepEqual(pageParams('orders', '#orders?order=42&create=1&products=3,0,5,abc&scope=all&range=2&start=2026-04-01&end=bad'), {
    order: 42,
    create: true,
    customer: undefined,
    products: [3, 5],
    n: undefined,
    q: undefined,
    scope: 'all',
    view: undefined,
    archived: false,
    status: undefined,
    customerId: undefined,
    range: '2',
    start: '2026-04-01',
    end: undefined,
  });
  assert.equal(pageParams('orders', '#orders?order=9007199254740991').order, Number.MAX_SAFE_INTEGER);
  assert.equal(pageParams('orders', '#orders?order=9007199254740993').order, undefined, '超过安全整数上限时拒收');
  assert.deepEqual(pageParams('orders', '#orders?products=3,9007199254740993,5').products, [3, 5]);
  assert.equal(pageParams('orders', 'q=A?B&order=42').q, 'A?B');
  assert.equal(pageParams('orders', 'q=A?B&order=42').order, 42);
  assert.equal(pageParams('orders', 'unknown?order=7').order, undefined, '未知页面前缀不当作订单页参数');
  assert.equal(pageParams('orders', '#purchases?order=9').order, undefined, '别的页面地址不混用');
  assert.equal(pageParams('orders', '?order=7').order, 7);
  assert.equal(pageParams('orders', 'order=8').order, 8);
  assert.equal(pageParams('ai-settings', '#ai-settings?tab=templates&assistant=1').tab, 'templates');
  assert.equal(pageParams('ai-settings', '#ai-settings?tab=templates&assistant=1').assistant, true);
  assert.equal(pageParams('ai-settings', '#ai-settings?tab=unknown').tab, undefined);
});

test('withPageQuery 与 withPageTab 保留同页已登记参数并只更新目标参数', () => {
  assert.equal(withPageQuery('#ai-settings?tab=tools', '审批'), '#ai-settings?tab=tools&q=%E5%AE%A1%E6%89%B9');
  assert.equal(withPageQuery('#warehouse?kind=finished&deliveries=1', '纸箱'), '#warehouse?kind=finished&deliveries=1&q=%E7%BA%B8%E7%AE%B1');
  assert.equal(withPageTab('finance-ledger', '#finance-ledger?voucher=12&q=abc', 'books'), '#finance-ledger?tab=books&voucher=12&q=abc');
  assert.equal(withPageTab('finance-cash', '#finance-cash?cash=9&bogus=1', 'invoices'), '#finance-cash?tab=invoices&cash=9');
});

test('flowDocHref 生成四类单据地址，与 isPageHref、pageIdOf、分组、短名和视图切换一致', () => {
  assert.equal(flowDocHref('delivery', 5), '#warehouse?kind=finished&deliveries=1&doc=5');
  assert.equal(flowDocHref('delivery', 5, true), '#warehouse?kind=finished&deliveries=1&doc=5&archived=1');
  assert.equal(flowDocHref('arrival', 6), '#warehouse?arrivals=1&doc=6');
  assert.equal(flowDocHref('task', 7), '#production?doc=7');
  assert.equal(flowDocHref('production', 8, true), '#production?view=production&doc=8&archived=1');
  assert.ok(isFlowKind('delivery') && isFlowKind('arrival') && !isFlowKind('order'));

  assert.equal(pageIdOf('#finance-ar?tab=soon'), 'finance-ar');
  assert.equal(pageIdOf('orders?order=1'), 'orders');
  assert.equal(pageIdOf('#missing'), null);
  assert.ok(isPageId('dashboard') && !isPageId('missing'));
  assert.ok(isFinancePage('finance-ar') && !isFinancePage('orders'));
  assert.ok(financePageIds.every((id) => pages[id].group === '财务'));
  assert.deepEqual(pagesInGroup('财务'), financePageIds);
  assert.equal(pageTitle('production'), '生产管理');
  assert.equal(pageShortTitle('production'), '生产');
  assert.equal(pageShortTitle('orders'), '订单');
  assert.ok(isPageHref('#orders?order=1') && !isPageHref('#unknown') && !isPageHref('https://example.com'));

  assert.ok(productionViews[0].active('#production') && !productionViews[0].active('#production?view=production'));
  assert.ok(productionViews[1].active('#production?view=production'));
  assert.ok(warehouseViews[0].active('#warehouse') && warehouseViews[1].active('#warehouse?arrivals=1'));
  assert.ok(warehouseViews[2].active('#warehouse?deliveries=1&kind=finished') && warehouseViews[3].active('#warehouse?flow=1'));
});

// 编译期类型守卫（仅由 tsc 核对，不写恒成立的运行时断言）
void function compileTimePageHrefGuards() {
  // @ts-expect-error 未登记的页面编号不能通过编译
  pageHref('not-a-page');
  // @ts-expect-error orders 页面没有 inbox 参数（批 I 已移除）
  pageHref('orders', { inbox: 1 });
  // @ts-expect-error ai-settings 的 tab 只允许登记的页签
  pageHref('ai-settings', { tab: 'nope' });
  // @ts-expect-error order 必须是数字，不是字符串
  pageHref('orders', { order: '1' });
  // @ts-expect-error 财务页签拼错不能通过编译
  withPageTab('finance-cash', '#finance-cash', 'not-a-tab');
};
