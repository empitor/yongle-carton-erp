import type { z } from 'zod';
import type { Actor, Store } from '../core/index.js';
import { AppError, one, rows } from '../core/index.js';
import { FlowService } from '../flow/index.js';
import { OrderBatchService } from '../operations/index.js';
import type { DocumentExport, DocumentKind, ExportOptions, documentExportSchema } from '../../shared/documents/index.js';
import type { FormResult, PurchaseRecord } from './forms.js';
import { DocumentTemplateSettings } from './settings.js';
// 正式导出的核对（service.ts 的 generate、status、file、complete 用）：排版前单据能不能这样导出、排版期间有没有被改、
// 导出记录里存什么，以及订货单已经按另一份订货了（这份作废）。只读不写。

export type ExportRequest = z.output<typeof documentExportSchema>;
/** 拼好、套上模板的单据，带上种类（按种类区分记录） */
export type Built = { [K in DocumentKind]: FormResult<K> & { kind: K } }[DocumentKind];

const CHANGED_DURING_RENDER = '文件生成期间单据已更新，未改变状态，请重新导出。';

/** 订货单要导出的几张采购单和读到时的版本：不传 purchases 就是只有 id 这一张 */
export const requestedPurchases = (v: ExportRequest) => v.purchases ?? [{ id: v.id, version: v.expectedVersion }];
/** 订货单记录的状态：有业务状态（已订货、已取消……）就用它 */
export const purchaseStatus = (r: PurchaseRecord) => r.businessStatus || r.status;
const statusOf = (built: Built) => (built.kind === 'purchase' ? purchaseStatus(built.record) : built.record.status);

/** 订货单：每张采购单都还是读到时的版本；要标已订货的不能有已取消或归档的 */
function checkMembers(v: ExportRequest, members: PurchaseRecord['members']) {
  const versions = new Map(requestedPurchases(v).map((p) => [p.id, p.version]));
  for (const m of members) {
    const expected = versions.get(m.id);
    if (expected !== undefined && expected !== m.version)
      throw new AppError('采购单 ' + m.number + ' 已更新，请重新读取后导出。', 409);
    if (v.markOrdered && (m.archived || m.businessStatus === '已取消'))
      throw new AppError('已取消或归档的采购单不能导出并标记已订货：' + m.number, 409);
  }
}

/**
 * 排版前核对：导出出库的送货单要能出库（纸上不印“预览”），模板对得上，单据还是读到时的版本。
 * 导出出库时把单据内容改成正式的（draft=false）。
 */
export function checkBeforeRender(store: Store, v: ExportRequest, built: Built, actor: Actor) {
  if (v.markShipped && built.kind === 'delivery') {
    const status = built.record.status;
    if (status !== 'draft' && status !== 'confirmed') throw new AppError('取消或冲销的送货单不能导出出库。', 409);
    if (status === 'draft') new FlowService(store).checkShippable(v.id, actor);
    built.form.draft = false;
  }
  if (v.templateId && v.templateId !== built.form.templateId) throw new AppError('模板与当前单据类型不一致。');
  if (built.kind === 'purchase') checkMembers(v, built.record.members);
  else if (built.record.version !== v.expectedVersion) throw new AppError('单据已更新，请重新读取后导出。', 409);
}

/** 排版是异步的：排完再读一遍，单据或模板在这期间改了就不存这份文件 */
export function checkUnchanged(store: Store, built: Built, latest: Built) {
  if (
    built.kind === 'purchase' &&
    latest.kind === 'purchase' &&
    latest.record.members.some((m) => built.record.members.find((x) => x.id === m.id)?.version !== m.version)
  )
    throw new AppError(CHANGED_DURING_RENDER, 409);
  if (new DocumentTemplateSettings(store).get().revision !== built.form.templateRevision)
    throw new AppError('生成期间模板已更新，请重新导出。', 409);
  if (latest.record.version !== built.record.version) throw new AppError(CHANGED_DURING_RENDER, 409);
}

/** 不按列查的内容；已经有列的字段（单据、格式、文件、模板、订货单号、送货日期、三个时间）不在这里再存一份 */
export function exportOptions(v: ExportRequest, built: Built): ExportOptions {
  return {
    markOrdered: v.markOrdered,
    markShipped: v.markShipped,
    expectedVersion: v.expectedVersion,
    purchases: v.purchases,
    schedule: v.schedule,
    draft: built.form.draft,
    statusBefore: statusOf(built),
    ...(built.kind === 'purchase'
      ? {
          members: built.record.members.map((m) => ({ id: m.id, version: m.version })),
          scheduleEntries: built.record.schedule,
        }
      : {}),
  };
}

/** 订货单的单号；订货单成员表的外键指着它，读不到是库坏了 */
function batchNumberOf(store: Store, batchId: number) {
  const row = one(store.db, rows.order_batches.pick({ number: true }), 'SELECT number FROM order_batches WHERE id=?', batchId);
  if (!row) throw new Error('订货单 ' + batchId + ' 里挂着采购单，订货单却读不出来');
  return row.number;
}

/**
 * 正式订货的导出还没交付完成，这几张采购单却已经按另一份订货单订了货（另一份导出先交付了，
 * 或手工改成了已订货）：这份文件上的号在系统里查不到，作废。返回给人看的说明，没有冲突返回 null。
 * 同一份订货单重新导出（批次和号都对得上）不算冲突。
 */
export function superseded(
  store: Store,
  v: Pick<DocumentExport, 'kind' | 'id' | 'markOrdered' | 'completedAt' | 'members' | 'batchNumber'>,
): string | null {
  if (v.kind !== 'purchase' || !v.markOrdered || v.completedAt) return null;
  const batches = new OrderBatchService(store),
    ids = [...new Set((v.members ?? [{ id: v.id }]).map((m) => m.id))],
    owners = [...new Set(ids.map((id) => batches.batchIdOf(id)))],
    taken = owners.filter((o): o is number => o !== null);
  if (!taken.length) return null;
  const numbers = taken.map((id) => batchNumberOf(store, id));
  if (
    owners.length === 1 &&
    batches.memberIds(taken[0]).length === ids.length &&
    (!v.batchNumber || numbers[0] === v.batchNumber)
  )
    return null;
  return (
    (ids.length > 1 ? '这几张采购单' : '这张采购单') +
    '已按订货单 ' +
    numbers.join('、') +
    ' 订货，这份文件作废，请不要发给供应商。'
  );
}
