// 方案绑定的数据版本（stamp）：出卡片时记下相关记录的编号和版本号（库存品另记库存余额，归档了的标上），
// 确认时再取一遍比（previews.ts），对不上就是出卡片以后数据变了，卡片作废，并说出是哪几条（stale-card.ts 按单号或名称说）。
// 只按版本号这几列取，不读单据内容、不组装记录。各命令自己有绑定的（tools/ 下写入表里的 stamp）不走这里。
import { z } from 'zod';
import type { Store } from '../core/index.js';
import { many } from '../core/index.js';
import { type ToolPlan } from './plan-rules.js';
import { field } from './chat/result-fields.js';

const version = { id: z.number(), version: z.number(), archived: z.number() };
const namedVersion = z.object({ ...version, name: z.string() });
const numberedVersion = z.object({ ...version, number: z.string() });
const stockVersion = namedVersion.extend({ balance: z.number() });

/** 归档了没有（record_lifecycle 里记着）：1 是归档了 */
const archived = (entity: string) => `EXISTS(SELECT 1 FROM record_lifecycle a WHERE a.entity=${entity} AND a.record_id=t.id) AS archived`;
/** 客户、供应商、产品：按名称说 */
const parties = (store: Store, table: 'customers' | 'suppliers' | 'products') =>
  many(store.db, namedVersion, `SELECT t.id,t.version,t.name,${archived('?')} FROM ${table} t ORDER BY t.id`, table);
/** 订单、采购单：按单号说 */
const numbered = (store: Store, table: 'orders' | 'purchases') =>
  many(store.db, numberedVersion, `SELECT t.id,t.version,t.number,${archived('?')} FROM ${table} t ORDER BY t.id`, table);
/** 库存品：库存变了（流水的合计）也算变了；不给种类就是全部 */
const stockItems = (store: Store, kind?: 'raw' | 'finished') =>
  many(
    store.db,
    stockVersion,
    `SELECT t.id,t.version,t.name,${archived("'stock_items'")},COALESCE((SELECT SUM(m.delta_units) FROM stock_movements m WHERE m.item_id=t.id),0) AS balance FROM stock_items t` +
      (kind ? ' WHERE t.kind=?' : '') +
      ' ORDER BY t.id',
    ...(kind ? [kind] : []),
  );
/** 单据：按单号说；不给种类就是全部 */
const documents = (store: Store, kind?: 'arrival' | 'task' | 'production' | 'delivery') =>
  many(
    store.db,
    numberedVersion,
    `SELECT t.id,t.version,t.number,${archived("'flow_'||t.kind")} FROM flow_documents t` + (kind ? ' WHERE t.kind=?' : '') + ' ORDER BY t.id',
    ...(kind ? [kind] : []),
  );
/**
 * 待入库的完工单：登记时不动生产任务的版本号（核对入库时才动），但改任务计划数的卡片要按它核对——
 * 出卡片以后有人按这张任务登记了完工，再把计划数改少就不合理了，卡片要作废。
 */
const pendingCompletions = (store: Store) =>
  many(
    store.db,
    numberedVersion,
    `SELECT t.id,t.version,t.number,${archived("'flow_'||t.kind")} FROM flow_documents t WHERE t.kind='production' AND t.status='draft' ORDER BY t.id`,
  );

/** 方案参数里写了助手模块的：绑定这个模块的记录（生产任务另带待入库的完工单） */
const moduleVersions: Record<string, (store: Store) => unknown[]> = {
  customers: (store) => parties(store, 'customers'),
  suppliers: (store) => parties(store, 'suppliers'),
  products: (store) => parties(store, 'products'),
  orders: (store) => numbered(store, 'orders'),
  purchases: (store) => numbered(store, 'purchases'),
  raw_inventory: (store) => stockItems(store, 'raw'),
  finished_inventory: (store) => stockItems(store, 'finished'),
  arrivals: (store) => documents(store, 'arrival'),
  production_tasks: (store) => [...documents(store, 'task'), ...pendingCompletions(store)],
  production_records: (store) => documents(store, 'production'),
  deliveries: (store) => documents(store, 'delivery'),
};

/**
 * 只绑定当前方案涉及的业务域版本；审计、聊天变化不会使卡片误失效。
 * 参数里写了助手模块的绑定这个模块的记录和客户、产品；别的（按单据、库存品、订货单办事的）绑定库存品、采购单、订单和单据。
 */
export function planStamp(store: Store, plan: Pick<ToolPlan, 'args'>) {
  const module = field(plan.args, 'module');
  const rows = typeof module === 'string' && Object.hasOwn(moduleVersions, module) ? moduleVersions[module] : undefined;
  if (rows) return { rows: rows(store), customers: parties(store, 'customers'), products: parties(store, 'products') };
  return { items: stockItems(store), purchases: numbered(store, 'purchases'), orders: numbered(store, 'orders'), documents: documents(store) };
}
