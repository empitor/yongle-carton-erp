import type { Actor } from '../core/index.js';
import type { ImportManager } from './manager.js';
import type { ReceiptAi } from './receipt-ai.js';
import { FlowService } from '../flow/index.js';
import { AppError } from '../core/index.js';

/** 到货识别前的检查和原件准备。页面和助手走同一套，只有已确认的到货单不能再识别覆盖。 */
export async function prepareArrivalRecognition(
  manager: ImportManager,
  receiptAi: ReceiptAi,
  id: string,
  actor: Actor,
) {
  const workspace = manager.get(id);
  if (workspace.mode !== 'arrival') throw new AppError('请先将此文件切换为到货单识别。', 409);
  if (
    workspace.arrivalDocId &&
    receiptAi.store &&
    new FlowService(receiptAi.store).get(workspace.arrivalDocId).status !== 'draft'
  )
    throw new AppError('已确认或取消的到货单不能重新识别覆盖。', 409);
  const ai = receiptAi.settings.status();
  if (!ai.ready) throw new AppError(ai.message, 400, 'key_required');
  const original = await manager.original(id);
  const source = receiptAi.upload(original.bytes, original.fileName, actor);
  if (workspace.arrivalSourceId !== source.id)
    manager.linkArrival(id, {
      expectedRevision: workspace.revision,
      docId: workspace.arrivalDocId || null,
      sourceId: source.id,
    });
  return { workspace, source };
}
