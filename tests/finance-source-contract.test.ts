// 财务和业务之间的约定（shared/business/finance-source.ts），直接比结构（只用虚构数据，不读库）：
// 1. 栏目归类表覆盖单据每一层的每个栏目：归类表登记的每一层，栏目和业务的单据结构一个不多、一个不少；
//    算进指纹的栏目里套着一层对象的，那一层也要登记（不然里面新加的说明会悄悄算进指纹）。
// 2. 到货、送货、完工单归“说明”的栏目改了，来源指纹用的内容不变：财务不会因为改个备注就新增、替换财务事件。
// 3. 算进指纹的内容（financeFingerprint）和归类表一样多一样细：归“算”的栏目改了指纹就变，不算的改了不变；
//    改名表（fingerprintRules）的层和归类表的层对得上（层的位置只在改名表写），一层里财务口径的名字不重复。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financeFieldClasses, financeFingerprint, financeSourceSchemas, fingerprintOf, fingerprintRules } from '../shared/business/finance-source.js';
import { flowContentSchema } from '../shared/business/flow-document.js';
import { isRecord } from '../shared/core/index.js';
import { arrivalFull, deliveryFull, productionFull, stockFull, storedContent } from './finance-source-fixture.js';
import { fieldSteps, pathText, type FieldStep } from './zod-fields.js';

/** 进财务的三种单据 */
const flowKinds = ['arrival', 'delivery', 'production'] as const;
type Kind = keyof typeof financeFieldClasses;
const parentOf = (path: string) => path.split('.').slice(0, -1).join('.');
const join = (layer: string, key: string) => (layer ? layer + '.' : '') + key;
type RuleLayer = Parameters<typeof fingerprintOf>[0];
/** 改名表一层层的位置：[层名, 路径]，表头叫 doc，往下的层按栏目名叫（层的位置只在 fingerprintRules 里写一处） */
const rulePaths = (layer: RuleLayer, at = '', name = 'doc'): [string, string][] => [
  [name, at],
  ...Object.entries(layer.nested ?? {}).flatMap(([key, inner]) => rulePaths(inner, join(at, key), key)),
];
/** 归类表每一层在单据里的位置（路径，数组那一层不写），按改名表找；改名表里没有的层位置写成一句说明，后面的检查会报出来 */
const layerPath = (kind: Kind, layer: string) =>
  new Map(rulePaths(fingerprintRules[kind])).get(layer) ?? '（改名表 fingerprintRules 里没有“' + layer + '”这一层）';

/** 业务结构里每个栏目的路径（单据结构里带着的种类 kind 不是单据内容，不算） */
function schemaSteps(kind: Kind): FieldStep[][] {
  const schema = kind === 'stock' ? financeSourceSchemas.stock : flowContentSchema(kind);
  return fieldSteps(schema).filter((path) => pathText(path) !== 'kind');
}

const classTable: Record<Kind, Record<string, Readonly<Record<string, string>>>> = financeFieldClasses;
/** 归类表里一种来源的每一层：位置和这一层每个栏目的归类 */
const tableLayers = (kind: Kind) => Object.entries(classTable[kind]).map(([layer, classes]) => [layerPath(kind, layer), classes] as const);

/** 归类表和业务结构对不上的地方：登记了的层多了、少了的栏目；算进指纹却没登记里面那一层的对象 */
function coverageProblems(kind: Kind, paths: readonly string[]) {
  const layers = tableLayers(kind),
    registered = new Set(layers.map(([at]) => at));
  const classOf = new Map(layers.flatMap(([at, classes]) => Object.entries(classes).map(([key, c]) => [join(at, key), c] as const)));
  return {
    unclassified: layers.flatMap(([at]) => paths.filter((p) => parentOf(p) === at && !classOf.has(p))),
    stale: [...classOf.keys()].filter((p) => !paths.includes(p)),
    countedWithoutLayer: paths.filter((p) => classOf.get(p) === 'count' && paths.some((q) => parentOf(q) === p) && !registered.has(p)),
  };
}

