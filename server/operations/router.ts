import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError, includeArchivedFor, route } from '../core/index.js';
import type { Actor, AuthManager, Store } from '../core/index.js';
import { matchesOperationalRecord, operationsListQuerySchema, type OperationsApi } from '../../shared/business/index.js';
import { OperationsService } from './service.js';

/*
 * 采购库存的接口（挂在 /api 下，接口表 shared/business/operations-api.ts）：供应商。
 * 采购单、库存品和流水、订货单的地址带单据的内容，在单据流转（server/flow/stock-router.ts）。
 * 只取参数、认人、调服务；查询参数和正文进服务前先按 zod 校验。写接口的页面凭证由装配层统一查过。
 */

/** 路径参数里的供应商编号 */
const recordId = (raw: string) => z.coerce.number().int().positive().parse(raw);
/** 地址上的查询参数（express 给的总是对象）：withMetrics 只认 '1'（定回答的形状，写在接口表的键里），别的项各按自己的规则校验 */
const withMetrics = (query: unknown) => z.record(z.string(), z.unknown()).parse(query).withMetrics === '1';

/**
 * 供应商列表：archived=1 只看已归档；withMetrics=1 时回 { rows, totalRecords, metrics: null }，否则回数组（下拉用）。
 * 关键字两种形状都和供应商页同一套（matchesOperationalRecord）。
 * 和库存品同一套筛选参数，供应商上没有的那几项（种类、所属供应商、状态、数量）按“没有”比：带了就筛不出来。
 */
function supplierList(service: OperationsService, include: (archived: unknown) => boolean, query: unknown) {
  const q = operationsListQuerySchema.parse(query),
    metrics = withMetrics(query);
  const scoped = service.suppliers(include(q.archived)).filter((r) => (q.archived !== '1' || r.archived) && !q.kind);
  const rows = scoped.filter(
    (r) =>
      matchesOperationalRecord(r, q.q) &&
      !q.supplierId &&
      !q.status &&
      q.zero !== '1' &&
      (!q.history || (q.history === 'with') === r.purchaseHistory.length > 0),
  );
  return metrics ? { rows, totalRecords: scoped.length, metrics: null } : rows;
}

export function operationsRouter(store: Store, auth?: AuthManager) {
  const router = Router(),
    on = route<OperationsApi>(router),
    service = new OperationsService(store);
  /** 认人：没有账号体系时拒绝；每次都查页面凭证（写接口装配层已经查过一次） */
  const actor = (req: Request): Actor | null => {
    if (!auth) throw new AppError('请登录并刷新页面凭证。', 403);
    auth.requireCsrf(req);
    return auth.actor(req);
  };
  on('GET /suppliers', ({ query, req }) => supplierList(service, (archived) => includeArchivedFor(auth?.actor(req), archived), query));
  on('POST /suppliers', ({ body, req }) => service.saveSupplier(body, actor(req)), { status: 201 });
  on('PUT /suppliers/:id', ({ param, body, req }) => service.saveSupplier(body, actor(req), recordId(param('id'))));
  return router;
}
