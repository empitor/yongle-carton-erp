import { pageTools } from '../../shared/assistant-page.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission, isSuperMode, changeLifecycle, audit } from '../business/management.js';
import { createBusinessService } from '../business/service.js';
import { reviewedAssistantGrant } from '../business/assistant-approval.js';
import { OperationsService } from '../operations/service.js';
import { FlowService } from '../flow/service.js';
import { PermanentDeletionService } from '../business/permanent-deletion.js';
import { ImportError } from '../import/errors.js';
import { DeveloperService } from '../developer-service.js';
import {
  requireDeveloper,
  isLocalAdministrator,
  requireLocalAdministrator,
} from '../developer-capability.js';
import { recordContext } from '../business/record-context.js';
import { DatabaseMaintenanceService, deletionSelection } from '../business/database-maintenance.js';
import { developerCommandSchema } from '../../shared/developer.js';
import {
  customerSchema,
  productSchema,
  orderSchema,
  dateSchema,
  exactPriceSchema,
  today,
} from '../../shared/domain.js';
import {
  purchaseSchema,
  stockItemSchema,
  supplierSchema,
  movementSchema,
  recordEntities,
  receiptSchema,
} from '../../shared/operations.js';
import { flowInput, flowKinds, flowStatusLabel } from '../../shared/physical-flow.js';
import { monthsBefore } from '../../shared/date-ranges.js';
import {
  pendingOrder,
  pendingPurchase,
  orderMetrics,
  purchaseMetrics,
  productMetrics,
  inventoryMetrics,
  summarizeMovements,
} from '../../shared/business-metrics.js';
import { buildDashboard } from '../business/dashboard.js';
import { sumMoney } from '../../shared/operations.js';
import { orderInView } from '../../shared/date-ranges.js';
import { legacyCents } from '../../shared/precision.js';
import { orderWorkflowTools } from './order-workflow.js';
import { navigationTargets, erpPages, pageLink } from '../../shared/assistant-navigation.js';
export const assistantModules = [
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'raw_inventory',
  'finished_inventory',
  'arrivals',
  'production_tasks',
  'production_records',
  'deliveries',
  'movements',
] as const;
type Module = (typeof assistantModules)[number];
export const moduleNames: Record<Module, string> = {
  customers: '客户',
  products: '产品',
  orders: '客户订单',
  suppliers: '供应商',
  purchases: '采购订货',
  raw_inventory: '原材料库存',
  finished_inventory: '成品库存',
  arrivals: '采购到货',
  production_tasks: '生产任务',
  production_records: '生产登记',
  deliveries: '客户送货',
  movements: '出入库流水',
};
const flowMap: Record<string, (typeof flowKinds)[number]> = {
  arrivals: 'arrival',
  production_tasks: 'task',
  production_records: 'production',
  deliveries: 'delivery',
};
const moduleSchema = z.enum(assistantModules),
  positive = z.number().int().positive();