test('栏目归类表覆盖每种来源每一层的每个栏目，算进指纹的对象里那一层也登记了', () => {
  for (const kind of [...flowKinds, 'stock'] as const) {
    const paths = schemaSteps(kind).map(pathText);
    assert.ok(paths.includes(kind === 'stock' ? 'deltaUnits' : 'date'), kind + ' 读到了业务结构');
    assert.deepEqual(
      coverageProblems(kind, paths),
      { unclassified: [], stale: [], countedWithoutLayer: [] },
      `${kind}：shared/business/finance-source.ts 的 financeFieldClasses 和业务的单据结构对不上，请给新栏目归类、删掉没有了的栏目`,
    );
  }
});

test('归类表的检查真的会拦：没归类的栏目、多出来的栏目、算进指纹却没登记的一层都报出来', () => {
  const paths = [...schemaSteps('production').map(pathText), '虚构新栏目', 'materials.虚构领料栏目', 'productId.虚构'];
  const found = coverageProblems('production', paths.filter((p) => p !== 'goodQuantity'));
  assert.deepEqual(found, { unclassified: ['虚构新栏目', 'materials.虚构领料栏目'], stale: ['goodQuantity'], countedWithoutLayer: ['productId'] });
});

/** 这种单据归“说明”的栏目的路径（一步一步写，带上是不是一组），从业务结构里找 */
function infoSteps(kind: (typeof flowKinds)[number]): FieldStep[][] {
  const info = new Set(
    tableLayers(kind).flatMap(([at, classes]) => Object.keys(classes).filter((key) => classes[key] === 'info').map((key) => join(at, key))),
  );
  return schemaSteps(kind).filter((path) => info.has(pathText(path)));
}

/** 按路径造一份只有这一项的单据内容：一组的那一层放一行 */
function docWith(path: readonly FieldStep[], value: string): Record<string, unknown> {
  const [step, ...rest] = path;
  if (!step) return {};
  const inner = rest.length ? docWith(rest, value) : value;
  return { [step.key]: step.list ? [inner] : inner };
}

/** 改了以后指纹用的内容跟着变的栏目（应该一个都没有）：同一张单据只差这一项，算两次比 */
function changesFingerprint(kind: Kind, paths: readonly FieldStep[][]) {
  const content = (path: readonly FieldStep[], value: string) => JSON.stringify(financeFingerprint(kind, docWith(path, value)));
  return paths.filter((path) => content(path, '虚构说明甲') !== content(path, '虚构说明乙')).map(pathText);
}

test('到货、送货、完工单归“说明”的栏目改了，来源指纹用的内容不变', () => {
  for (const kind of flowKinds) {
    const paths = infoSteps(kind);
    assert.ok(paths.some((p) => pathText(p) === 'notes'), kind + ' 找到了说明栏目');
    assert.deepEqual(changesFingerprint(kind, paths), [], `${kind} 的这些说明栏目算进了财务的来源指纹：改个备注就会让财务新增或替换事件`);
  }
});

test('说明栏目的检查真的会拦：算进指纹的栏目被报出来，不算的放过', () => {
  const made = [[{ key: 'customerId', list: false }], [{ key: 'lines', list: true }, { key: 'quantity', list: false }]];
  assert.deepEqual(changesFingerprint('delivery', made), ['customerId', 'lines.quantity']);
  assert.deepEqual(changesFingerprint('delivery', [[{ key: 'notes', list: false }], [{ key: '虚构的新说明', list: false }]]), [], '约定外的栏目也不进指纹');
});

/** 每种来源全填的虚构单据（tests/finance-source-fixture.ts），先走正式的读法（按库里的单据结构解析、补默认值） */
const fullSamples: Record<Kind, Record<string, unknown>> = {
  delivery: storedContent('delivery', deliveryFull),
  arrival: storedContent('arrival', arrivalFull),
  production: storedContent('production', productionFull),
  stock: storedContent('stock', stockFull),
};

/** 一个栏目的归类：登记了的层里的看自己；层之外的（撤销记录里的原因这类）跟着它所在的那个栏目 */
function classOfPath(kind: Kind, path: string) {
  const classOf = new Map(tableLayers(kind).flatMap(([at, classes]) => Object.entries(classes).map(([key, c]) => [join(at, key), c] as const)));
  for (let p = path; p; p = parentOf(p)) {
    const found = classOf.get(p);
    if (found) return found;
  }
  return '没归类';
}

