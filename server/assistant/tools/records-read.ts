// 只管：查记录——records.search（含 describe 给参数结构）、records.get，以及 records.summarize 的入口；
// 筛选在 records-filter.ts，汇总数字和用料张数的计算在 records-summary.ts。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { isSuperMode } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { superModeDenied } from '../../core/index.js';
import { customerSchema, productSchema, orderSchema, displayOrderStatuses, today } from '../../../shared/core/index.js';
import { purchaseSchema, stockItemSchema, supplierSchema } from '../../../shared/business/index.js';
import { arrivalSchema, taskSchema, productionSchema, deliverySchema } from '../../../shared/business/index.js';
import { dataManagementTemplate } from '../../../shared/business/index.js';
import { monthsBefore } from '../../../shared/core/index.js';
import { productIdsOfCustomer, stockIdsOfParty } from '../../operations/index.js';
import { OFFSET_MAX, uuid, positive, requireActor, type ToolContext, type ToolReader } from './context.js';
import { assistantModules, flowMap, moduleSchema, recordRow, recordLink, type Module, type ModuleRecord } from './modules.js';
import { filterSchema, matchingRows, type RecordFilters } from './records-filter.js';
import { allocateSheets, summarizeRecords } from './records-summary.js';

/** 一页最多几条、默认几条；一页结果最多多少字（超出的从后面去掉）。跳过的条数和别的列表工具同一个上限 */
const PAGE_MAX = 20;
const PAGE_DEFAULT = 10;
const RESULT_MAX_CHARS = 40_000;

