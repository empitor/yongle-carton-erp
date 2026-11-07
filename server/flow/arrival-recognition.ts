import type { Actor } from '../auth.js';
import type { ImportManager } from '../import/manager.js';
import type { ReceiptAi } from './receipt-ai.js';
import { FlowService } from './service.js';
import { ImportError } from '../import/errors.js';

/** 到货识别前的检查和原件准备。页面和助手走同一套，只有已确认的到货单不能再识别覆盖。 */
export async function prepareArrivalRecognition(
  manager: ImportManager,
  receiptAi: ReceiptAi,
  id: string,
  actor: Actor,
  input: { profile?: { id: string; endpoint: string; model: string; apiStyle: string } },
) {
  const workspace = manager.get(id);
  if (workspace.mode !== 'arrival') throw new ImportError('请先将此文件切换为到货单识别。', 409);
  if (
    workspace.arrivalDocId &&
    receiptAi.store &&
    new FlowService(receiptAi.store).get(workspace.arrivalDocId).status !== 'draft'
  )
    throw new ImportError('已确认或取消的到货单不能重新识别覆盖。', 409);
  const profile = receiptAi.settings.view().active;
  if (!profile?.hasApiKey || !profile.model) throw new ImportError('请先保存并启用AI预设。', 400);
  if (
    input.profile &&
    ['id', 'endpoint', 'model', 'apiStyle'].some(
      (key) => (input.profile as any)[key] !== (profile as any)[key],
    )
  )
    throw new ImportError('AI配置已变化，请重新确认当前文件外发范围。', 409);
  const original = await manager.original(id);
  // 读原件要时间，这期间配置可能被改，外发前再核一次。
  const after = receiptAi.settings.view().active;
  if (['id', 'endpoint', 'model', 'apiStyle'].some((key) => (after as any)?.[key] !== (profile as any)[key]))
    throw new ImportError('AI配置已变化，请重新确认当前文件外发范围。', 409);
  const source = receiptAi.upload(original.bytes, original.fileName, actor)!;
  if (workspace.arrivalSourceId !== source.id)
    manager.linkArrival(id, {
      expectedRevision: workspace.revision,
      docId: workspace.arrivalDocId || null,
      sourceId: source.id,
    });
  return { workspace, source, profile };
}
