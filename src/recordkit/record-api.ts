import type {
  DeletionApi,
  OperationsApi,
  RecordEntity,
  RecordStatusAction,
  RecordsApi,
  WorkbenchApi,
} from '../../shared/business/index';
import { call } from '../ui/index';
import type { LifecycleAction } from './lifecycle';

/**
 * 按一条记录办的请求：档案读一条、关联单据、关联记录与修改历史、改订单状态、档案批量归档恢复、删除前查询和删除。
 * 单据（/flow/:id）走 flow/flow-api.ts 的 readFlow；档案清单走 catalog-api.ts。
 */
const records = call<RecordsApi>(),
  operations = call<OperationsApi>(),
  workbench = call<WorkbenchApi>(),
  deletions = call<DeletionApi>();

/** 能按一条读的档案（供应商服务端没有单条读的地址）：读回来的样子 */
type RecordById = {
  customers: RecordsApi['GET /customers/:id']['response'];
  products: RecordsApi['GET /products/:id']['response'];
  orders: RecordsApi['GET /orders/:id']['response'];
  purchases: OperationsApi['GET /purchases/:id']['response'];
  stock_items: OperationsApi['GET /warehouse/items/:id']['response'];
};
const recordReaders: { [E in keyof RecordById]: (id: number | string) => Promise<RecordById[E]> } = {
  customers: (id) => records('GET /customers/:id', { params: { id } }),
  products: (id) => records('GET /products/:id', { params: { id } }),
  orders: (id) => records('GET /orders/:id', { params: { id } }),
  purchases: (id) => operations('GET /purchases/:id', { params: { id } }),
  // 库存品的地址在仓库下面
  stock_items: (id) => operations('GET /warehouse/items/:id', { params: { id } }),
};

/** 一条档案；能看这条的账号都能读，含已归档的 */
export const readRecord = <E extends keyof RecordById>(entity: E, id: number | string) => recordReaders[entity](id);

type Related = WorkbenchApi['GET /business/:entity/:id/related']['response'];
/** 订单、采购单各自的关联单据：订单带唛头和生产送货，采购单带到货记录 */
type RelatedOf = { orders: Extract<Related, { marks: unknown }>; purchases: Extract<Related, { arrivals: unknown }> };
const relatedOf: { [E in keyof RelatedOf]: (related: Related) => RelatedOf[E] | null } = {
  orders: (related) => ('marks' in related ? related : null),
  purchases: (related) => ('arrivals' in related ? related : null),
};

/** 订单、采购单的关联单据（生产任务、送货、采购、到货、库存）：算“下一步”和详情里的关联列表用 */
export async function readRelated<E extends keyof RelatedOf>(entity: E, id: number) {
  const related = relatedOf[entity](await workbench('GET /business/:entity/:id/related', { params: { entity, id } }));
  if (!related) throw new Error('读到的关联单据和这张单对不上，请刷新页面再试。');
  return related;
}

/** 一条记录的关联记录和修改历史（和助手查修改历史同一个接口） */
export const readRecordContext = (module: string, id: number) =>
  workbench('GET /business/:module/:id/context', { params: { module, id } });

/**
 * 改订单状态（确认订单、退回待确认、取消、恢复为待确认）：各是一个动作，POST /api/orders/:id/<动作>，
 * 带读到时的版本号；取消要原因（记进修改历史）。整张保存不改状态。今日页的“确认订单”和订单详情的按钮都走这里。
 */
export function changeOrderStatus(row: { id: number; version: number }, action: RecordStatusAction, reason?: string) {
  return records(`POST /orders/:id/${action}`, {
    params: { id: row.id },
    body: { expectedVersion: row.version, requestId: crypto.randomUUID(), ...(reason ? { reason } : {}) },
  });
}

/**
 * 档案（客户、产品、订单、供应商、采购单、库存品）批量归档、恢复：POST /api/<档案>/batch，每条单独办，逐条回成没成。
 * 单据的批量归档恢复走 flow/flow-api.ts 的 archiveFlows；两边办完怎么说是同一套（lifecycle.ts 的 lifecycleOutcome）。
 */
export const requestLifecycle = (
  path: `/${RecordEntity}/batch`,
  action: LifecycleAction,
  rows: { id: number; version: number }[],
) =>
  records(`POST ${path}`, {
    body: { action, acknowledged: true, items: rows.map((r) => ({ id: r.id, version: r.version })) },
  }).then((r) => r.results);

type DeletionPreviewBody = DeletionApi['POST /deletions/preview']['body'];
/** 能删的记录种类（和数据管理同一套模块名） */
export type DeletionModule = DeletionPreviewBody['module'];

/** 删除前查会一起处理的记录：哪类记录、哪几条（带版本号）、库存怎么处理 */
export const previewDeletion = (selection: DeletionPreviewBody) => deletions('POST /deletions/preview', { body: selection });

/** 按查到的清单（deletionDigest）删除；不在本机删已确认的单据要带本人密码 */
export const executeDeletion = (body: DeletionApi['POST /deletions/execute']['body']) =>
  deletions('POST /deletions/execute', { body });
