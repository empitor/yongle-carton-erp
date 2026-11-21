// 窄引用：模块表允许了方向（tests/module-map.ts），但只许用对方的几个名字。按 refsOf 记下的引入名字查，看不出名字的也拦。
// 财务从业务拿数据只走单据流转的只读窗口，用共用业务只许单据和财务的约定加几样算金额、显示用的（docs/架构说明.md“财务事件和凭证”）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { all, moduleOf, refsOf, type Ref } from './module-map.js';

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
      ...declaredExports('shared/business/finance-source.ts'),
      ...['arrivalLineValue', 'deliveryLineValue', 'priceText', 'sizeText', 'stockKinds', 'movementSourceKinds'],
    ],
    how: '财务用共用业务只许单据和财务的约定（shared/business/finance-source.ts 的导出）和 arrivalLineValue、deliveryLineValue、priceText、sizeText、stockKinds、movementSourceKinds：要的东西放进约定，或改由窗口 financeFacts 给数据',
  },
];
/**
 * 等窗口接手后删：财务现在还在引、窄引用之外的名字，窗口那一批做完财务就不再引。只许减少：搬走了就删掉这一条（用不上了下面的测试会报），
 * 不许往里加。
 */
const narrowPending: { from: string; to: string; name: string; batch: string; why: string }[] = [
  { from: '财务', to: '共用-业务', name: 'flowDocumentSchema', batch: 'B1 来源', why: 'business-source.ts 的 readSource 按单据结构读单据内容，改由窗口的 sources.read 给财务口径' },
  { from: '财务', to: '共用-业务', name: 'purchaseLineDocumentSchema', batch: 'B3 采购', why: 'business-source.ts 的 purchaseLineItem 读采购明细内容，改由窗口的 purchases.lines 给' },
  { from: '财务', to: '共用-业务', name: 'purchaseLineAmount', batch: 'B3 采购', why: 'invoice-matching.ts 按采购明细算开票对比的金额，改由窗口的 purchases.lines 给' },
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
    const pending = narrowPending.filter((p) => p.from === rule.from && p.to === rule.to).map((p) => p.name);
    const allowed = new Set([...rule.allowed(), ...pending]);
    const bad = r.names ? r.names.filter((n) => !allowed.has(n)) : ['（看不出引了哪些名字，改成 import { 名字 } from 的写法）'];
    for (const n of bad) out.push(f + ':' + r.line + '（' + rule.from + '）→ ' + r.target + ' 的 ' + n + '：' + rule.how);
  }
  return out;
}

test('窄引用：财务用单据流转只走只读窗口 financeFacts，用共用业务只用约定和登记的几样', () => {
  assert.deepEqual(ruledFiles().flatMap((f) => narrowViolations(f)), []);
});

test('“等窗口接手后删”的名单都还有财务在引（搬走了就删掉，名单只许减少）', () => {
  const used = new Set(
    ruledFiles().flatMap((f) =>
      refsOf(f).flatMap((r) => (r.target ? (r.names ?? []).map((n) => moduleOf(f)?.name + '→' + moduleOf(r.target ?? '')?.name + '→' + n) : [])),
    ),
  );
  assert.deepEqual(
    narrowPending.filter((p) => !used.has(p.from + '→' + p.to + '→' + p.name)).map((p) => p.name + '（' + p.batch + '）：已经没人引了，从 narrowPending 删掉'),
    [],
  );
});

test('回归：窄引用拦住财务引单据流转的服务和别的名字、看不出名字的引用，窗口和约定不误报', () => {
  const blocked: [text: string, expect: string][] = [
    ["import { FlowService } from '../flow/index.js';", '的 FlowService'],
    ["import type { FlowService } from '../flow/index.js';", '的 FlowService'],
    ["import * as flow from '../flow/index.js';", '看不出引了哪些名字'],
    ["export const load = () => import('../flow/index.js');", '看不出引了哪些名字'],
    ["import { flowInput } from '../../shared/business/index.js';", '的 flowInput'],
  ];
  for (const [text, expect] of blocked) {
    const found = narrowViolations('server/finance/sample.ts', refsOf('server/finance/sample.ts', text));
    assert.ok(found.some((x) => x.includes(expect)), '应拦住：' + text + '\n实际：' + JSON.stringify(found));
  }
  const allowed = [
    "import { financeFacts } from '../flow/index.js';",
    "import { priceText, financialContent, type FinanceSource } from '../../shared/business/index.js';",
    "import { flowDocumentSchema } from '../../shared/business/index.js';",
  ];
  for (const text of allowed) assert.deepEqual(narrowViolations('server/finance/sample.ts', refsOf('server/finance/sample.ts', text)), [], '不该拦：' + text);
  // 别的模块不受这张表管
  assert.deepEqual(narrowViolations('server/business/sample.ts', refsOf('server/business/sample.ts', "import { FlowService } from '../flow/index.js';")), []);
});
