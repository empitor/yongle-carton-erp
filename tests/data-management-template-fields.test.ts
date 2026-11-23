// 数据管理“新建”的空白模板（shared/business/overview/data-management-templates.ts）和各模块的录入结构对得上：
// 录入结构里有的栏目，模板里要有（不给新建时填的，在 notInTemplate 登记原因）；模板里的栏目，录入结构里要有
// （没有的会在保存时被悄悄丢掉）。明细、纸板资料这类嵌套的一层层比。
// 录入结构：数据管理保存时查栏目用的那一份（server/admin/managed-records.ts 的 inputSchemas：档案、订单、采购单、
// 库存品是各自的保存校验，单据是 shared/business/flow/physical-flow.ts 的录入规则）。
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
  'products:dimensionUnitRaw': '原文尺寸单位：识别导入时记下原件上看不懂的单位写法，手工新建没有原件',
  'orders:lines.productName':
    '本单名称：不填就按产品档案的名称存（server/sales/orders.ts 的 lineName），放一个空格子进来会被“至少一个字”拦下；要另起名字的保存后再编辑',
  'arrival:orderBatchId': '订货单：只在按订货单登记到货时由系统记下，手工新建没有',
  'delivery:actualTime': '实际送货时间：新建的送货单是待送货，出库时才有',
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

/** 对不上的栏目里，去掉登记了原因的；登记的原因不再成立（已经对上了）的另列出来 */
function gapProblems(found: ReadonlyMap<Gap, Side>, reasons: Partial<Record<Gap, string>>) {
  const unexplained = [...found].filter(([gap]) => !Object.hasOwn(reasons, gap)).map(([gap, side]) => `${gap}（${side}）`);
  const stale = Object.keys(reasons).filter((gap) => found.get(gap) !== TEMPLATE_LACKS);
  return { unexplained, stale };
}

const allGaps = () =>
  new Map(
    dataManagementModules.flatMap((module) =>
      [...templateGaps(dataManagementTemplate(module, '2026-01-01'), inputSchemas[module])].map(
        ([path, side]): [Gap, Side] => [`${module}:${path}`, side],
      ),
    ),
  );

test('数据管理每个模块的新建模板和录入结构的栏目对得上，故意不放的都写了原因', () => {
  const { unexplained, stale } = gapProblems(allGaps(), notInTemplate);
  const named = (gaps: string[]) => gaps.map((g) => (dataManagementNames[g.split(':')[0]] ?? '') + ' ' + g);
  assert.deepEqual(
    named(unexplained),
    [],
    '数据管理的新建模板（shared/business/overview/data-management-templates.ts）和录入结构对不上：' +
      '“模板里没有”的，在模板里加上这一栏（确实不给新建时填的，在本测试 notInTemplate 写明原因）；' +
      '“录入结构里没有”的，保存时会被悄悄丢掉，从模板里删掉或在录入结构里加上',
  );
  assert.deepEqual(named(stale), [], '这几条已经对上了（登记的原因不再成立），请从本测试的 notInTemplate 删掉');
});

test('模板检查真的会拦：少一栏、多一栏都报出来，对得上的放过，过期的原因也报', () => {
  const schema = z.object({ name: z.string(), lines: z.array(z.object({ id: z.number().optional(), quantity: z.string() })) });
  assert.deepEqual([...templateGaps({ name: '', lines: [{ quantity: '' }] }, schema)], [['lines.id', TEMPLATE_LACKS]]);
  assert.deepEqual(
    [...templateGaps({ lines: [{ id: null, quantity: '', 虚构多余栏: '' }] }, schema)],
    [['name', TEMPLATE_LACKS], ['lines.虚构多余栏', SCHEMA_LACKS]],
  );
  const found = new Map<Gap, Side>([['orders:lines.id', TEMPLATE_LACKS], ['orders:taxRate', TEMPLATE_LACKS]]);
  assert.deepEqual(gapProblems(found, { 'orders:lines.id': '虚构原因' }), { unexplained: ['orders:taxRate（模板里没有）'], stale: [] });
  assert.deepEqual(gapProblems(found, { 'orders:lines.id': '虚构原因', 'orders:taxRate': '虚构', 'orders:notes': '虚构' }).stale, [
    'orders:notes',
  ]);
});
