import { z } from 'zod';
import {
  customerSchema,
  productSchema,
  orderSchema,
  lineSchema,
  costSchema,
} from '../../shared/domain.js';
import { CATALOG_VERSION, writableFieldPaths } from '../business/metadata.js';
import { InputError } from '../db.js';
// 新订单工作区采用通用来源引用；旧 Excel 建议契约继续兼容且仍无执行器。
export {
  sourceReferenceSchema,
  analysisSchema,
  chatReplySchema,
} from '../../shared/order-draft.js';

// 模型仅提交“建议”，不能提交登录身份、审批结果、SQL 或可执行代码。
const sourceRow = z.strictObject({
  sheet: z.string().min(1).max(100),
  row: z.number().int().positive(),
});
const recordRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), id: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('planned'), key: z.string().min(1).max(100) }),
]);
const orderProposal = z
  .strictObject({
    ...orderSchema.shape,
    costs: costSchema.strict().nullable(),
    customerId: recordRef,
    lines: z
      .array(z.strictObject({ ...lineSchema.shape, productId: recordRef }))
      .min(1)
      .max(50),
  })
  .partial();
const common = {
  key: z.string().min(1).max(100),
  disposition: z.enum(['create', 'update', 'ignore', 'conflict', 'error']),
  sourceRows: z.array(sourceRow).min(1).max(1000),
  target: z
    .strictObject({ id: z.number().int().positive(), version: z.number().int().positive() })
    .nullable(),
  dependsOn: z.array(z.string().min(1).max(100)).max(500),
  reason: z.string().min(1).max(1000),
  issues: z
    .array(z.strictObject({ field: z.string().max(100), message: z.string().min(1).max(1000) }))
    .max(100),
};
export const importProposalSchema = z.strictObject({
  contractVersion: z.literal('1'),
  catalogVersion: z.literal(CATALOG_VERSION),
  mappings: z
    .array(
      z.strictObject({
        sheet: z.string().min(1).max(100),
        headerRow: z.number().int().positive(),
        column: z.string().regex(/^[A-Z]{1,3}$/),
        sourceHeader: z.string().max(200),
        entity: z.enum(['customers', 'products', 'orders']),
        targetField: z.string().min(1).max(100),
        certainty: z.enum(['certain', 'needs-review']),
        evidence: z.string().min(1).max(1000),
      }),
    )
    .max(200),
  rows: z
    .array(
      z.discriminatedUnion('entity', [
        z.strictObject({
          ...common,
          entity: z.literal('customers'),
          proposed: customerSchema.strict().partial().nullable(),
        }),
        z.strictObject({
          ...common,
          entity: z.literal('products'),
          proposed: z
            .strictObject(
              Object.fromEntries(
                Object.entries(productSchema.shape).map(([name, field]) => [
                  name,
                  field instanceof z.ZodDefault ? field.removeDefault() : field,
                ]),
              ),
            )
            .partial()
            .nullable(),
        }),
        z.strictObject({
          ...common,
          entity: z.literal('orders'),
          proposed: orderProposal.nullable(),
        }),
      ]),
    )
    .max(500),
  warnings: z.array(z.string().min(1).max(1000)).max(100),
});
export type ImportProposal = z.infer<typeof importProposalSchema>;

// 此校验器没有 Store 参数，也没有写库功能。结构校验通过仍不等于可执行。
export function parseImportProposal(raw: unknown): ImportProposal {
  const proposal = importProposalSchema.parse(raw);
  const keys = new Map(proposal.rows.map((row) => [row.key, row]));
  if (keys.size !== proposal.rows.length) throw new InputError('导入建议中的临时编号重复');
  for (const mapping of proposal.mappings)
    if (!writableFieldPaths(mapping.entity).includes(mapping.targetField))
      throw new InputError('列映射指向未开放的字段：' + mapping.targetField);
  for (const row of proposal.rows) {
    if (row.disposition === 'update' && !row.target)
      throw new InputError('更新建议缺少目标记录和版本号');
    if (row.disposition === 'create' && row.target)
      throw new InputError('新增建议不能指定已有目标');
    if (['create', 'update'].includes(row.disposition) && !row.proposed)
      throw new InputError('修改建议缺少数据');
    for (const dep of row.dependsOn) {
      if (dep === row.key || !keys.has(dep)) throw new InputError('导入依赖不存在或引用自身');
      if (!['create', 'update'].includes(keys.get(dep)!.disposition))
        throw new InputError('导入依赖指向未解决的记录');
    }
    const checkRef = (
      ref: z.infer<typeof recordRef> | undefined,
      entity: 'customers' | 'products',
    ) => {
      if (ref?.kind !== 'planned') return;
      const target = keys.get(ref.key);
      if (
        !target ||
        target.entity !== entity ||
        target.disposition !== 'create' ||
        !row.dependsOn.includes(ref.key)
      )
        throw new InputError('跨模块临时关联必须指向已声明依赖的同类新增记录');
    };
    if (row.entity === 'orders' && row.proposed) {
      checkRef(row.proposed.customerId, 'customers');
      for (const line of row.proposed.lines || []) checkRef(line.productId, 'products');
    }
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new InputError('导入建议存在循环依赖');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const d of keys.get(key)!.dependsOn) visit(d);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys.keys()) visit(key);
  return proposal;
}
