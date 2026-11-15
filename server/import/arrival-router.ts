import { Router, type Request } from 'express';
import { z } from 'zod';
import { FlowService } from '../flow/index.js';
import { AppError, requirePermission, route, type Actor } from '../core/index.js';
import { arrivalLinkSchema, type ImportsApi } from '../../shared/import/index.js';
import type { ImportManager } from './manager.js';
import type { ReceiptAi } from './receipt-ai.js';
import type { Operator } from './workspace-admin-router.js';
import { prepareArrivalRecognition } from './arrival-recognition.js';
import { aiFailureMessage, replyAi } from './ai-stream.js';

/**
 * AI 导入里到货单类型的两条地址（/api/ai/imports/:id/arrival/…）：识别送货单、把识别结果关联到登记好的到货单。
 * 识别结果不入库；登记到货、确认入库走单据流转。识别边收边推进度（replyAi），不是 JSON 来回，照旧用 express 注册。
 */
export function arrivalRouter(manager: ImportManager, operator: Operator, receiptAi: ReceiptAi) {
  const router = Router(),
    on = route<ImportsApi>(router, '/ai/imports');
  const actor = (req: Request): Actor => {
    const who = operator(req);
    if (!who) throw new AppError('请登录有业务编辑权限的账号。', 403);
    return requirePermission(who, 'business:edit');
  };
  on('POST /ai/imports/:id/arrival/link', ({ param, body, req }) => {
    actor(req);
    const workspace = manager.get(param('id'));
    const input = arrivalLinkSchema.parse(body);
    const document = input.docId ? new FlowService(receiptAi.store).get(input.docId) : null;
    if (document && document.kind !== 'arrival') throw new AppError('只能关联待入库的采购到货单。', 422);
    const sourceId = input.sourceId || document?.sourceId;
    if (document && (!sourceId || document.sourceId !== sourceId)) throw new AppError('到货单与来源原件不一致。', 409);
    if (sourceId && receiptAi.source(sourceId).hash !== workspace.fileHash)
      throw new AppError('不能关联其他文件的到货记录。', 409);
    return manager.linkArrival(workspace.id, { ...input, ...(sourceId ? { sourceId } : {}) });
  });
  router.post('/:id/arrival/recognize', async (req, res, next) => {
    try {
      const who = actor(req),
        id = String(req.params.id);
      const input = z.object({ stream: z.boolean().default(true), force: z.boolean().default(false) }).parse(req.body);
      const { workspace, source } = await prepareArrivalRecognition(manager, receiptAi, id, who);
      const startedAt = Date.now();
      const diagnose = (error: unknown) =>
        manager.recordFailure(error, workspace, { operation: 'analyze', stream: input.stream, stage: 'supplier-arrival', startedAt, actor: who });
      await replyAi(req, res, {
        stream: input.stream,
        abort: () => receiptAi.abort(source.id),
        run: async (progress) =>
          source.result && !input.force ? source : receiptAi.analyze(source.id, { force: input.force }, who, progress),
        onError: diagnose,
        failure: (error) => ({
          message: aiFailureMessage(error, '到货识别格式不正确，未保存识别结果。', '到货识别失败，请查看错误档案。'),
          failureId: diagnose(error),
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
