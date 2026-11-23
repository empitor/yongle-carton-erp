import { orderedCustomersByProduct, productHasOrders, sales } from '../sales/index.js';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { includeArchivedFor, isSuperMode, notFound, requirePermission, route, type RequestAuth, type Store } from '../core/index.js';
import { customerList, listFields, orderList, productList } from './record-lists.js';
import { ORDER_NOT_FOUND, manualWrite } from './service.js';
import { assertOrderStatusKept, changeOrderStatus } from './order-status.js';
import { trackedOrder } from './tracked-orders.js';
import { recordStatusActions, type RecordsApi } from '../../shared/business/index.js';

/*
 * 客户、产品、订单的接口（挂在 /api 下，接口表 shared/business/records-api.ts）：列表、单条、新建、修改，订单的状态动作。
 * 只取参数、判断权限、调服务；页面凭证由装配层对写接口统一检查。六类档案的批量归档、恢复在删除归档（server/lifecycle/lifecycle-router.ts）。
 */
export function recordsRouter(store: Store, auth?: RequestAuth) {
  const router = Router();
  const on = route<RecordsApi>(router);
  const actorOf = (req: Request) => auth?.actor(req);
  const elevated = (req: Request) => isSuperMode(actorOf(req));
  /** 列表的查询参数和带不带已归档的：全站同一个判断（server/core/http/permissions.ts） */
  const listQuery = (req: Request, query: unknown) => {
    const fields = listFields(query);
    return { fields, includeArchived: includeArchivedFor(actorOf(req), fields.archived) };
  };
  const recordId = (raw: string) => z.coerce.number().int().positive().parse(raw);
  /** 手工保存：开了登录就要业务编辑权限 */
  const editor = (req: Request) => (auth ? requirePermission(auth.actor(req), 'business:edit') : null);
  const created = { status: 201 };

  on('GET /customers', ({ query, req }) => {
    const { fields, includeArchived } = listQuery(req, query);
    return customerList(store, fields, includeArchived);
  });
  on('GET /products', ({ query, req }) => {
    const { fields, includeArchived } = listQuery(req, query);
    return productList(store, fields, includeArchived);
  });
  on('GET /customers/:id', ({ param, req }) => sales(store).customer(recordId(param('id')), elevated(req)) ?? notFound('客户不存在'));
  on('GET /products/:id', ({ param, req }) => {
    const id = recordId(param('id'));
    const product = sales(store).product(id, elevated(req)) ?? notFound('产品不存在');
    const ordered = productHasOrders(store, id);
    const orderedCustomers = product.customerId == null ? orderedCustomersByProduct(store, [id]).get(id) : undefined;
    return { ...product, ordered, ...(orderedCustomers?.length ? { orderedCustomers } : {}) };
  });
  on('POST /customers', ({ body, req }) => manualWrite(store, { entity: 'customers', action: 'create', input: body }, editor(req)), created);
  on('POST /products', ({ body, req }) => manualWrite(store, { entity: 'products', action: 'create', input: body }, editor(req)), created);
  on('PUT /customers/:id', ({ param, body, req }) =>
    manualWrite(store, { entity: 'customers', action: 'update', id: param('id'), input: body }, editor(req)),
  );
  on('PUT /products/:id', ({ param, body, req }) =>
    manualWrite(store, { entity: 'products', action: 'update', id: param('id'), input: body }, editor(req)),
  );

  on('GET /orders', ({ query, req }) => {
    const { fields, includeArchived } = listQuery(req, query);
    return orderList(store, fields, includeArchived);
  });
  on('GET /orders/:id', ({ param, req }) => trackedOrder(store, recordId(param('id')), elevated(req)) ?? notFound(ORDER_NOT_FOUND));
  on('POST /orders', ({ body, req }) => manualWrite(store, { entity: 'orders', action: 'create', input: body }, editor(req)), created);
  on('PUT /orders/:id', ({ param, body, req }) => {
    assertOrderStatusKept(store, recordId(param('id')), body, elevated(req));
    return manualWrite(store, { entity: 'orders', action: 'update', id: param('id'), input: body }, editor(req));
  });
  // 确认、退回待确认、取消（要原因）、恢复为待确认：各一个地址，和单据的 /flow/:id/cancel 一样的写法（order-status.ts）
  for (const action of recordStatusActions)
    on(`POST /orders/:id/${action}`, ({ param, body, req }) =>
      changeOrderStatus(store, recordId(param('id')), action, body, actorOf(req)),
    );
  return router;
}
