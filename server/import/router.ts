import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { AppError, constraintFailure, route, type Store } from '../core/index.js';
import { AiConnectionError, aiPageGuard } from '../ai/index.js';
import type { ImportManager } from './manager.js';
import type { ReceiptAi } from './receipt-ai.js';
import type { ImportExecutionService } from './import-execution.js';
import { matchDraft } from './matching.js';
import { standardOrderDraft } from './standard-order.js';
import { withArrivalStatus } from './business-links.js';
import { recognitionModes, type ImportsApi } from '../../shared/import/index.js';
import { arrivalRouter } from './arrival-router.js';
import { workspaceAdminRouter, type Operator } from './workspace-admin-router.js';
import { aiFailureMessage, replyAi } from './ai-stream.js';

/** express 解析请求体时文件太大（express.raw 的 limit） */
const tooLarge = (error: unknown) =>
  typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';

const fileName = (req: Request, fallback = '') => {
  try {
    return decodeURIComponent(String(req.headers['x-file-name'] || fallback));
  } catch {
    return fallback;
  }
};

/** 出错时回什么：上传失败记错误档案；中文说明，不带堆栈、文件内容和密钥 */
function failureHandler(manager: ImportManager, operator: Operator) {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    // 正式导入写的是业务库：出错按全站的说法回（版本冲突 409、校验没过逐项说明等，server/http-errors.ts）
    if (/^\/[^/]+\/(?:preview|execute)$/.test(req.path)) return next(error);
    let failureId: string | undefined;
    if (req.method === 'POST' && req.path === '/upload') {
      const failure = tooLarge(error) ? new AppError('文件超过10MB，上传已拒绝。', 413, 'file-size') : error;
      try {
        failureId = manager.recordFailure(
          failure,
          { fileName: fileName(req, '未知上传文件'), size: Buffer.isBuffer(req.body) ? req.body.length : 0 },
          { operation: 'upload', stage: 'upload-validation', actor: operator(req) },
        );
      } catch (recordError) {
        // 错误档案写不进去不挡住给人回话（回话里就没有错误编号），记一行日志
        console.error('[识别导入] 上传失败的错误档案没有写上：', recordError instanceof Error ? recordError.message : String(recordError));
      }
    }
    if (error instanceof AppError || error instanceof AiConnectionError)
      return res.status(error.status).json({ message: error.message, code: error.code, failureId });
    if (error instanceof ZodError)
      return res.status(422).json({
        message: '文件解析、识别结果操作或 AI 返回结构不符合约定，未保存本次结果。请检查字段后重试。',
        code: 'schema',
      });
    if (tooLarge(error))
      return res.status(413).json({ message: '文件超过 10 MB，已拒绝上传。', code: 'file-size' });
    // 数据库约束挡下的写入：给一句中文；日志里只记约束表达式，不记堆栈
    const constraint = constraintFailure(error, '识别导入 ' + req.method + ' ' + req.path, { stack: false });
    if (constraint) return res.status(500).json({ message: constraint, code: 'data-rule', failureId });
    res.status(500).json({
      message: '导入工作区操作失败，可能是文件损坏、磁盘不可写或解析器异常。未修改正式 ERP 数据。',
      code: 'import',
    });
  };
}

/**
 * AI 导入的地址（/api/ai/imports 下，接口表 shared/import/imports-api.ts）：列表、上传、读、改识别类型、订单识别和修改、核对、取消、下载原件。
 * 不在接口表里的照旧用 express 注册：上传（原始字节）、下载原件（文件）、识别（边收边推进度）。
 * 到货的两条在 arrival-router.ts，归档和永久删除、错误档案在 workspace-admin-router.ts。路由里只取参数、鉴权、调服务。
 * business：业务库（对应档案、标准订单）和正式导入的预览、执行（不开正式导入时不给 execution，这两条地址就没有）。
 */
export function importRouter(
  manager: ImportManager,
  operator?: Operator,
  receiptAi?: ReceiptAi,
  business?: { store: Store; execution?: ImportExecutionService },
) {
  const who = (req: Request) => operator?.(req) || null;
  const router = Router(),
    on = route<ImportsApi>(router, '/ai/imports');
  router.use(aiPageGuard(manager.csrfToken, '导入工作区'));
  if (receiptAi) router.use(arrivalRouter(manager, who, receiptAi));
  router.use(workspaceAdminRouter(manager, who));
  on('GET /ai/imports', () => {
    const status = manager.status();
    // 只按编号取列表里引用到的到货单（含归档）和到货原件，不把全部单据读出来再逐个找。
    return receiptAi
      ? { ...status, workspaces: withArrivalStatus(receiptAi.store, status.workspaces, (id) => receiptAi.isBusy(id)) }
      : status;
  });
  router.post(
    '/upload',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    async (req, res) => {
      const name = fileName(req);
      if (!name || !Buffer.isBuffer(req.body)) throw new AppError('请通过文件上传区域选择有效文件。', 415);
      // 页面可以说明新文件按哪种类型识别（从到货页过来的是到货单）
      const mode = z.enum(recognitionModes).default('order').parse(req.headers['x-import-mode'] || undefined);
      res.status(201).json(await manager.upload(req.body, name, false, mode));
    },
  );
  on('GET /ai/imports/:id', ({ param }) => manager.get(param('id')));
  router.get('/:id/file', async (req, res) => {
    const f = await manager.file(String(req.params.id));
    const inline = req.query.view === 'image' && f.mime.startsWith('image/');
    res.type(f.mime);
    res.set('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name));
    res.send(f.bytes);
  });
  on('POST /ai/imports/:id/mode', ({ param, body }) => manager.setMode(param('id'), body));
  on('POST /ai/imports/:id/enqueue', ({ param, body, req }) => manager.enqueue(param('id'), body, who(req)), { status: 202 });
  router.post('/:id/analyze', async (req, res) => {
    const id = String(req.params.id),
      body = z.record(z.string(), z.unknown()).catch({}).parse(req.body),
      stream = body.stream === true;
    await replyAi(req, res, {
      stream,
      abort: () => manager.abortRequest(id),
      run: (progress) => manager.analyze(id, { ...body, stream }, progress, who(req)),
      failure: (error) => ({
        message: aiFailureMessage(error, 'AI返回结构或订单字段不符合约定，未保存本次识别结果。', 'AI请求失败，未保存不完整的识别结果。'),
        code: error instanceof AppError || error instanceof AiConnectionError ? error.code : 'schema',
      }),
    });
  });
  on('POST /ai/imports/:id/edit', ({ param, body, req }) => manager.edit(param('id'), body, 'manual', who(req)));
  on('POST /ai/imports/:id/undo', ({ param, body, req }) => manager.undo(param('id'), body, who(req)));
  on('POST /ai/imports/:id/mapping', ({ param, body, req }) => manager.mapping(param('id'), body, who(req)));
  on('POST /ai/imports/:id/cancel', ({ param, body }) => manager.cancel(param('id'), body));
  if (business) {
    const { store: db, execution } = business;
    on('GET /ai/imports/:id/matches', ({ param }) => matchDraft(db, manager.get(param('id'))));
    on('GET /ai/imports/:id/standard-order', ({ param }) => standardOrderDraft(db, manager.get(param('id'))));
    if (execution) {
      on('POST /ai/imports/:id/preview', ({ param, body, req }) => execution.preview(param('id'), body, who(req)));
      on('POST /ai/imports/:id/execute', ({ param, body, req }) => execution.execute(param('id'), body, who(req), () => who(req)));
    }
  }
  router.use(failureHandler(manager, operator ?? (() => null)));
  return router;
}
