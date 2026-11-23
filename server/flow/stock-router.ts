import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError, includeArchivedFor, notFound, pageRows, requirePermission, route } from '../core/index.js';
import { pagingSchema } from '../../shared/core/index.js';
import type { Actor, RequestAuth, Store } from '../core/index.js';
import {
  archivedQuerySchema,
  inventoryMetrics,
  matchesOperationalRecord,
  matchesPurchase,
  movementFilterSchema,
  operationsListQuerySchema,
  orderBatchDraftSchema,
  purchaseFilterSchema,
  purchaseMetrics,
  recordStatusActions,
  summarizeMovements,
  type MovementFilters,
  type StockFlowApi,
} from '../../shared/business/index.js';
import { OrderBatchService, stockIdsOfParty } from '../operations/index.js';
import { registerArrival } from './arrival/register-arrival.js';
import { FlowService } from './rules/service.js';

/*
 * 采购单、库存品和流水、订货单的接口（挂在 /api 下，接口表 shared/business/flow/stock-flow-api.ts）：回答带单据的内容，归单据流转。
 * 只取参数、认人、调服务；查询参数和正文进服务前先按 zod 校验。写接口的页面凭证由装配层统一查过，订货单的几个读接口在这里也查。
 */

/** 地址里的流水编号（uuid）最多多长 */
const MOVEMENT_ID_MAX_LENGTH = 150;
/** 路径参数里的采购单、库存品、订货单、产品编号 */
const recordId = (raw: string) => z.coerce.number().int().positive().parse(raw);
/** 地址上的查询参数（express 给的总是对象）：withMetrics 只认 '1'（定回答的形状，写在接口表的键里），别的项各按自己的规则校验 */
const withMetrics = (query: unknown) => z.record(z.string(), z.unknown()).parse(query).withMetrics === '1';
const created = { status: 201 };

type Routes = {
  on: ReturnType<typeof route<StockFlowApi>>;
  store: Store;
  flow: FlowService;
  /** 认人：没有账号体系时拒绝；每次都查页面凭证（订货单的读接口也要，写接口装配层已经查过一次） */
  actor: (req: Request) => Actor | null;
  /** 列表带不带已归档的：全站同一个判断（server/core/http/permissions.ts） */
  include: (req: Request, archived: unknown) => boolean;
};

/**
 * 库存品列表：archived=1 只看已归档；withMetrics=1 时带统计（原材料、成品分开）。关键字和库存页同一套（matchesOperationalRecord）。
 * 库存品上没有的状态、采购历史按“没有”比：带了 status 筛不出来，带 history=with 一条也没有。
 */
function stockList({ store, flow, include }: Routes, query: unknown, req: Request) {
  const q = operationsListQuerySchema.parse(query),
    metrics = withMetrics(query);
  const scoped = flow.views.items(include(req, q.archived)).filter((r) => (q.archived !== '1' || r.archived) && (!q.kind || r.kind === q.kind));
  // 库存品按供应商、客户筛：原材料看从这个供应商采购过的，成品看这个客户订过的产品
  const linked = stockIdsOfParty(store, q);
  const rows = scoped.filter(
    (r) =>
      matchesOperationalRecord(r, q.q) &&
      (!linked || linked.has(r.id)) &&
      !q.status &&
      (q.zero !== '1' || r.balanceUnits === 0) &&
      (!q.history || q.history === 'without'),
  );
  if (!metrics) return rows;
  return { rows, totalRecords: scoped.length, metrics: { raw: inventoryMetrics(rows, 'raw'), finished: inventoryMetrics(rows, 'finished') } };
}

/** 采购单列表：archived=1 只看已归档；withMetrics=1 时分页并带统计 */
function purchaseList({ flow, include }: Routes, query: unknown, req: Request) {
  const filter = purchaseFilterSchema.parse(query),
    { archived } = archivedQuerySchema.parse(query);
  const scoped = flow.views.purchases(include(req, archived)).filter((r) => archived !== '1' || r.archived),
    rows = scoped.filter((r) => matchesPurchase(r, filter));
  if (!withMetrics(query)) return rows;
  return {
    ...pageRows(rows, query),
    totalRecords: scoped.length,
    metrics: purchaseMetrics(rows),
    // 分页后当前页不含全部供应商，筛选下拉要用完整范围。
    suppliers: [...new Map(scoped.map((r) => [r.supplierId, { id: r.supplierId, name: r.supplierName }])).values()],
  };
}

/** 采购单 */
function purchaseRoutes(routes: Routes) {
  const { on, flow, actor, include } = routes;
  on('GET /purchases', ({ query, req }) => purchaseList(routes, query, req));
  on('POST /purchases', ({ body, req }) => flow.stock.savePurchase(body, actor(req)), created);
  // 整张保存不改状态；改成待到货、退回待订货、取消（要原因）、恢复各是一个动作（changePurchaseStatus）
  on('PUT /purchases/:id', ({ param, body, req }) => flow.stock.savePurchase(body, actor(req), recordId(param('id')), { keepStatus: true }));
  for (const action of recordStatusActions)
    on(`POST /purchases/:id/${action}`, ({ param, body, req }) => flow.stock.changePurchaseStatus(recordId(param('id')), action, body, actor(req)));
  on('GET /purchases/:id', ({ param, query, req }) =>
    flow.views.purchases(include(req, archivedQuerySchema.parse(query).archived), recordId(param('id'))).at(0) ?? notFound('采购单不存在'),
  );
}

