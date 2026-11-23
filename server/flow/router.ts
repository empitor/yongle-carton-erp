import { flowKinds } from '../../shared/core/index.js';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { type Actor, type RequestAuth, type Store } from '../core/index.js';
import { AppError, includeArchivedFor, one, requirePermission, route, rows } from '../core/index.js';
import { arrivalRecordsQuerySchema, flowListQuerySchema, flowSaveRequestSchema, flowUndoActions, returnsQuerySchema, stockBatchesQuerySchema, type FlowApi } from '../../shared/business/index.js';
import { FlowService } from './rules/service.js';
import { WarehouseDaily } from './daily.js';
import { ManualProductionCompletion } from './production/production-completion.js';
import { PurchaseReturns } from './arrival/returns.js';
import { archiveFlowDocuments } from './documents/archive.js';
import { stockItemBatches } from './stock/stock-batches.js';
import { updateDocumentInfo } from './correction/document-info.js';
import { correctDocument, planCorrection } from './correction/correction.js';

/*
 * 单据流转的接口（挂在 /api/flow 下，接口表 shared/business/flow-api.ts）：只取参数、认人、调服务；查询参数和正文由服务（或这里）先用 zod 校验。
 * 页面凭证由装配层对写接口统一检查。看送货单原件回的是文件，不在接口表里，照旧用 express 注册。
 */

/** 认人：改数据的要 business:edit，只看的登录就行 */
type Who = { editor(req: Request, write?: boolean): Actor; viewer(req: Request): Actor };
type FlowRoutes = { on: ReturnType<typeof route<FlowApi>>; store: Store; service: FlowService; who: Who };

/** 送货单原件的格式对应的文件类型（别的按二进制下载） */
const SOURCE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** 路径参数里的单据、库存品、退货单编号 */
const recordId = (raw: string) => z.coerce.number().int().positive().parse(raw);

function requester(auth: RequestAuth | undefined): Who {
  return {
    editor(req, write = true) {
      if (!auth) throw new AppError('此业务需要登录身份验证。', 403);
      // 写接口的页面凭证装配层已经统一查过；读接口带 write=true 的（少数）在这里补查
      if (write && req.method === 'GET') auth.requireCsrf(req);
      return requirePermission(auth.actor(req), 'business:edit');
    },
    viewer(req) {
      const actor = auth?.actor(req);
      if (!actor) throw new AppError('请先登录管理账号。', 401);
      return actor;
    },
  };
}

