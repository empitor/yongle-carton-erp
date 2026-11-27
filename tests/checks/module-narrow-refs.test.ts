// 窄引用：模块表允许了方向（tests/module-map.ts），但只许用对方的几个名字。按 refsOf 记下的引入名字查，看不出名字的也拦。
// 财务从业务拿数据只走单据流转的只读窗口，用共用业务只许单据和财务的约定加几样算金额、显示用的（docs/功能/财务取数和补扫.md“财务从哪拿业务数据”）。
// 改已有产品（updateProduct）只许订单服务调，由它在同一个保存点里同步成品库存。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { all, moduleOf, refsOf, scriptKind, tools, type Ref } from './module-map.js';

/** 一个文件 export 出来的声明名（export const、function、type、interface、class、enum） */
const declaredExports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^export (?:const|function|type|interface|class|enum) (\w+)/gm)].map((m) => m[1]);

const narrowRefs: { from: string; to: string; allowed: () => string[]; how: string }[] = [
  {
    from: '财务',
    to: '单据流转',
    allowed: () => declaredExports('server/flow/finance-facts/facts.ts'),
    how: '财务用单据流转只许只读窗口 financeFacts 和它导出的类型名：要的数据在 server/flow/finance-facts/ 加一组或一个只读函数，财务调 financeFacts',
  },
  {
    from: '财务',
    to: '共用-业务',
    allowed: () => [
      ...declaredExports('shared/business/flow/finance-source.ts'),
      ...['arrivalLineValue', 'deliveryLineValue', 'priceText', 'sizeText', 'movementSource'],
    ],
    how: '财务用共用业务只许单据和财务的约定（shared/business/flow/finance-source.ts 的导出）和 arrivalLineValue、deliveryLineValue、priceText、sizeText、movementSource（流水来源编码，按名字引用）：要的东西放进约定，或改由窗口 financeFacts 给数据',
  },
];

/** 表里管着的模块的文件（只解析这些，别的模块不受这张表管） */
const ruledFiles = () => all.filter((f) => narrowRefs.some((n) => n.from === moduleOf(f)?.name));

/** 模块代码一个文件的窄引用违规 */
function narrowViolations(f: string, refs: Ref[] = refsOf(f)) {
  const from = moduleOf(f);
  const out: string[] = [];
  for (const r of refs) {
    const to = r.target ? moduleOf(r.target) : undefined;
    const rule = narrowRefs.find((n) => n.from === from?.name && n.to === to?.name);
    if (!rule) continue;
    const allowed = new Set(rule.allowed());
    const bad = r.names ? r.names.filter((n) => !allowed.has(n)) : ['（看不出引了哪些名字，改成 import { 名字 } from 的写法）'];
    for (const n of bad) out.push(f + ':' + r.line + '（' + rule.from + '）→ ' + r.target + ' 的 ' + n + '：' + rule.how);
  }
  return out;
}

/** 改产品和同步成品库存由订单服务在同一个保存点内完成。 */
const productUpdate = {
  member: 'updateProduct',
  caller: '订单服务',
  how: '改已有产品须经订单服务，由它同步成品库存',
};

function accessedMember(n: ts.Node) {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
  if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
    const key = n.propertyName ?? n.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
    if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)) return key.expression.text;
  }
}

function productUpdateViolations(file: string, text: string = readFileSync(file, 'utf8')) {
  if (moduleOf(file)?.name === productUpdate.caller || !text.includes(productUpdate.member)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (accessedMember(n) === productUpdate.member) {
      const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
      out.push(file + ':' + line + ' 的 ' + productUpdate.member + '：' + productUpdate.how);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

test('窄引用：财务经只读窗口读业务，改已有产品经订单服务同步成品库存', () => {
  assert.deepEqual(ruledFiles().flatMap((f) => narrowViolations(f)), []);
  assert.deepEqual([...all, ...tools].flatMap((f) => productUpdateViolations(f)), []);
});

test('回归：窄引用拦住财务引单据流转的服务和别的名字、看不出名字的引用，窗口和约定不误报', () => {
  const blocked: [text: string, expect: string][] = [
    ["import { FlowService } from '../flow/index.js';", '的 FlowService'],
    ["import type { FlowService } from '../flow/index.js';", '的 FlowService'],
    ["import * as flow from '../flow/index.js';", '看不出引了哪些名字'],
    ["export const load = () => import('../flow/index.js');", '看不出引了哪些名字'],
    ["import { flowInput } from '../../shared/business/index.js';", '的 flowInput'],
    ["import { flowDocumentSchema } from '../../shared/business/index.js';", '的 flowDocumentSchema'],
  ];
  for (const [text, expect] of blocked) {
    const found = narrowViolations('server/finance/sample.ts', refsOf('server/finance/sample.ts', text));
    assert.ok(found.some((x) => x.includes(expect)), '应拦住：' + text + '\n实际：' + JSON.stringify(found));
  }
  const allowed = [
    "import { financeFacts } from '../flow/index.js';",
    "import { priceText, financeFingerprint, type FinanceSource } from '../../shared/business/index.js';",
  ];
  for (const text of allowed) assert.deepEqual(narrowViolations('server/finance/sample.ts', refsOf('server/finance/sample.ts', text)), [], '不该拦：' + text);
  // 别的模块不受这张表管
  assert.deepEqual(narrowViolations('server/overview/sample.ts', refsOf('server/overview/sample.ts', "import { FlowService } from '../flow/index.js';")), []);

  for (const text of [
    'sales(store).updateProduct(input, id, version);',
    "records['updateProduct'](input, id, version);",
    'const { updateProduct: update } = records;',
  ]) {
    assert.equal(productUpdateViolations('server/import/sample.ts', text).length, 1, text);
    assert.deepEqual(productUpdateViolations('server/orders/sample.ts', text), []);
  }
  assert.deepEqual(productUpdateViolations('server/import/sample.ts', 'sales(store).createProduct(input);'), []);
});