/** 换一个值：数字加一、文字加一个字、真假反过来，别的（空、一组、对象）换成一段文字 */
const another = (value: unknown) =>
  typeof value === 'number' ? value + 1 : typeof value === 'string' ? value + '变' : typeof value === 'boolean' ? !value : '虚构新值';

/** 全填的单据只改一个栏目（一组的那一层改第一行；路上没有的对象补上） */
function withChange(sample: Record<string, unknown>, path: readonly FieldStep[]) {
  const copy = structuredClone(sample);
  let node: unknown = copy;
  path.forEach((step, i) => {
    if (!isRecord(node)) return;
    if (i === path.length - 1) {
      node[step.key] = another(node[step.key]);
      return;
    }
    const next = isRecord(node[step.key]) || Array.isArray(node[step.key]) ? node[step.key] : (node[step.key] = step.list ? [{}] : {});
    node = Array.isArray(next) ? next[0] : next;
  });
  return copy;
}

/**
 * 算进指纹的内容和归类表对不上的栏目：归“算”的改了内容却不变，或者不算的改了内容却变了。
 * fingerprint 是取算进指纹的内容的办法（默认是约定的 financeFingerprint）。
 */
function fingerprintMismatches(kind: Kind, fingerprint = (content: unknown) => financeFingerprint(kind, content)) {
  const layers = new Set(tableLayers(kind).map(([at]) => at));
  const base = JSON.stringify(fingerprint(fullSamples[kind]));
  return schemaSteps(kind)
    .filter((path) => !layers.has(pathText(path)))
    .flatMap((path) => {
      const counted = classOfPath(kind, pathText(path)) === 'count';
      const moved = JSON.stringify(fingerprint(withChange(fullSamples[kind], path))) !== base;
      return counted === moved ? [] : [pathText(path) + (counted ? '（归“算”，改了指纹却不变）' : '（不算，改了指纹却变了）')];
    });
}

test('算进指纹的栏目和归类表一样多一样细：归“算”的每个栏目改了指纹就变，不算的改了都不变（四种来源，全填的单据）', () => {
  for (const kind of [...flowKinds, 'stock'] as const) assert.deepEqual(fingerprintMismatches(kind), [], kind);
});

test('算进指纹的检查真的会拦：改名表漏了一个归“算”的栏目、多取了一个不算的，都报出来', () => {
  const rules = fingerprintRules.delivery;
  const { customerId: _dropped, ...kept } = rules.names;
  assert.deepEqual(fingerprintMismatches('delivery', (c) => fingerprintOf({ ...rules, names: kept }, c)), ['customerId（归“算”，改了指纹却不变）']);
  assert.deepEqual(fingerprintMismatches('delivery', (c) => fingerprintOf({ ...rules, names: { ...rules.names, notes: 'notes' } }, c)), [
    'notes（不算，改了指纹却变了）',
  ]);
});

test('改名表的层和归类表的层一一对上：外层栏目（一组明细、纸板资料、领料）改名时两边一起改', () => {
  for (const kind of [...flowKinds, 'stock'] as const)
    assert.deepEqual(rulePaths(fingerprintRules[kind]).map(([layer]) => layer).sort(), Object.keys(classTable[kind]).sort(), kind);
});

/** 改名表里一层对到同一个财务口径名字的栏目（后一个会悄悄盖掉前一个）：[层, 名字] */
const duplicateNames = (layer: RuleLayer, at = 'doc'): string[] => [
  ...Object.values(layer.names).filter((name, i, all) => all.indexOf(name) !== i).map((name) => at + '：' + name),
  ...Object.entries(layer.nested ?? {}).flatMap(([key, inner]) => duplicateNames(inner, key)),
];

test('财务口径的名字一层里不重复：两个业务栏目对到同一个名字时报出来', () => {
  for (const kind of [...flowKinds, 'stock'] as const) assert.deepEqual(duplicateNames(fingerprintRules[kind]), [], kind);
  const rules = fingerprintRules.delivery;
  assert.deepEqual(duplicateNames({ ...rules, names: { ...rules.names, customerName: 'customerId' } }), ['doc：customerId']);
});
