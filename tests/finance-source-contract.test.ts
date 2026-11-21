// 财务和业务之间的约定（shared/business/finance-source.ts），直接比结构（只用虚构数据，不读库）：
// 1. 栏目归类表覆盖单据每一层的每个栏目：归类表登记的每一层，栏目和业务的单据结构一个不多、一个不少；
//    算进指纹的栏目里套着一层对象的，那一层也要登记（不然里面新加的说明会悄悄算进指纹）。
// 2. 到货、送货、完工单归“说明”的栏目改了，来源指纹用的内容不变：财务不会因为改个备注就新增、替换财务事件。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financeFieldClasses, financeSourceSchemas, financialContent } from '../shared/business/finance-source.js';
import { flowContentSchema } from '../shared/business/flow-document.js';
import { fieldSteps, pathText, type FieldStep } from './zod-fields.js';

/** 进财务的三种单据 */
const flowKinds = ['arrival', 'delivery', 'production'] as const;
type Kind = keyof typeof financeFieldClasses;
/** 归类表每一层在单据里的位置（路径，数组那一层不写） */
const layerPaths: Record<string, string> = { doc: '', lines: 'lines', item: 'lines.item', materials: 'materials' };
const parentOf = (path: string) => path.split('.').slice(0, -1).join('.');
const join = (layer: string, key: string) => (layer ? layer + '.' : '') + key;

/** 业务结构里每个栏目的路径（单据结构里带着的种类 kind 不是单据内容，不算） */
function schemaSteps(kind: Kind): FieldStep[][] {
  const schema = kind === 'stock' ? financeSourceSchemas.stock : flowContentSchema(kind);
  return fieldSteps(schema).filter((path) => pathText(path) !== 'kind');
}

const classTable: Record<Kind, Record<string, Readonly<Record<string, string>>>> = financeFieldClasses;
/** 归类表里一种来源的每一层：位置和这一层每个栏目的归类 */
const tableLayers = (kind: Kind) => Object.entries(classTable[kind]).map(([layer, classes]) => [layerPaths[layer], classes] as const);

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
function changesFingerprint(kind: string, paths: readonly FieldStep[][]) {
  const content = (path: readonly FieldStep[], value: string) => JSON.stringify(financialContent(kind, docWith(path, value)));
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
  const made = [[{ key: '虚构的新说明', list: false }], [{ key: 'lines', list: true }, { key: 'quantity', list: false }]];
  assert.deepEqual(changesFingerprint('delivery', made), ['虚构的新说明', 'lines.quantity']);
  assert.deepEqual(changesFingerprint('delivery', [[{ key: 'notes', list: false }]]), []);
});