export const recordReadTools = [
  {
    name: 'records.summarize',
    description:
      '汇总合计：问合计、一共多少、按客户分别多少时用，不要用 records.search 翻页自己加。汇总全部匹配的记录，filters 和 records.search 一样：订单给总只数、金额和按客户分，采购含待完成和逾期，库存按单位换算面积，流水按库存品汇总。',
    arguments: { module: assistantModules, filters: {} },
    risk: 'read',
    schema: z.strictObject({
      module: moduleSchema,
      allocation: z
        .strictObject({
          orderId: positive,
          unitsPerSheet: positive,
          mode: z.enum(['per-product', 'shared']),
        })
        .optional(),
      filters: filterSchema.optional(),
    }),
  },
  {
    name: 'records.search',
    description:
      '查业务记录列表，limit 最多 20，用 offset 翻页；问合计用 records.summarize。默认只查没归档的；用户说要看已归档的才传 lifecycle=archived，lifecycle=all 要超级管理员模式，用户没提归档就不要带。库存余额不受日期筛选。产品的 customerId 是该客户订过的产品，原材料的 supplierId 是从该供应商采购过的。',
    arguments: { module: assistantModules, filters: {}, limit: 20, offset: 0 },
    risk: 'read',
    schema: z.strictObject({
      module: moduleSchema,
      describe: z.boolean().optional(),
      filters: filterSchema.optional(),
      limit: z.number().int().min(1).max(PAGE_MAX).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  {
    name: 'records.get',
    description: '读一条记录：要看一条记录的全部内容和关联时用，按 id 读；名称相似的先 records.search 再问用户。',
    arguments: {
      module: assistantModules,
      id: '业务记录为正整数，流水为UUID字符串',
      lifecycle: 'active/archived/all可省略，all需超级模式',
    },
    risk: 'read',
    schema: z.strictObject({
      module: moduleSchema,
      id: z.union([positive, uuid]),
      lifecycle: z.enum(['active', 'archived', 'all']).optional(),
    }),
  },
];

/**
 * 读全部记录（含已归档）要超级管理员模式。和删除、撤销退货同一个分法（server/core/permissions.ts 的 superModeDenied）：
 * 进不了这个模式的账号直接说没有权限；超级管理员账号没进模式的，提示去“系统维护”进入。
 */
const allRecordsDenied = (actor: Actor) => superModeDenied(actor, '读取全部记录（含已归档）');

/** describe 给的人工表单参数结构（流水没有） */
const inputSchemas: Partial<Record<Module, z.ZodType>> = {
  customers: customerSchema,
  products: productSchema,
  orders: orderSchema,
  suppliers: supplierSchema,
  purchases: purchaseSchema,
  raw_inventory: stockItemSchema,
  finished_inventory: stockItemSchema,
  arrivals: arrivalSchema,
  production_tasks: taskSchema,
  production_records: productionSchema,
  deliveries: deliverySchema,
};
/** describe 给的关联档案怎么填（没写的模块是空的） */
const dependencies: Partial<Record<Module, Record<string, string>>> = {
  production_records: {
    finishedStockId:
      '可以不传：保存时按产品对应成品库存（一个产品只有一个，没有就新建、已归档的自动恢复）；传了必须是这个产品的那一个',
    materials:
      '实际原料库存ID、领料与退料数量；先查询raw_inventory余额并按用户明确分配规则计算，不能猜数量',
    taskId: '已下达且产品一致的production_tasks',
  },
  arrivals: {
    supplierId: 'suppliers',
    lines: 'purchases中的真实明细关联与raw_inventory/新纸板库存品',
  },
  purchases: {
    customerOrderId: '用户没说关联哪张客户订单就不填，当备货，不追问',
    'lines.priceBasis': '用户说“X元每平方米”是 area，“X元每张”是 quantity；单价原样写，面积和金额由服务算，不再问计价方式',
    'lines.stockItemId': '原料还没有库存品就留空，到货入库时由服务建，不用问',
    'lines.height': '纸板只有长和宽，高度传 null，不拿厚度或别的数字凑',
  },
  deliveries: { lines: '同一客户真实orders明细与对应finished_inventory' },
};

/** records.search 带 describe:true：给这个模块和人工表单相同的参数结构、数据管理的模板和关联档案怎么填 */
function describeModule(raw: unknown) {
  const v = z
    .strictObject({
      module: moduleSchema,
      describe: z.literal(true),
      filters: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    })
    .parse(raw);
  const schema = inputSchemas[v.module];
  return {
    module: v.module,
    inputSchema: schema ? z.toJSONSchema(schema) : null,
    template:
      v.module === 'movements'
        ? null
        : dataManagementTemplate(flowMap[v.module] || (v.module.includes('inventory') ? 'stock_items' : v.module), today()),
    dependencies: dependencies[v.module] ?? {},
    message: '这是与人工表单相同的真实参数结构。关联档案与版本从查询结果获取，不向用户索要内部编号。',
  };
}

/** 筛选条件先核对：最近几个月换成日期范围，开始不能晚于结束，订单状态写错了直接说清楚 */
function checkedFilters(module: Module, f: RecordFilters) {
  if (f.months) {
    f.start = monthsBefore(today(), f.months);
    f.end = today();
  }
  if (f.start && f.end && f.start > f.end) throw new AppError('开始日期不能晚于结束日期。');
  // 订单状态写错了直接说清楚，不悄悄查出 0 条；“已完成”是已发货的说法，筛选时单独处理
  if (module === 'orders' && f.status && f.status !== '已完成' && !(displayOrderStatuses as readonly string[]).includes(f.status))
    throw new AppError(
      '订单状态没有“' + f.status + '”。可用的状态：' + displayOrderStatuses.join('、') + '（“已完成”等同已发货）；按发货进度筛选请用 shippingProgress。',
    );
  return f;
}

/** records.search、records.summarize：describe 给参数结构、allocation 算张数（records-summary.ts），其余按筛选条件查记录再分页或汇总。 */
function searchRecords(ctx: ToolContext, raw: unknown, who: Actor | null | undefined, name: string) {
  const actor = requireActor(who);
  const asked = z.looseObject({}).safeParse(raw);
  if (name === 'records.search' && asked.success && asked.data.describe === true) return describeModule(raw);
  if (name === 'records.summarize' && asked.success && asked.data.allocation) return allocateSheets(ctx, raw);
  const v = z
    .strictObject({
      module: moduleSchema,
      filters: filterSchema.default({}),
      limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
      offset: z.number().int().min(0).max(OFFSET_MAX).default(0),
    })
    .parse(raw);
  const f = checkedFilters(v.module, v.filters);
  const includeArchived = f.archived || (!!f.lifecycle && f.lifecycle !== 'active');
  if (includeArchived && f.lifecycle !== 'archived' && !isSuperMode(actor)) throw allRecordsDenied(actor);
  // 产品、库存品本身不挂客户或供应商：按订单、采购单关联出来，和页面“筛选”同一套
  const partyIds =
    v.module === 'products'
      ? f.customerId
        ? productIdsOfCustomer(ctx.store, f.customerId)
        : null
      : v.module.includes('inventory')
        ? stockIdsOfParty(ctx.store, f)
        : null;
  const matched = matchingRows(ctx, actor, includeArchived, { module: v.module, f, partyIds });
  if (name === 'records.summarize') return summarizeRecords(ctx, v, f, matched);
  const rows: readonly ModuleRecord[] = matched.rows;
  const results = rows.slice(v.offset, v.offset + v.limit).map((r) => ({ record: r, url: recordLink(v.module, r) }));
  while (JSON.stringify(results).length > RESULT_MAX_CHARS) results.pop();
  return {
    module: v.module,
    filters: f,
    total: rows.length,
    offset: v.offset,
    results,
    hasMore: v.offset + results.length < rows.length,
  };
}

function getRecord(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  const actor = requireActor(who);
  const v = z
      .strictObject({
        module: moduleSchema,
        id: z.union([positive, uuid]),
        lifecycle: z.enum(['active', 'archived', 'all']).optional(),
      })
      .parse(raw),
    all = v.lifecycle === 'all' || (!v.lifecycle && isSuperMode(actor));
  if (all && !isSuperMode(actor)) throw allRecordsDenied(actor);
  const found: ModuleRecord | undefined = recordRow(ctx, v.module, actor, all || v.lifecycle === 'archived', v.id),
    r = found && (v.lifecycle !== 'archived' || ('archived' in found && found.archived)) ? found : undefined;
  if (!r) throw new AppError('记录不存在或已归档。', 404);
  return { record: r, url: recordLink(v.module, r) };
}

export const recordReaders: Record<string, ToolReader> = {
  'records.search': searchRecords,
  'records.summarize': searchRecords,
  'records.get': getRecord,
};