export const toolCatalog = [
  ...pageTools,
  {
    name: 'management.delete_preview',
    description:
      '查询数据库物理删除影响：必需级联删除、引用解除和库存处理。与归档完全独立；已确认、非零库存和历史引用不禁止删除。将返回digest用于同范围提交，涉及独立记录时先展示清单。',
    arguments: {
      module: '与management.execute相同',
      items: [{ id: 1, version: 1 }],
      inventoryPolicy: 'preserve默认保留其他库存数量并解除来源；recalculate移除来源流水重算',
    },
    risk: 'read',
  },
  {
    name: 'records.delete',
    description:
      '删除就是数据库物理删除，绝不是归档、取消、冲销或移入回收站。按真实唯一ID删除业务记录，自动查询明确关联并在事务内级联/解除引用/重算；必须根据服务器回执报告。归档使用records.propose_lifecycle，恢复仅针对归档。',
    arguments: {
      module: assistantModules.filter((m) => m !== 'movements'),
      id: 1,
      inventoryPolicy: 'preserve/recalculate',
    },
    risk: 'review',
  },
  {
    name: 'management.workspaces',
    description:
      '管理AI原件/任务/草稿工作区。list查询正常及归档；open读取/打开可编辑归档且保留归档状态（兼容旧回收数据），fork复制独立任务，delete实际删除原件/任务/草稿，archive归档，restore只恢复归档；remove/purge仅旧接口兼容。正式原件归档和导入回执保留。每次修改提供新requestId和准确工作区ID，删除必须用delete，不得用archive/remove代替。不会自动重新识别或收费。',
    arguments: {
      action: 'list/open/fork/delete/archive/restore',
      requestId: '修改时必填UUID',
      items: [{ id: '工作区UUID', revision: 1 }],
    },
    risk: 'workflow',
  },
  {
    name: 'management.execute',
    description:
      '已登录本机最高管理员的统一业务管理工具，与页面调用同一服务。按明确ID和版本直接创建、编辑、更正、归档、恢复、永久删除、确认、冲销、库存盘点及物理删除。编辑直接更新当前单据并同步关联和库存，整个操作事务内完成；先management.context查询影响，范围不清楚时询问，普通编辑不重复确认。删除是物理删除，与archive独立；先management.delete_preview查询关联影响，将digest作为deletionDigest提交。不能编辑库存流水或猜测关联。',
    arguments: {
      module:
        'customers/products/orders/suppliers/purchases/stock_items/arrival/task/production/delivery',
      action: 'create/update/archive/restore/delete/confirm/reverse/cancel/move',
      items: [{ id: 1, version: 1 }],
      patch: {},
      requestId: 'UUID',
      reason: '用户操作原因',
      deletionDigest: 'management.delete_preview返回的digest，绑定当前删除范围',
    },
    risk: 'review',
  },
  {
    name: 'management.context',
    description:
      '查询指定真实记录的关联单据、删除/更正处理路径和最近修改审计。先用records.search/get定位唯一ID。',
    arguments: { module: '与management.execute相同的模块', id: 1 },
    risk: 'read',
  },
  {
    name: 'task.plan',
    description:
      '为复杂流程保存可恢复任务与按顺序的业务步骤（不执行步骤）。每项label/tool/可选args；可先保存待查询后补参数的步骤。保留已完成步骤，不重建同一个任务。',
    arguments: {
      goal: '任务目标',
      steps: [{ label: '业务步骤说明', tool: '已注册工具名', args: {} }],
    },
    risk: 'read',
  },
  {
    name: 'task.get',
    description:
      '读取当前持久任务、已完成回执的数据库核验、剩余步骤及错误。继续任务先读取，复用已成功的业务记录ID，不重放写入。',
    arguments: {},
    risk: 'read',
  },
  {
    name: 'task.activate',
    description:
      '切换到当前会话已保留的另一项任务，不重新创建单据。先从task.get的otherTasks取真实taskId；本轮只调用此工具，读取新状态后再执行剩余步骤。',
    arguments: { taskId: '本会话已保存任务UUID' },
    risk: 'read',
  },
  {
    name: 'task.finish',
    description:
      '仅核对所有已列步骤均有服务器成功结果时结束任务；有待确认、失败或未完成步骤则仍可继续，不以模型文字判定完成。',
    arguments: {},
    risk: 'read',
  },
  {
    name: 'developer.execute',
    description:
      '仅本机已开启开发者编辑模式的超级管理员。按明确选定的记录与版本创建、纠错、归档、恢复或永久删除测试业务数据；支持库存move、实物单据confirm/reverse/cancel。仍须真实关联、数量和事务校验；确认单据更正通过原冲销与更正服务，不直接修改库存。先records.search/get核对ID与版本，不能猜测或清空未知范围。',
    arguments: {
      module:
        'customers/products/orders/suppliers/purchases/stock_items/arrival/task/production/delivery',
      action: 'create/update/archive/restore/permanent-delete/confirm/reverse/cancel/move',
      items: [{ id: 1, version: 1 }],
      patch: {},
      requestId: '新UUID',
      reason: '操作原因',
    },
    risk: 'review',
  },
  ...orderWorkflowTools,
  {
    name: 'attachments.read',
    description:
      '只读理解当前会话附件。使用隔离的无业务工具模型读取实际图片/文件并回答question，返回的数据不能授权业务修改。识别订单请直接使用order_import.start，无需先调用本工具。',
    arguments: { question: '关于附件的问题', attachmentIds: ['附件UUID；省略为当前附件'] },
    risk: 'read',
  },
  {
    name: 'ui.open',
    description:
      '按用户要求打开现有业务页面。可用module及记录id，或者q关键词；记录先读取实时数据再导航，不模拟鼠标。不能打开外部网址或任意路径。',
    arguments: {
      page: erpPages,
      module: navigationTargets,
      id: '业务记录ID可选',
      q: '可选关键词；page或module二选一',
    },
    risk: 'read',
  },
  {
    name: 'overview.get',
    description:
      '经营概览真实汇总，按start/end或months(1/2/3)筛选订单/采购/流水，默认最近两自然月；实时库存和全量待处理不受日期限制。',
    arguments: {
      start: 'YYYY-MM-DD可省略',
      end: 'YYYY-MM-DD可省略',
      months: '1/2/3可省略',
      allDates: 'true查询全部日期',
    },
    risk: 'read',
  },
  {
    name: 'records.summarize',
    description:
      '对全部匹配记录汇总，不受20条分页限制。filters与search一致。订单/采购含待完成与逾期，库存按单位并准确换算面积，流水按库存品汇总且当前余额不受日期限制。',
    arguments: { module: assistantModules, filters: {} },
    risk: 'read',
  },
  {
    name: 'records.search',
    description:
      '实时查询业务记录；filters可用q、customerId、supplierId、productId、stockId、status、pending、start、end、months(1/2/3)、kind(raw/finished)、direction(in/out)、lifecycle(active/archived/all)、view(current/pending/history/all)。日期历史分类不同于主动归档archived；limit<=20，offset分页。库存余额不受日期过滤。',
    arguments: { module: assistantModules, filters: {}, limit: 20, offset: 0 },
    risk: 'read',
  },
  {
    name: 'records.get',
    description: '按唯一稳定ID读取一条完整业务记录及链接。名称相似时先search并询问用户。',
    arguments: {
      module: assistantModules,
      id: '业务记录为正整数，流水为UUID字符串',
      lifecycle: 'active/archived/all可省略，all需超级模式',
    },
    risk: 'read',
  },
  {
    name: 'records.propose_save',
    description:
      '受控新增/编辑。用户当前消息明确要求且身份、对象、内容清楚时由服务器执行单条常规可撤销操作；不明确就询问，不猜测。id为空表示新建；patch仅含修改字段。采购/生产/送货仅保存草稿，不自动确认库存。显式要求预览时只生成方案。',
    arguments: {
      module: assistantModules.filter((m) => m !== 'movements'),
      id: '正整数或省略',
      patch: '字段对象',
    },
    risk: 'review',
  },
  {
    name: 'records.propose_batch_lifecycle',
    description:
      '批量停用/归档/恢复，最多100条，本机最高管理员按明确范围直接执行，其他账号须预览确认。保留历史引用，事务内全部成功或全部回滚。流水不能归档。',
    arguments: {
      module: assistantModules.filter((m) => m !== 'movements'),
      ids: ['正整数'],
      action: ['archive', 'restore'],
    },
    risk: 'high',
  },
  {
    name: 'records.propose_lifecycle',
    description:
      '单条归档/恢复，本机最高管理员可直接执行，归档必须满足对应业务完成条件，绝不是删除；保留历史引用。',
    arguments: { module: assistantModules, id: '正整数', action: ['archive', 'restore'] },
    risk: 'review',
  },
  {
    name: 'flow.propose_cancel',
    description:
      '取消草稿或尚未完工任务的剩余计划，保留已产生的库存和生产历史。必须填写原因，先审核。',
    arguments: { id: '单据ID', reason: '取消原因' },
    risk: 'review',
  },
  {
    name: 'inventory.propose_movement',
    description:
      '出入库/盘点审核方案；必须指定库存品、action=in/out/adjust、quantity十进制字符串、date、notes原因。本机最高管理员可按明确指令直接执行，其他账号沿用原审核；禁止负库存或跨单位换算。',
    arguments: {
      id: '库存品ID',
      action: ['in', 'out', 'adjust'],
      quantity: '数量字符串',
      date: 'YYYY-MM-DD',
      notes: '用途/原因',
    },
    risk: 'high',
  },
  {
    name: 'purchase.propose_receipt',
    description:
      '旧采购明细分批到货审核方案；生成库存预览，不能超未到货数量。reference送货单号必填，items为lineId/quantity数组。',
    arguments: {
      id: '采购ID',
      reference: '送货单号',
      date: 'YYYY-MM-DD',
      items: [{ lineId: '采购明细ID', quantity: '字符串' }],
      notes: '备注',
    },
    risk: 'high',
  },
  {
    name: 'flow.propose_confirmation',
    description:
      '确认已存在的到货/生产/送货草稿或生产任务。任务下达不改变库存，可按明确指令执行；本机最高管理员可直接确认实际收货/生产完工/发货，其他账号沿用审核。',
    arguments: { id: '单据ID' },
    risk: 'high',
  },
  {
    name: 'flow.propose_reversal',
    description: '已确认业务单据冲销方案，必须有原因，保留原件和反向流水；仅已验证超级管理员。',
    arguments: { id: '单据ID', reason: '原因' },
    risk: 'high',
  },
  {
    name: 'records.propose_permanent_delete',
    description:
      '单条永久删除核对方案，仅现有支持的客户/产品/订单/供应商/采购/库存档案；不自动包含关联订单。本机最高管理员明确请求永久删除时直接执行，保留范围预览、版本和关联校验；存在真实阻碍返回替代操作。',
    arguments: { module: recordEntities, id: '正整数' },
    risk: 'high',
  },
];
export type ToolPlan = {
  tool: string;
  args: any;
  label: string;
  highRisk: boolean;
  before: any;
  after: any;
  warnings: string[];
  engine?: any;
};
function outstandingQuantities(rows: any[]) {
  const groups = new Map<string, bigint>();
  for (const row of rows.filter((r) => r.status !== '已取消'))
    for (const line of row.lines) {
      const remaining = BigInt(Math.max(0, line.quantityUnits - line.receivedUnits));
      groups.set(line.unit, (groups.get(line.unit) || 0n) + remaining);
    }
  return [...groups].map(([unit, value]) => {
    const digits = value.toString().padStart(4, '0');
    return {
      unit,
      quantity: (digits.slice(0, -3) + '.' + digits.slice(-3)).replace(/\.?0+$/, '') || '0',
    };
  });
}
export class AssistantTools {
  readonly ops: OperationsService;
  readonly flow: FlowService;
  constructor(readonly store: Store) {
    this.ops = new OperationsService(store);
    this.flow = new FlowService(store);
  }
  private actor(actor: Actor | null | undefined) {
    if (!actor) throw new ImportError('请先登录管理账号。', 401);
    return actor;
  }
  rows(module: Module, actor: Actor, archived = false): any[] {
    this.actor(actor);
    if (module === 'movements') {
      const items = new Map(this.ops.repo.items(true).map((i) => [i.id, i]));
      const orders = new Map(this.store.orders(true).map((o) => [o.id, o]));
      const purchases = new Map<number, any>(
        this.ops.repo.purchases(true).flatMap((p) => p.lines.map((l: any) => [l.id, p] as const)),
      );
      const documents = new Map(this.flow.list(undefined, true).map((d) => [d.id, d]));
      return this.ops.repo.movements().map((r) => ({
        ...r,
        productId: items.get(Number(r.item_id))?.productId,
        customerId:
          orders.get(Number(r.customer_order_id))?.customerId ||
          (String(r.source_kind).startsWith('flow_')
            ? documents.get(Number(r.source_id))?.customerId
            : undefined),
        supplierId:
          purchases.get(Number(r.purchase_line_id))?.supplierId ||
          (String(r.source_kind).startsWith('flow_')
            ? documents.get(Number(r.source_id))?.supplierId
            : undefined),
      }));
    }
    if (flowMap[module]) {
      const products = new Map(this.store.products(true).map((p) => [p.id, p.name])),
        customers = new Map(this.store.customers(true).map((c) => [c.id, c.name])),
        suppliers = new Map(this.store.suppliers(true).map((s) => [s.id, s.name]));
      const orders = new Map(this.store.orders(true).map((o) => [o.id, o]));
      const tasks = new Map(this.flow.list('task', true).map((t) => [t.id, t]));
      return this.flow.list(flowMap[module], archived).map((r) => ({
        ...r,
        customerIds: [
          ...new Set(
            [
              r.customerId,
              ...(r.orderIds || tasks.get(r.taskId)?.orderIds || []).map(
                (id: number) => orders.get(id)?.customerId,
              ),
            ].filter(Boolean),
          ),
        ],
        productName: products.get(r.productId),
        customerName: customers.get(r.customerId),
        supplierName: suppliers.get(r.supplierId),
      }));
    }
    return module === 'raw_inventory' || module === 'finished_inventory'
      ? this.ops.repo
          .items(archived)
          .filter((i) => i.kind === (module === 'raw_inventory' ? 'raw' : 'finished'))
      : this.store[module as 'customers' | 'products' | 'orders' | 'suppliers' | 'purchases'](
          archived,
        ).map((r) => ({ ...r, archived: this.store.archived(module, r.id) }));
  }
  link(module: Module, row: any) {
    if (module === 'deliveries')
      return (
        '#warehouse?kind=finished&deliveries=1&doc=' + row.id + (row.archived ? '&archived=1' : '')
      );
    return flowMap[module]
      ? '#' +
          (module === 'arrivals' ? 'arrivals' : 'production') +
          '?doc=' +
          row.id +
          (row.archived ? '&archived=1' : '')
      : module === 'movements'
        ? '#warehouse?flow=1'
        : module.includes('inventory')
          ? '#warehouse?kind=' +
            (module === 'raw_inventory' ? 'raw' : 'finished') +
            '&q=' +
            encodeURIComponent(row.name) +
            (row.archived ? '&archived=1' : '')
          : '#' +
            module +
            '?q=' +
            encodeURIComponent(row.number || row.name) +
            (row.archived ? '&archived=1' : '');
  }
  read(name: string, raw: unknown, who: Actor | null | undefined): any {
    if (name === 'management.delete_preview')
      return new DatabaseMaintenanceService(this.store).preview(raw, who);
    if (name === 'management.context') {
      const actor = requireLocalAdministrator(who),
        v = z.strictObject({ module: z.string(), id: positive }).parse(raw);
      return recordContext(this.store, v.module, v.id, actor);
    }
    const actor = this.actor(who);
    if (name === 'ui.open') {
      const v = z
        .strictObject({
          module: z.enum(navigationTargets as [string, ...string[]]).optional(),
          page: z.enum(Object.keys(erpPages) as [string, ...string[]]).optional(),
          id: positive.optional(),
          q: z.string().max(100).optional(),
        })
        .parse(raw);
      const target = v.page || v.module;
      if (!target || (v.page && v.module && v.page !== v.module))
        throw new ImportError('请指定一个有效页面目标。');
      if (v.id) {
        const module = moduleSchema.parse(target);
        return this.read('records.get', { module, id: v.id }, actor);
      }
      return { url: pageLink(target, v.q), page: target };
    }
    if (name === 'overview.get') {
      const f = z
        .strictObject({
          start: dateSchema.optional(),
          end: dateSchema.optional(),
          months: z.number().int().min(1).max(3).optional(),
          allDates: z.boolean().default(false),
        })
        .parse(raw);
      if (f.allDates && (f.start || f.end || f.months))
        throw new ImportError('全部日期不能同时指定日期范围。');
      if (!f.allDates && (f.months || (!f.start && !f.end))) {
        f.start = monthsBefore(today(), f.months || 2);
        f.end = today();
      }
      if (f.start && f.end && f.start > f.end) throw new ImportError('开始日期不能晚于结束日期。');
      const rows = this.store
        .orders()
        .filter((r) => (!f.start || r.orderDate >= f.start) && (!f.end || r.orderDate <= f.end));
      return { ...buildDashboard(this.store, rows, f), url: '#dashboard' };
    }
    if (name === 'records.get') {
      const v = z
          .strictObject({
            module: moduleSchema,
            id: z.union([positive, z.string().uuid()]),
            lifecycle: z.enum(['active', 'archived', 'all']).optional(),
          })
          .parse(raw),
        all = v.lifecycle === 'all' || (!v.lifecycle && isSuperMode(actor));
      if (all && !isSuperMode(actor))
        throw new ImportError('读取全部记录须验证超级管理员模式。', 403);
      const r = this.rows(v.module, actor, all || v.lifecycle === 'archived').find(
        (r) => String(r.id) === String(v.id) && (v.lifecycle !== 'archived' || !!r.archived),
      );
      if (!r) throw new ImportError('记录不存在或已归档。', 404);
      return { record: r, url: this.link(v.module, r) };
    }
    if (!['records.search', 'records.summarize'].includes(name))
      throw new ImportError('未注册的只读工具。', 403);
    const v = z
        .strictObject({
          module: moduleSchema,
          filters: z
            .strictObject({
              q: z.string().max(200).optional(),
              customerId: positive.optional(),
              supplierId: positive.optional(),
              productId: positive.optional(),
              stockId: positive.optional(),
              status: z.string().max(40).optional(),
              pending: z.boolean().optional(),
              start: dateSchema.optional(),
              end: dateSchema.optional(),
              months: z.number().int().min(1).max(3).optional(),
              archived: z.boolean().optional(),
              lifecycle: z.enum(['active', 'archived', 'all']).optional(),
              view: z.enum(['current', 'pending', 'history', 'all']).optional(),
              kind: z.enum(['raw', 'finished']).optional(),
              direction: z.enum(['in', 'out']).optional(),
            })
            .default({}),
          limit: z.number().int().min(1).max(20).default(10),
          offset: z.number().int().min(0).max(100000).default(0),
        })
        .parse(raw),
      f = v.filters;
    if (f.months) {
      f.start = monthsBefore(today(), f.months);
      f.end = today();
    }
    if (f.start && f.end && f.start > f.end) throw new ImportError('开始日期不能晚于结束日期。');
    const includeArchived = f.archived || (!!f.lifecycle && f.lifecycle !== 'active');
    if (includeArchived && f.lifecycle !== 'archived' && !isSuperMode(actor))
      throw new ImportError('读取全部记录须验证超级管理员模式。', 403);
    const rows = this.rows(v.module, actor, includeArchived).filter((r) => {
      const q = (f.q || '').toLowerCase(),
        date = r.orderDate || r.date || String(r.createdAt || '').slice(0, 10),
        inventory = v.module.includes('inventory');
      return (
        (f.lifecycle !== 'archived' || !!r.archived) &&
        (f.lifecycle !== 'active' || !r.archived) &&
        (!f.kind || r.kind === f.kind) &&
        (!f.direction ||
          (f.direction === 'in' ? Number(r.delta_units) > 0 : Number(r.delta_units) < 0)) &&
        (!q ||
          [
            r.name,
            r.productName,
            r.itemName,
            r.itemSpecification,
            r.purchaseNumber,
            r.customerOrderNumber,
            r.flowNumber,
            r.actor_name,
            r.number,
            r.customerName,
            r.supplierName,
            r.notes,
            r.specification,
            r.material,
            r.flute,
            ...(r.lines || []).map((l: any) =>
              [
                l.productName,
                l.name,
                l.specification,
                l.notes,
                l.item?.name,
                l.item?.specification,
                l.item?.material,
                l.item?.flute,
              ].join(' '),
            ),
          ]
            .join(' ')
            .toLowerCase()
            .includes(q)) &&
        (!f.customerId || r.customerId === f.customerId || r.customerIds?.includes(f.customerId)) &&
        (!f.supplierId || r.supplierId === f.supplierId) &&
        (!f.productId ||
          r.productId === f.productId ||
          r.lines?.some((l: any) => l.productId === f.productId)) &&
        (!f.stockId ||
          (inventory
            ? r.id === f.stockId
            : v.module === 'movements'
              ? Number(r.item_id) === f.stockId
              : r.finishedStockId === f.stockId ||
                r.lines?.some((l: any) => l.stockId === f.stockId) ||
                r.materials?.some((m: any) => m.stockId === f.stockId))) &&
        (!f.status ||
          r.status === f.status ||
          (flowMap[v.module] && flowStatusLabel(r) === f.status) ||
          (v.module === 'orders' &&
            ((f.status === '已完成' && r.status === '已发货') ||
              (f.status === '部分发货' &&
                r.status === '待发货' &&
                r.lines.some((l: any) => l.shippedQuantity > 0))))) &&
        (!f.pending ||
          (v.module === 'orders'
            ? pendingOrder(r)
            : v.module === 'purchases'
              ? pendingPurchase(r)
              : r.status === 'draft' ||
                (r.status === 'confirmed' &&
                  r.kind === 'task' &&
                  Number(r.completed || 0) < Number(r.quantity)))) &&
        (inventory ||
          (v.module === 'orders'
            ? orderInView(r, {
                view: f.view === 'all' ? undefined : f.view,
                start: f.start,
                end: f.end,
                retainPending: !!f.months && f.view === 'current',
              })
            : (!f.start || date >= f.start) && (!f.end || date <= f.end)))
      );
    });
    if (name === 'records.summarize') {
      let metrics: any;
      if (v.module === 'orders')
        metrics = {
          ...orderMetrics(rows),
          amount: sumMoney(
            rows
              .filter((r) => !['草稿', '已取消'].includes(r.status))
              .map((r) => r.totalAmountExact),
          ),
          amountDefinition: '有效订单精确金额，不含草稿、取消',
        };
      else if (v.module === 'purchases')
        metrics = {
          ...purchaseMetrics(rows),
          amount: sumMoney(
            rows
              .filter((r) => r.status !== '已取消' && r.totalAmount !== null)
              .map((r) => r.totalAmount),
          ),
          unpriced: rows.filter((r) => r.status !== '已取消' && r.totalAmount === null).length,
          outstanding: outstandingQuantities(rows),
        };
      else if (v.module === 'products') metrics = productMetrics(rows);
      else if (v.module.includes('inventory'))
        metrics = inventoryMetrics(rows, v.module === 'raw_inventory' ? 'raw' : 'finished');
      else if (v.module === 'movements') {
        const ids = new Set(rows.map((r) => Number(r.item_id)));
        const all = summarizeMovements(
          rows,
          this.ops.repo
            .items(true)
            .filter(
              (i) =>
                (!f.kind || i.kind === f.kind) &&
                (!f.stockId || i.id === f.stockId) &&
                (!f.productId || i.productId === f.productId) &&
                (!f.q ||
                  [i.name, i.specification, i.material, i.flute]
                    .join(' ')
                    .toLowerCase()
                    .includes(f.q.toLowerCase()) ||
                  ids.has(i.id)) &&
                ((!f.customerId && !f.supplierId) || ids.has(i.id)),
            ),
        );
        metrics = {
          totalGroups: all.length,
          groups: all.slice(v.offset, v.offset + v.limit),
          hasMore: v.offset + v.limit < all.length,
          balanceDefinition: '入出数量受筛选影响；currentQuantity为实时余额，不受日期筛选影响',
        };
      } else
        metrics = {
          total: rows.length,
          byStatus: Object.fromEntries(
            [...new Set(rows.map((r) => r.status).filter(Boolean))].map((s) => [
              s,
              rows.filter((r) => r.status === s).length,
            ]),
          ),
        };
      return { module: v.module, filters: f, total: rows.length, metrics };
    }
    let results = rows
      .slice(v.offset, v.offset + v.limit)
      .map((r) => ({ record: r, url: this.link(v.module, r) }));
    while (JSON.stringify(results).length > 40000) results.pop();
    return {
      module: v.module,
      filters: f,
      total: rows.length,
      offset: v.offset,
      results,
      hasMore: v.offset + results.length < rows.length,
    };
  }
  private simulate(job: () => any) {
    this.store.db.exec('SAVEPOINT assistant_simulation');
    try {
      return job();
    } finally {
      this.store.db.exec('ROLLBACK TO assistant_simulation; RELEASE assistant_simulation');
    }
  }
  private executeSave(
    module: Module,
    id: number | undefined,
    input: any,
    actor: Actor,
    binding: string,
  ) {
    if (['customers', 'products', 'orders'].includes(module))
      return createBusinessService(this.store).execute(
        {
          entity: module as any,
          action: id ? 'update' : 'create',
          ...(id ? { id } : {}),
          input,
        } as any,
        {
          source: 'reviewed-assistant',
          operatorId: actor.id,
          approval: reviewedAssistantGrant(actor.id),
          superAdminMode: isSuperMode(actor),
          developerActor: actor,
        },
      );
    if (module === 'suppliers') return this.ops.saveSupplier(input, actor, id);
    if (module === 'purchases') return this.ops.savePurchase(input, actor, id);
    if (module.includes('inventory'))
      return this.ops.saveItem(
        { ...input, kind: module === 'raw_inventory' ? 'raw' : 'finished' },
        actor,
        id,
      );
    if (flowMap[module]) {
      if (id && isLocalAdministrator(actor))
        return new DeveloperService(this.store).execute(
          {
            requestId: randomUUID(),
            module: flowMap[module],
            action: 'update',
            items: [{ id, version: input.version }],
            patch: flowInput(flowMap[module], input),
            reason: '用户通过助手更正单据',
          },
          actor,
          binding,
          'developer-assistant',
        ).results[0];
      return this.flow.save(flowMap[module], input, actor, id);
    }
    throw new ImportError('此模块不允许直接修改。', 403);
  }
  prepare(tool: string, raw: unknown, who: Actor | null | undefined, binding: string): ToolPlan {
    const actor = requirePermission(who, 'business:edit');
    if (
      (tool === 'records.delete' || tool === 'records.propose_permanent_delete') &&
      isLocalAdministrator(actor)
    ) {
      const v = z
        .strictObject({
          module: moduleSchema,
          id: positive,
          inventoryPolicy: z.enum(['preserve', 'recalculate']).optional(),
        })
        .parse(raw);
      const before = this.rows(v.module, actor, true).find((r) => r.id === v.id);
      if (!before) throw new ImportError('记录不存在。', 404);
      const module =
        flowMap[v.module] || (v.module.includes('inventory') ? 'stock_items' : v.module);
      const selection = {
        module,
        items: [{ id: before.id, version: before.version }],
        inventoryPolicy: v.inventoryPolicy,
      };
      const after = new DatabaseMaintenanceService(this.store).preview(selection, actor);
      return {
        tool,
        args: { ...selection, deletionDigest: after.digest, requestId: randomUUID() },
        label: '数据库删除' + moduleNames[v.module],
        highRisk: false,
        before,
        after,
        warnings: [after.inventoryEffect],
      };
    }
    if (tool === 'developer.execute' || tool === 'management.execute') {
      if (tool === 'management.execute') requireLocalAdministrator(actor);
      requireDeveloper(actor);
      const input = developerCommandSchema.parse(raw),
        service = new DeveloperService(this.store);
      const before = service
        .list(input.module, actor)
        .records.filter((x) => input.items.some((i) => i.id === x.record.id))
        .map((x) => x.record);
      const after = this.simulate(() =>
        service.execute(input, actor, binding, 'developer-assistant'),
      );
      return {
        tool,
        args: { input },
        label:
          (tool === 'management.execute' ? '业务数据管理：' : '开发者测试数据操作：') +
          input.action,
        highRisk: false,
        before,
        after,
        warnings: [],
      };
    }
    if (tool === 'records.propose_save') {
      const v = z
        .strictObject({
          module: moduleSchema,
          id: positive.optional(),
          patch: z.record(z.string(), z.unknown()),
        })
        .parse(raw);
      if (v.module === 'movements') throw new ImportError('库存流水不可直接编辑。');
      const before = v.id
        ? this.rows(v.module, actor, isSuperMode(actor)).find((r) => r.id === v.id)
        : null;
      if (v.id && !before) throw new ImportError('记录不存在或已归档。', 404);
      const schemas: any = {
          customers: customerSchema,
          products: productSchema,
          orders: orderSchema,
          suppliers: supplierSchema,
          purchases: purchaseSchema,
          raw_inventory: stockItemSchema,
          finished_inventory: stockItemSchema,
        },
        candidate = { ...before, ...v.patch, ...(before ? { version: before.version } : {}) };
      // 到货状态由明细派生；编辑备注不能把“部分到货”误送入只接受基础状态的表单契约。
      if (v.module === 'purchases' && before && !Object.hasOwn(v.patch, 'status'))
        candidate.status = before.baseStatus;
      if (v.module === 'orders' && Array.isArray(candidate.lines))
        candidate.lines = candidate.lines.map((line: any) =>
          line.unitPriceCents == null && typeof line.unitPriceExact === 'string'
            ? {
                ...line,
                unitPriceCents: legacyCents(exactPriceSchema.parse(line.unitPriceExact.trim())),
              }
            : line,
        );
      if (v.module.includes('inventory'))
        candidate.kind = v.module === 'raw_inventory' ? 'raw' : 'finished';
      if (
        Object.keys(v.patch).some(
          (k) =>
            [
              'id',
              'version',
              'createdAt',
              'archived',
              'quantityUnits',
              'receivedUnits',
              'balanceUnits',
              'status',
            ].includes(k) && !(k === 'status' && ['orders', 'purchases'].includes(v.module)),
        )
      )
        throw new ImportError('模型不能直接修改系统派生字段。');
      const parsed = flowMap[v.module]
          ? flowInput(flowMap[v.module], candidate)
          : schemas[v.module].parse(candidate),
        input = { ...parsed, ...(before ? { version: before.version } : {}) },
        after = this.simulate(() => {
          const unknown = Object.keys(v.patch).filter((k) => !Object.hasOwn(parsed, k));
          if (unknown.length)
            throw new ImportError(
              '不支持的业务字段：' +
                unknown.join('、') +
                '。产品加工要求/备注使用requirements，不能写入不存在的字段。',
            );
          return this.executeSave(v.module, v.id, input, actor, binding);
        });
      return {
        tool,
        args: { module: v.module, id: v.id, input, fields: Object.keys(v.patch) },
        label: (v.id ? '修改' : '新建') + moduleNames[v.module],
        highRisk:
          !!before?.archived ||
          (v.module === 'orders' &&
            (!!before?.lines?.some((l: any) => l.shippedQuantity > 0) ||
              before?.status === '已发货' ||
              input.status === '已发货')),
        before,
        after,
        warnings: flowMap[v.module] ? ['仅保存草稿，不改变库存。'] : [],
      };
    }
    if (tool === 'records.propose_lifecycle') {
      const v = z
          .strictObject({
            module: moduleSchema,
            id: positive,
            action: z.enum(['archive', 'restore']),
          })
          .parse(raw),
        before = this.rows(v.module, actor, v.action === 'restore').find((r) => r.id === v.id);
      if (!before) throw new ImportError('记录不存在。', 404);
      const plan: ToolPlan = {
        tool,
        args: { ...v, version: before.version },
        label: (v.action === 'archive' ? '停用/归档' : '恢复') + moduleNames[v.module],
        highRisk: false,
        before,
        after: null,
        warnings: [],
      };
      plan.after = this.simulate(() => this.commit(plan, actor, binding));
      return plan;
    }
    if (tool === 'records.propose_batch_lifecycle') {
      if (!isSuperMode(actor)) throw new ImportError('批量操作需要有效超级管理员模式。', 403);
      const v = z
        .strictObject({
          module: moduleSchema,
          ids: z.array(positive).min(1).max(100),
          action: z.enum(['archive', 'restore']),
        })
        .parse(raw);
      if (new Set(v.ids).size !== v.ids.length || v.module === 'movements')
        throw new ImportError('记录重复或模块不支持批量归档。');
      const children = v.ids.map((id) =>
        this.prepare(
          'records.propose_lifecycle',
          { module: v.module, id, action: v.action },
          actor,
          binding,
        ),
      );
      return {
        tool,
        args: { module: v.module, children },
        label: `批量${v.action === 'restore' ? '恢复' : '归档'}${moduleNames[v.module]}（${children.length}条）`,
        highRisk: true,
        before: children.map((p) => p.before),
        after: children.map((p) => p.after),
        warnings: ['事务内全部成功或全部回滚，不删除历史引用。'],
      };
    }
    if (tool === 'flow.propose_cancel') {
      const v = z
          .strictObject({ id: positive, reason: z.string().trim().min(1).max(1000) })
          .parse(raw),
        before = this.flow.get(v.id),
        input = { version: before.version, reason: v.reason, acknowledged: true },
        after = this.simulate(() => this.flow.cancel(v.id, input, actor));
      return {
        tool,
        args: { id: v.id, input },
        label: '取消草稿/剩余生产任务',
        highRisk: false,
        before,
        after,
        warnings: ['已确认的库存和生产历史保留。'],
      };
    }
    if (tool === 'flow.propose_confirmation') {
      const { id } = z.strictObject({ id: positive }).parse(raw),
        before = this.flow.get(id);
      const highRisk = before.kind !== 'task';
      if (highRisk && !isSuperMode(actor))
        throw new ImportError('实物确认需要有效超级管理员模式。', 403);
      const engine = this.flow.preview(id, actor, binding);
      return {
        tool,
        args: { id, requestId: randomUUID() },
        label:
          '正式确认' +
          moduleNames[Object.keys(flowMap).find((k) => flowMap[k] === before.kind) as Module],
        highRisk,
        before,
        after: engine,
        warnings: engine.warnings,
        engine: { previewId: engine.previewId },
      };
    }
    if (!isSuperMode(actor))
      throw new ImportError(
        '此操作涉及库存或不可逆变更，请先在右上角验证密码进入超级管理员模式。',
        403,
      );
    if (tool === 'inventory.propose_movement') {
      const v = z.object({ id: positive }).parse(raw),
        before = this.ops.repo.items().find((r) => r.id === v.id);
      if (!before) throw new ImportError('库存品不存在。');
      const input = movementSchema.parse({
          ...Object.fromEntries(Object.entries(raw as any).filter(([k]) => k !== 'id')),
          expectedVersion: before.version,
          requestId: randomUUID(),
          acknowledged: true,
        }),
        after = this.simulate(() => this.ops.move(v.id, input, actor));
      return {
        tool,
        args: { id: v.id, input },
        label: '库存出入库 / 盘点调整',
        highRisk: true,
        before,
        after,
        warnings: ['会改变实际库存，并生成不可变流水；不自动换算单位。'],
      };
    }
    if (tool === 'purchase.propose_receipt') {
      const id = z.object({ id: positive }).parse(raw).id,
        before = this.ops.repo.purchases().find((r) => r.id === id);
      if (!before) throw new ImportError('采购单不存在。');
      const input = receiptSchema.parse({
          ...Object.fromEntries(Object.entries(raw as any).filter(([k]) => k !== 'id')),
          expectedVersion: before.version,
          requestId: randomUUID(),
          acknowledged: true,
        }),
        after = this.simulate(() => this.ops.receive(id, input, actor));
      return {
        tool,
        args: { id, input },
        label: '采购分批到货确认',
        highRisk: true,
        before,
        after,
        warnings: ['确认后按实际数量增加原材料库存。'],
      };
    }
    if (tool === 'flow.propose_reversal') {
      const v = z
          .strictObject({ id: positive, reason: z.string().trim().min(1).max(1000) })
          .parse(raw),
        before = this.flow.get(v.id),
        input = { version: before.version, reason: v.reason, acknowledged: true },
        after = this.simulate(() => this.flow.reverse(v.id, input, actor));
      return {
        tool,
        args: { id: v.id, input },
        label: '冲销业务单据与反向库存',
        highRisk: true,
        before,
        after,
        warnings: ['保留原单据、原因与反向流水。'],
      };
    }
    if (tool === 'records.propose_permanent_delete') {
      const v = z.strictObject({ module: z.enum(recordEntities), id: positive }).parse(raw),
        before = this.store[v.module](true).find((r) => r.id === v.id);
      if (!before) throw new ImportError('记录不存在。');
      const engine = new PermanentDeletionService(this.store).preview(
        { entity: v.module, items: [{ id: v.id, version: before.version }] },
        actor,
        binding,
      );
      if (engine.plan.blockers.length) throw new ImportError(engine.plan.blockers.join('；'), 409);
      return {
        tool,
        args: v,
        label: '永久删除' + v.module,
        highRisk: true,
        before,
        after: engine.plan,
        warnings: ['永久删除不可恢复，审计和正式原件归档保留。'],
        engine: { previewId: engine.id },
      };
    }
    throw new ImportError('工具未注册。', 403);
  }
  commit(plan: ToolPlan, who: Actor | null | undefined, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      a = plan.args;
    if (
      (plan.tool === 'records.delete' || plan.tool === 'records.propose_permanent_delete') &&
      isLocalAdministrator(actor)
    )
      return new DatabaseMaintenanceService(this.store).delete(a, actor, binding);
    if (plan.tool === 'management.execute') requireLocalAdministrator(actor);
    if (plan.tool === 'developer.execute' || plan.tool === 'management.execute')
      return new DeveloperService(this.store).execute(
        a.input,
        actor,
        binding,
        'developer-assistant',
      );
    if (plan.highRisk && !isSuperMode(actor))
      throw new ImportError('高风险操作需要有效超级管理员模式。', 403);
    if (plan.tool === 'records.propose_save')
      return this.executeSave(a.module, a.id, a.input, actor, binding);
    if (plan.tool === 'records.propose_batch_lifecycle') {
      this.store.db.exec('SAVEPOINT assistant_batch_lifecycle');
      try {
        const result = a.children.map((child: ToolPlan) => this.commit(child, actor, binding));
        this.store.db.exec('RELEASE assistant_batch_lifecycle');
        return result;
      } catch (error) {
        this.store.db.exec(
          'ROLLBACK TO assistant_batch_lifecycle; RELEASE assistant_batch_lifecycle',
        );
        throw error;
      }
    }
    if (plan.tool === 'records.propose_lifecycle') {
      if (flowMap[a.module] && isLocalAdministrator(actor))
        return new DeveloperService(this.store).execute(
          {
            requestId: randomUUID(),
            module: flowMap[a.module],
            action: a.action,
            items: [{ id: a.id, version: a.version }],
            reason: '用户通过助手管理单据',
          },
          actor,
          binding,
          'developer-assistant',
        );
      if (flowMap[a.module])
        return this.flow.archive(a.id, a.action === 'restore', actor, a.version);
      const entity = a.module.includes('inventory') ? 'stock_items' : a.module;
      if (!recordEntities.includes(entity)) throw new ImportError('不支持归档此模块。');
      const result = changeLifecycle(
        this.store,
        entity,
        { action: a.action, acknowledged: true, items: [{ id: a.id, version: a.version }] },
        actor,
      );
      if (result.results.some((r) => !r.success))
        throw new ImportError(result.results.map((r) => r.message).join('；'), 409);
      return result;
    }
    if (plan.tool === 'inventory.propose_movement') return this.ops.move(a.id, a.input, actor);
    if (plan.tool === 'flow.propose_cancel') return this.flow.cancel(a.id, a.input, actor);
    if (plan.tool === 'purchase.propose_receipt') return this.ops.receive(a.id, a.input, actor);
    if (plan.tool === 'flow.propose_confirmation')
      return this.flow.confirm(
        a.id,
        { previewId: plan.engine.previewId, requestId: a.requestId, acknowledged: true },
        actor,
        binding,
      );
    if (plan.tool === 'flow.propose_reversal') return this.flow.reverse(a.id, a.input, actor);
    if (plan.tool === 'records.propose_permanent_delete')
      return new PermanentDeletionService(this.store).execute(
        { previewId: plan.engine.previewId, acknowledged: true, confirmation: '永久删除' },
        actor,
        binding,
      );
    throw new ImportError('未注册的写入工具。', 403);
  }
  stamp(plan: ToolPlan, actor: Actor) {
    if (
      (plan.tool === 'records.delete' || plan.tool === 'records.propose_permanent_delete') &&
      isLocalAdministrator(actor)
    ) {
      const { module, items, inventoryPolicy } = plan.args;
      return new DatabaseMaintenanceService(this.store).preview(
        { module, items, inventoryPolicy },
        actor,
      ).digest;
    }
    if (plan.tool === 'developer.execute' || plan.tool === 'management.execute')
      return {
        developer: requireDeveloper(actor).id,
        records: new DeveloperService(this.store).list(plan.args.input.module, actor).records,
      };
    // 只绑定当前方案涉及的业务域版本；审计/聊天变化不会使预览误失效。
    const a = plan.args,
      module = a.module as Module | undefined;
    if (module)
      return {
        rows: this.rows(
          module,
          actor,
          plan.tool === 'records.propose_permanent_delete' ||
            a.action === 'restore' ||
            !!plan.before?.archived,
        ),
        customers: this.store.customers(true),
        products: this.store.products(true),
      };
    return {
      items: this.ops.repo.items(true),
      purchases: this.ops.repo.purchases(true),
      orders: this.store.orders(true),
      documents: this.flow.list(undefined, true),
    };
  }
}