/** 到货单关联的送货单原件（AI 识别时上传的），到货详情、采购到货记录、AI 导入里都能点开看 */
function sourceFileRoute(router: Router, store: Store, who: Who) {
  router.get('/sources/:sourceId/file', (req, res) => {
    who.editor(req, false);
    const s = one(
      store.db,
      rows.flow_sources.pick({ file_name: true, bytes: true, format: true }),
      'SELECT file_name,bytes,format FROM flow_sources WHERE id=?',
      z.uuid().parse(req.params.sourceId),
    );
    if (!s) throw new AppError('原件不存在。', 404);
    res.set('Content-Type', SOURCE_TYPES[s.format] || 'application/octet-stream');
    res.set('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(s.file_name));
    res.send(Buffer.from(s.bytes));
  });
}

/** 采购退货：挂在到货单下，扣库存、冲减采购已到货；金额以到票或红票为准。 */
function returnRoutes({ on, store, who }: FlowRoutes) {
  const returns = new PurchaseReturns(store);
  // 查看退货记录和可退数量与到货记录一样，登录即可；退货和冲销才要 business:edit。
  on('GET /flow/returns', ({ query, req }) => {
    who.viewer(req);
    return returns.list(returnsQuerySchema.parse(query).arrivalId);
  });
  on('GET /flow/returns/returnable/:id', ({ param, req }) => {
    who.viewer(req);
    return returns.returnable(recordId(param('id'))).lines;
  });
  on('POST /flow/returns', ({ body, req }) => returns.create(who.editor(req), body), { status: 201 });
  on('POST /flow/returns/:id/reverse', ({ param, body, req }) => returns.reverse(who.editor(req), param('id'), body));
}

/** 只看的：单据列表、成品批次、到货记录、仓库台账、单张单据（单张放最后，不盖住上面几个地址） */
function readRoutes({ on, store, service, who }: FlowRoutes) {
  on('GET /flow', ({ query, req }) => {
    const viewer = who.viewer(req),
      q = flowListQuerySchema.parse(query);
    // status=draft：只读还没核对的单据（安排送货时扣掉已排的数量用），不组装全部
    const ids = q.status === 'draft' ? service.draftIds(q.kind) : undefined;
    // 带不带已归档的：和档案列表同一个判断（server/core/permissions.ts 的 includeArchivedFor）
    return service.list(q.kind, includeArchivedFor(viewer, q.archived), undefined, ids).filter((d) => q.archived !== '1' || d.archived);
  });
  // 成品库存按每次完工分批（只读）：和库存流水一样，登录就能看。depleted=all 取全部已发完的批次，默认只给最近 20 个
  on('GET /flow/stock-batches/:id', ({ param, query, req }) => {
    who.viewer(req);
    return stockItemBatches(store, recordId(param('id')), { allDepleted: stockBatchesQuerySchema.parse(query).depleted === 'all' });
  });
  on('GET /flow/arrival-records', ({ query, req }) => {
    who.viewer(req);
    return service.arrivalRecords(arrivalRecordsQuerySchema.parse(query));
  });
  on('GET /flow/daily', ({ query, req }) => {
    who.viewer(req);
    return new WarehouseDaily(store).get(query);
  });
  on('GET /flow/:id', ({ param, req }) => {
    who.viewer(req);
    return service.get(recordId(param('id')));
  });
}

/** 登记完工、归档恢复、新建和修改：固定地址（登记完工、批量）排在 /:kind 前面 */
function saveRoutes({ on, store, service, who }: FlowRoutes) {
  on('POST /flow/production-completion/preview', ({ body, req }) => new ManualProductionCompletion(store).preview(body, who.editor(req)));
  on('POST /flow/production-completion/execute', ({ body, req }) => new ManualProductionCompletion(store).execute(body, who.editor(req)));
  // 归档、恢复（批量）：和档案同一份做法，逐条返回结果（archive.ts → server/core/archive.ts）
  on('POST /flow/batch', ({ body, req }) => archiveFlowDocuments(service, body, who.editor(req)));
  on(
    'POST /flow/:kind',
    ({ param, body, req }) => {
      const kind = z.enum(flowKinds).parse(param('kind'));
      // 登记完工只有一个入口：production-completion/preview、execute（挂不挂生产任务都在那里登记）；这里只留编辑待入库的完工单（PUT /:id）
      if (kind === 'production') throw new AppError('登记完工请用“登记完工”，挂不挂生产任务都在那里登记。', 409);
      const actor = who.editor(req);
      flowSaveRequestSchema.parse(body);
      return service.save(kind, body, actor);
    },
    { status: 201 },
  );
  on('PUT /flow/:id', ({ param, body, req }) => {
    const actor = who.editor(req);
    flowSaveRequestSchema.parse(body);
    const id = recordId(param('id'));
    return service.save(service.get(id).kind, body, actor, id);
  });
}

/** 办一张单据：更正、核对、排期、编辑说明、确认、送达、取消和撤销 */
function documentRoutes({ on, store, service, who }: FlowRoutes) {
  // 更正已生效的到货、送货、完工单（撤销原单、另出替代单）：改数量这类只有这一条路，按单据种类分派（server/flow/correction/correction.ts）；
  // 提交时正文由更正自己先校验，同一请求号重发返回上次的结果
  on('POST /flow/:id/correct', ({ param, body, req }) => correctDocument(store, recordId(param('id')), body, who.editor(req)));
  on('POST /flow/:id/correction-preview', ({ param, body, req }) => planCorrection(store, recordId(param('id')), body, who.editor(req)));
  on('POST /flow/:id/preview', ({ param, req }) => service.preview(recordId(param('id')), who.editor(req)));
  on('POST /flow/:id/schedule', ({ param, body, req }) => service.schedule(recordId(param('id')), body, who.editor(req)));
  // 已生效的到货、送货、完工单的“编辑”：只改备注这类说明，不动库存和金额，不出替代单（server/flow/correction/document-info.ts）
  on('POST /flow/:id/info', ({ param, body, req }) => updateDocumentInfo(store, recordId(param('id')), body, who.editor(req)));
  on('POST /flow/:id/confirm', ({ param, body, req }) => service.confirm(recordId(param('id')), body, who.editor(req)));
  // 客户收到货：只记送达，不动库存
  on('POST /flow/:id/delivered', ({ param, body, req }) => service.markDelivered(recordId(param('id')), body, who.editor(req)));
  for (const action of flowUndoActions)
    on(`POST /flow/:id/${action}`, ({ param, body, req }) => service[action](recordId(param('id')), body, who.editor(req)));
}

/**
 * 办一张单据（/flow/:id、/flow/:id/动作）时记下它是哪种单据：地址里只有编号，校验没过时报错按这种单据的栏目叫法说
 * （送货单的地址叫“收货地址”，server/http-errors.ts 读 res.locals.fieldRecord）。编号不是数字的（returns、daily 这类）不管。
 */
function documentKindForErrors(router: Router, store: Store) {
  // 挂在 /api/flow 下，这里的地址不带 /flow
  router.all(['/:id', '/:id/:action'], (req, res, next) => {
    const id = Number(req.params.id);
    const row = Number.isSafeInteger(id) && id > 0
      ? one(store.db, rows.flow_documents.pick({ kind: true }), 'SELECT kind FROM flow_documents WHERE id=?', id)
      : undefined;
    if (row) res.locals.fieldRecord = row.kind;
    next();
  });
}

export function flowRouter(store: Store, auth?: RequestAuth) {
  const router = Router(),
    who = requester(auth);
  const routes: FlowRoutes = { on: route<FlowApi>(router, '/flow'), store, service: new FlowService(store), who };
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  documentKindForErrors(router, store);
  // 注册顺序要紧：固定地址（原件、退货、列表、台账、登记完工、批量）排在带 :id、:kind 的前面
  sourceFileRoute(router, store, who);
  returnRoutes(routes);
  readRoutes(routes);
  saveRoutes(routes);
  documentRoutes(routes);
  return router;
}
