import type { Actor } from '../../core/index.js';
import { changeArchive, exists, recordArchiveTarget } from '../../core/index.js';
import type { FlowDocView } from '../../../shared/business/index.js';
import type { FlowCommands } from './base.js';
import { touchFlowDocument } from './document-store.js';

/*
 * 单据的归档、恢复：做法和说法和档案同一份（server/core/records/archive.ts），这里只给单据“什么时候不能归档”。
 * 批量地址是 POST /api/flow/batch（router.ts）。
 */
function target(flow: FlowCommands) {
  return recordArchiveTarget(flow.store, {
    load(id: number) {
      if (!exists(flow.store.db, 'SELECT 1 FROM flow_documents WHERE id=?', id)) return undefined;
      const doc = flow.get(id);
      return { entity: 'flow_' + doc.kind, version: doc.version, row: doc };
    },
    // doc 是上面 load 读出来的单据视图
    blocked(_id: number, doc: FlowDocView) {
      if (doc.status === 'draft') return '还没核对的单据不能归档';
      if (doc.kind === 'task' && doc.status === 'confirmed' && Number(doc.completed) < Number(doc.quantity))
        return '生产任务还没做完，不能归档';
      return null;
    },
    after: (id: number) => touchFlowDocument(flow.store, id),
  });
}

export function archiveFlowDocuments(flow: FlowCommands, raw: unknown, who: Actor | null | undefined) {
  return changeArchive(raw, who, target(flow));
}
