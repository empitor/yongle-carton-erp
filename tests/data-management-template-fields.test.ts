// 数据管理“新建”的空白模板（shared/business/data-management-templates.ts）和各模块的录入结构对得上：
// 录入结构里有的栏目，模板里要有（不给新建时填的，在 notInTemplate 登记原因）；模板里的栏目，录入结构里要有
// （没有的会在保存时被悄悄丢掉）。明细、纸板资料这类嵌套的一层层比。
// 录入结构：数据管理保存时查栏目用的那一份（server/admin/managed-records.ts 的 inputSchemas：档案、订单、采购单、
// 库存品是各自的保存校验，单据是 shared/business/physical-flow.ts 的录入规则）。
// 现在就对不上的登记在 knownGaps，只许减少：清单外多出来的拦，清单里已经对上的也拦（要从清单删掉）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { inputSchemas } from '../server/admin/managed-records.js';
import { objectShape } from './zod-fields.js';
import { dataManagementModules, dataManagementNames, dataManagementTemplate } from '../shared/business/index.js';
import { isRecord } from '../shared/core/index.js';

type Schema = z.core.$ZodType;

/** 一处对不上：哪个模块、哪一格（明细里的写成 lines.taxRate）、哪边少了 */
type Gap = string;
const TEMPLATE_LACKS = '模板里没有';
const SCHEMA_LACKS = '录入结构里没有';
type Side = typeof TEMPLATE_LACKS | typeof SCHEMA_LACKS;

/** 录入结构有、模板故意不放的栏目，和原因 */
const notInTemplate: Partial<Record<Gap, string>> = {
  'orders:lines.id': '明细编号：保存时分配，新建的明细没有编号',
  'purchases:lines.id': '明细编号：保存时分配，新建的明细没有编号',
};

/** 现在就对不上、还没定怎么改的（只许减少）。改好一处就从这里删掉一条 */
const knownGaps: Partial<Record<Gap, Side>> = {
  'products:dimensionUnitRaw': TEMPLATE_LACKS,
  'products:customerProductCode': TEMPLATE_LACKS,
  'products:parentProductId': TEMPLATE_LACKS,
  'orders:supplierName': TEMPLATE_LACKS,
  'orders:taxRate': TEMPLATE_LACKS,
  'orders:taxMode': TEMPLATE_LACKS,
  'orders:terms': TEMPLATE_LACKS,
  'orders:lines.productName': TEMPLATE_LACKS,
  'orders:lines.customerProductCode': TEMPLATE_LACKS,
  'orders:lines.taxRate': TEMPLATE_LACKS,
  'orders:lines.taxMode': TEMPLATE_LACKS,
  'orders:lines.deliveryDate': TEMPLATE_LACKS,
  'purchases:lines.customerOrderId': TEMPLATE_LACKS,
  'arrival:actualTime': TEMPLATE_LACKS,
  'arrival:orderBatchId': TEMPLATE_LACKS,
  'arrival:lines.acceptedQuantity': TEMPLATE_LACKS,
  'arrival:lines.rejectedQuantity': TEMPLATE_LACKS,
  'arrival:lines.stockedQuantity': TEMPLATE_LACKS,
  'task:plannedDate': TEMPLATE_LACKS,
  'task:plannedTime': TEMPLATE_LACKS,
  'delivery:plannedDate': TEMPLATE_LACKS,
  'delivery:plannedTime': TEMPLATE_LACKS,
  'delivery:actualTime': TEMPLATE_LACKS,
};

/**
 * 模板和录入结构逐层比，返回对不上的栏目（路径 → 哪边少了）。模板里一组（明细）按第一行比；
 * 模板值是 null（订单的预估成本没有就是 null）或不是对象的，不往下比。
 */