/** 库存品：列表、保存、手工出入库、按产品查成品库存、打开一个 */
function itemRoutes(routes: Routes) {
  const { on, flow, actor } = routes;
  on('GET /warehouse/items', ({ query, req }) => stockList(routes, query, req));
  on('POST /warehouse/items', ({ body, req }) => flow.stock.saveItem(body, actor(req)), created);
  on('PUT /warehouse/items/:id', ({ param, body, req }) => flow.stock.saveItem(body, actor(req), recordId(param('id'))));
  on('POST /warehouse/items/:id/move', ({ param, body, req }) => flow.stock.move(recordId(param('id')), body, actor(req)));
  // 这个产品的成品库存（一个产品只有一个，归档的也算），没有是 null。新建成品库存的窗口选了产品就查，先说清楚已经有了
  on('GET /warehouse/product-stock/:id', ({ param }) => flow.ops.productStock(recordId(param('id'))));
  // 打开一个库存品（归档的也能看）：#warehouse?record= 用，撞上已有库存品时“打开它”就到这里。
  // 带上 used（有出入库记录或被单据、采购明细引用）：编辑窗里用过的成品把产品显示成只读
  on('GET /warehouse/items/:id', ({ param }) => {
    const row = flow.views.items(true, recordId(param('id'))).at(0) ?? notFound('库存品不存在');
    return { ...row, used: !!flow.views.usage(row.id) };
  });
}

/** 订货批次：发给供应商的一份订货单（一张或几张采购单），到货按批次登记 */
function batchRoutes({ on, store, flow, actor }: Routes) {
  const batches = new OrderBatchService(store);
  on('POST /order-batches/draft', ({ body, req }) => batches.draft(orderBatchDraftSchema.parse(body).purchaseIds, actor(req)));
  on('GET /order-batches', ({ req }) => {
    actor(req);
    return flow.views.openBatches();
  });
  on('GET /order-batches/by-purchase/:id', ({ param, req }) => {
    actor(req);
    return flow.views.batchOfPurchase(recordId(param('id')));
  });
  on('POST /order-batches/for-purchase/:id', ({ param, req }) => flow.views.batch(batches.ensureFor(recordId(param('id')), actor(req)).id));
  on('GET /order-batches/:id', ({ param, req }) => {
    actor(req);
    return flow.views.batch(recordId(param('id')));
  });
  on('PUT /order-batches/:id/schedule', ({ param, body, req }) => flow.views.batch(batches.saveSchedule(recordId(param('id')), body, actor(req)).id));
}

/** 流水列表的分页：只有页码和页大小，没有排序（流水只按业务日期倒序） */
const movementPaging = pagingSchema.omit({ sort: true });

/** 带统计的流水：给了页码只组装这一页（统计只取库存品和数量变化），没给就是全部 */
function movementListing(flow: FlowService, q: MovementFilters, query: unknown) {
  const paging = movementPaging.parse(query);
  if (!paging.page) {
    const rows = flow.views.movements(q);
    return { totals: rows, listing: { rows, filteredRecords: rows.length } };
  }
  const result = flow.views.movementPage(q, paging.page, paging.pageSize);
  return {
    totals: result.totals,
    listing: { rows: result.rows, filteredRecords: result.totals.length, page: result.page, pageSize: paging.pageSize },
  };
}

/**
 * 库存流水列表：withMetrics=1 时带统计，带页码就分页。流水只按业务日期倒序，不收排序参数。
 */
function movementList(flow: FlowService, query: unknown) {
  const q = movementFilterSchema.parse(query);
  if (!withMetrics(query)) return flow.views.movements(q);
  const { totals, listing } = movementListing(flow, q, query);
  // 关键词还要带上“有匹配流水”（不限日期）的库存品；没有日期条件时就是上面这批流水的库存品。
  const related = !q.q
    ? new Set<number>()
    : !q.start && !q.end
      ? new Set(totals.map((r) => r.item_id))
      : flow.ops.movementItemIds({ ...q, start: undefined, end: undefined });
  const items = flow.views
    .items(true)
    .filter(
      (i) =>
        (!q.kind || i.kind === q.kind) &&
        (!q.itemId || i.id === q.itemId) &&
        (!q.q || matchesOperationalRecord(i, q.q) || related.has(i.id)),
    );
  return { ...listing, totalRecords: flow.ops.movementCount(), metrics: summarizeMovements(totals, items) };
}

export function stockFlowRouter(store: Store, auth?: RequestAuth) {
  const router = Router();
  const routes: Routes = {
    on: route<StockFlowApi>(router),
    store,
    flow: new FlowService(store),
    actor: (req) => {
      if (!auth) throw new AppError('请登录并刷新页面凭证。', 403);
      auth.requireCsrf(req);
      return auth.actor(req);
    },
    include: (req, archived) => includeArchivedFor(auth?.actor(req), archived),
  };
  // 登记到货（地址挂在订货单下面，唯一入口 registerArrival）；页面凭证由装配层对所有写接口统一检查
  // 登记的是到货单：校验没过时报错按到货单的栏目叫法说（实到数量、供应商送货单号，server/http-errors.ts）
  router.all('/order-batches/:id/receive', (_req, res, next) => {
    res.locals.fieldRecord = 'arrival';
    next();
  });
  routes.on('POST /order-batches/:id/receive', ({ param, body, req }) => {
    if (!auth) throw new AppError('此业务需要登录身份验证。', 403);
    return registerArrival(store, { batchId: recordId(param('id')) }, body, requirePermission(auth.actor(req), 'business:edit'));
  });
  purchaseRoutes(routes);
  itemRoutes(routes);
  batchRoutes(routes);
  routes.on('GET /warehouse/movements', ({ query }) => movementList(routes.flow, query));
  routes.on('GET /warehouse/movements/:id/revisions', ({ param }) =>
    routes.flow.ops.movementRevisions(z.string().min(1).max(MOVEMENT_ID_MAX_LENGTH).parse(param('id'))),
  );
  return router;
}
