import { flowKinds, type FlowKind } from '../../../shared/core/index.js';
import { z } from 'zod';
import { type Actor, type Store } from '../../core/index.js';
import { AppError, audit, inSavepoint, one, requirePermission, rows } from '../../core/index.js';
import { documentInfoFields, documentInfoSchema, flowDocNames, pendingLabels } from '../../../shared/business/index.js';
import { writeFlowDocument } from '../documents/document-store.js';
import { get, storedDocument } from '../documents/read.js';

/*
 * 已生效单据的说明编辑（详情的“编辑”、批次块的“写备注 / 改备注”、数据管理只改说明、助手 flow.edit_info 都走这里）：
 * 只改不动库存、金额的说明字段，不出替代单——到货：备注、到货时间；送货：备注、地址、联系人、联系方式、实际送达时间；
 * 完工：批次备注、操作人。在库里存的那份内容上只换这几项，版本号加一、记修改历史。
 * 改数量这类走更正（correction.ts），整张没发生走撤销；待核对的单据在编辑窗里整张改；已撤销、已取消、已被更正替代、
 * 已归档的不改。财务不受影响：来源指纹不含归“说明”的栏目，版本变了只更新观察记录。
 */
// 输入的规则（只传要改的那几项，expectedVersion 是打开时的版本）在 shared/business/flow-requests.ts，POST /flow/:id/info 和助手共用。
type Field = Exclude<keyof z.infer<typeof documentInfoSchema>, 'expectedVersion'>;
/** 说明字段（输入里版本号以外的那几项），按输入结构里的先后 */
const infoFields = documentInfoSchema.keyof().options.filter((k): k is Field => k !== 'expectedVersion');
/** 这张单据现在的种类、单号、状态、版本 */
const headRow = rows.flow_documents.pick({ number: true, status: true, version: true }).extend({ kind: z.enum(flowKinds) });

/** 每种已生效单据能改的说明字段：单据表头归“说明”的那些（shared/business/finance-source.ts），生产任务没有 */
const editable: Partial<Record<FlowKind, readonly Field[]>> = documentInfoFields;
const labels: Record<Field, string> = { notes: '备注', actualTime: '时间', address: '地址', contact: '联系人', phone: '联系方式', operator: '操作人' };
/** 库里没写过的说明按空算：时间是 null，别的是空字符串 */
const valueOf = (field: Field, v: unknown) => (field === 'actualTime' ? (v ?? null) : String(v ?? ''));

/** 改一张已生效单据的说明字段。同样的内容再交一次原样返回，不加版本号、不记修改历史。返回改后的单据和 changed */
export function updateDocumentInfo(store: Store, id: number, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit'),
    input = documentInfoSchema.parse(raw);
  return inSavepoint(store.db, () => {
    const row = one(store.db, headRow, 'SELECT kind,number,status,version FROM flow_documents WHERE id=?', id);
    if (!row) throw new AppError('单据不存在。', 404);
    const kind = row.kind,
      fields = editable[kind],
      name = flowDocNames[kind];
    if (!fields) throw new AppError('生产任务请用“编辑”改。', 409);
    const given = fields.filter((f) => input[f] !== undefined),
      other = infoFields.find((k) => input[k] !== undefined && !fields.includes(k));
    if (other) throw new AppError(name + '没有“' + labels[other] + '”这一项可改。', 422);
    if (!given.length) throw new AppError('请写要改的内容。');
    const doc = storedDocument(store, id),
      { number, version } = row;
    if (row.status === 'draft') throw new AppError('这张' + name + '还是' + pendingLabels[kind] + '，请在编辑窗里整张改。', 409);
    if (doc.replacedBy != null) throw new AppError('这张' + name + '已被更正替代，请改替代它的那张。', 409);
    if (row.status !== 'confirmed')
      throw new AppError('这张' + name + (row.status === 'cancelled' ? '已取消' : '已撤销') + '，不能再改。', 409);
    if (store.archived('flow_' + kind, id)) throw new AppError('这张' + name + '已归档，请先恢复再改。', 409);
    const current: Partial<Record<Field, unknown>> = doc,
      before = Object.fromEntries(given.map((f) => [f, valueOf(f, current[f])])),
      after = Object.fromEntries(given.map((f) => [f, valueOf(f, input[f])]));
    const changed = given.some((f) => before[f] !== after[f]);
    if (changed) {
      if (version !== input.expectedVersion)
        throw new AppError(name + ' ' + number + ' 已变化（可能是别人刚改过），请刷新后再改。', 409);
      writeFlowDocument(store, id, { ...doc, ...after }, { at: new Date().toISOString() });
      audit(store, actor, {
        action: 'edit-info',
        entity: 'flow_' + kind,
        id,
        document: { number, before, after, version },
      });
    }
    return { ...get(store, id), changed };
  });
}