function templateGaps(template: unknown, schema: Schema, prefix = ''): Map<string, Side> {
  const out = new Map<string, Side>();
  const value: unknown = Array.isArray(template) ? template[0] : template;
  const shape = objectShape(schema);
  if (!isRecord(value) || !shape) return out;
  for (const key of Object.keys(shape)) if (!Object.hasOwn(value, key)) out.set(prefix + key, TEMPLATE_LACKS);
  for (const [key, inner] of Object.entries(value)) {
    const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (!field) out.set(prefix + key, SCHEMA_LACKS);
    else for (const [path, side] of templateGaps(inner, field, prefix + key + '.')) out.set(path, side);
  }
  return out;
}

/** 全部模块对不上的栏目，去掉登记了原因的；再和只许减少的清单比：多出来的、清单里已经对上的各列出来 */
function gapProblems(found: ReadonlyMap<Gap, Side>, reasons: Partial<Record<Gap, string>>, backlog: Partial<Record<Gap, Side>>) {
  const unexplained = [...found].filter(([gap]) => !Object.hasOwn(reasons, gap));
  const added = unexplained.filter(([gap, side]) => backlog[gap] !== side).map(([gap, side]) => `${gap}（${side}）`);
  const staleReasons = Object.keys(reasons).filter((gap) => found.get(gap) !== TEMPLATE_LACKS);
  const fixed = Object.keys(backlog).filter((gap) => !found.has(gap) || Object.hasOwn(reasons, gap));
  return { added, fixed: [...fixed, ...staleReasons] };
}

const allGaps = () =>
  new Map(
    dataManagementModules.flatMap((module) =>
      [...templateGaps(dataManagementTemplate(module, '2026-01-01'), inputSchemas[module])].map(
        ([path, side]): [Gap, Side] => [`${module}:${path}`, side],
      ),
    ),
  );

test('数据管理每个模块的新建模板和录入结构的栏目对得上（已有的对不上只许减少）', () => {
  const found = allGaps();
  assert.ok(found.size > 0 || Object.keys(knownGaps).length === 0, '比到了栏目');
  const { added, fixed } = gapProblems(found, notInTemplate, knownGaps);
  const named = (gaps: string[]) => gaps.map((g) => (dataManagementNames[g.split(':')[0]] ?? '') + ' ' + g);
  assert.deepEqual(
    named(added),
    [],
    '数据管理的新建模板（shared/business/data-management-templates.ts）和录入结构对不上：' +
      '“模板里没有”的，在模板里加上这一栏（确实不给新建时填的，在本测试 notInTemplate 写明原因）；' +
      '“录入结构里没有”的，保存时会被悄悄丢掉，从模板里删掉或在录入结构里加上',
  );
  assert.deepEqual(named(fixed), [], '这几条已经对上了（或登记的原因不再成立），请从本测试的 knownGaps、notInTemplate 删掉');
});

test('模板检查真的会拦：少一栏、多一栏都报出来，对得上的放过，过期的登记也报', () => {
  const schema = z.object({ name: z.string(), lines: z.array(z.object({ id: z.number().optional(), quantity: z.string() })) });
  assert.deepEqual([...templateGaps({ name: '', lines: [{ quantity: '' }] }, schema)], [['lines.id', TEMPLATE_LACKS]]);
  assert.deepEqual(
    [...templateGaps({ lines: [{ id: null, quantity: '', 虚构多余栏: '' }] }, schema)],
    [['name', TEMPLATE_LACKS], ['lines.虚构多余栏', SCHEMA_LACKS]],
  );
  const found = new Map<Gap, Side>([['orders:lines.id', TEMPLATE_LACKS], ['orders:taxRate', TEMPLATE_LACKS]]);
  assert.deepEqual(gapProblems(found, { 'orders:lines.id': '虚构原因' }, { 'orders:taxRate': TEMPLATE_LACKS }), { added: [], fixed: [] });
  assert.deepEqual(gapProblems(found, {}, { 'orders:taxRate': TEMPLATE_LACKS }).added, ['orders:lines.id（模板里没有）']);
  assert.deepEqual(gapProblems(found, { 'orders:lines.id': '虚构原因' }, { 'orders:taxRate': TEMPLATE_LACKS, 'orders:notes': TEMPLATE_LACKS }).fixed, [
    'orders:notes',
  ]);
});
