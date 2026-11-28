import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Store } from '../core/index.js';
import { AppError, audit, inSavepoint, requirePermission } from '../core/index.js';
import { FlowService } from '../flow/index.js';
import { OrderBatchService } from '../operations/index.js';
import { flowEntity, toScheduleEntries } from '../../shared/business/index.js';
import { today } from '../../shared/core/index.js';
import {
  batchPreviewSchema,
  docField,
  docFieldKey,
  documentExportSchema,
  previewFileSchema,
  type BusinessForm,
  type DocumentExport,
  type DocumentExportStatus,
  type DocumentKind,
} from '../../shared/documents/index.js';
import { deliveryForm } from './delivery-form.js';
import {
  checkBeforeRender,
  checkUnchanged,
  exportOptions,
  purchaseStatus,
  requestedPurchases,
  superseded,
  type Built,
  type ExportRequest,
} from './export-checks.js';
import { orderExported, shipExported } from './export-delivery.js';
import {
  EXPORT_FILE_KEEP_DAYS,
  exportBytes,
  exportDigest,
  insertExport,
  markCompleted,
  markDelivered,
  readExport,
} from './export-records.js';
import { templated, type FormResult, type RawForm } from './forms.js';
import { purchaseForm } from './purchase-form.js';
import { renderBusinessForm } from './render.js';

const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
/** 一张单据拼好、还没套模板的内容 */
const rawForms: { [K in DocumentKind]: (store: Store, id: number) => RawForm<K> } = {
  purchase: (store, id) => purchaseForm(store, [id]),
  delivery: deliveryForm,
};
/** 排好版、要存成导出记录的这一份 */
type Rendered = { digest: string; actor: Actor; built: Built; bytes: Buffer; shipDate: string | undefined };
const auditEntity = (kind: DocumentKind) => (kind === 'purchase' ? 'purchases' : flowEntity('delivery'));

export class BusinessDocuments {
  constructor(
    readonly store: Store,
    readonly render = renderBusinessForm,
  ) {}
  /**
   * shipping：待送货的送货单按“导出并出库”来印（预览和正式导出都用）：
   * 导出就是出库，纸上印今天出库的送货日期，和出库后系统里记的一样，不是当初安排的日子。
   * shipDate：正式导出时定下印在纸上的那一天，记进导出记录，交付完成出库时就按这一天出库。
   */
  form<K extends DocumentKind>(
    kind: K,
    id: number,
    templateId?: string,
    options: { shipping?: boolean; shipDate?: string } = {},
  ): FormResult<K> {
    const result = templated(this.store, kind, rawForms[kind](this.store, id), templateId);
    if (options.shipping && kind === 'delivery' && result.record.status === 'draft')
      result.form.fields = result.form.fields.map(([label, value]) =>
        label === docFieldKey('plannedDate') ? docField('shippedDate', options.shipDate ?? today()) : [label, value],
      );
    return result;
  }
  /**
   * 单据现在的状态（查导出状态、交付完成记审计用）：只读单据，不套模板。
   * 送货单导出以后取消、冲销了照样查得到；单据删掉了报不存在。
   */
  private currentStatus(kind: DocumentKind, id: number): string {
    return kind === 'purchase' ? purchaseStatus(purchaseForm(this.store, [id]).record) : new FlowService(this.store).get(id).status;
  }
  /** 合并订货单：和导出时生成的是同一份内容 */
  private batchForm(v: z.output<typeof batchPreviewSchema>) {
    return templated(
      this.store,
      'purchase',
      purchaseForm(this.store, v.purchaseIds, v.schedule ? toScheduleEntries(v.schedule) : undefined),
      v.templateId,
    ).form;
  }
  /** 合并订货单的预览：和导出时生成的是同一份内容。 */
  batchPreview(raw: unknown): BusinessForm {
    return this.batchForm(batchPreviewSchema.parse(raw));
  }
  /**
   * 预览 Word 排版：按模板排一份 Word 只给人看，直接返回文件内容。和上面两个预览一样只看不落库——
   * 不占订货单号（几张合并还没订货时印的是“下一个号”，和窗口里的预览一致）、不写导出记录、不写审计、
   * 不改任何状态。权限和正式导出一样（business:edit）。
   */
  async previewFile(raw: unknown, who: Actor | null | undefined) {
    requirePermission(who, 'business:edit');
    const v = previewFileSchema.parse(raw);
    const form =
      v.kind === 'purchase' ? this.batchForm(v) : this.form('delivery', v.id, v.templateId, { shipping: !!v.shipping }).form;
    return this.render(form, 'docx');
  }
  async generate(raw: unknown, who: Actor | null | undefined): Promise<DocumentExportStatus> {
    const actor = requirePermission(who, 'business:edit'),
      v = documentExportSchema.parse(raw),
      digest = hash(JSON.stringify({ v, actor: actor.id }));
    const prior = this.replayed(v.requestId, digest, actor);
    if (prior) return prior;
    // 导出并出库：纸上的“送货日期”这里定下来，记进导出记录，交付完成时按这一天出库
    const shipDate = v.markShipped ? today() : undefined;
    const built = this.build(v, shipDate);
    checkBeforeRender(this.store, v, built, actor);
    const bytes = await this.render(built.form, v.format);
    checkUnchanged(this.store, built, this.build(v, shipDate));
    return this.save(v, { digest, actor, built, bytes, shipDate });
  }
  /** 同一个请求编号已经存过：内容一样原样返回，换了内容拒绝；没存过返回 null */
  private replayed(requestId: string, digest: string, actor: Actor): DocumentExportStatus | null {
    const saved = exportDigest(this.store, requestId);
    if (!saved) return null;
    if (saved !== digest) throw new AppError('导出请求编号已用于其他内容。', 409);
    return this.status(requestId, actor);
  }
  private build(v: ExportRequest, shipDate: string | undefined): Built {
    if (v.kind === 'delivery')
      return { kind: 'delivery', ...this.form('delivery', v.id, v.templateId, { shipping: v.markShipped, shipDate }) };
    const ids = requestedPurchases(v).map((p) => p.id),
      raw = purchaseForm(this.store, ids, v.schedule ? toScheduleEntries(v.schedule) : undefined);
    return { kind: 'purchase', ...templated(this.store, 'purchase', raw, v.templateId) };
  }
  /** 存导出记录、占订货单号、记审计（一个保存点里） */
  private save(v: ExportRequest, done: Rendered): DocumentExportStatus {
    const { built, actor } = done,
      { form, record } = built;
    const filename = record.number + '-' + form.title + (form.draft ? '-预览未出库' : '') + '.' + v.format,
      sha256 = hash(done.bytes),
      // 几张合并且还没建批次时，订货单号先记在导出记录里，交付完成建批次时用同一个号
      batchNumber = built.kind === 'purchase' && !built.record.batch && built.record.members.length > 1 ? record.number : null;
    return inSavepoint(this.store.db, () => {
      // 排版是异步的，两个相同的请求会交错：后到的这里看到已经有记录，原样返回，不再存一份
      const saved = this.replayed(v.requestId, done.digest, actor);
      if (saved) return saved;
      // 订货单号这时才真正占住（预览和排版期间只看不占）。排版期间号被别的导出占走就拒绝，这份文件不留，
      // 纸上不会印出重号；要放在插入之前，不然先撞上的是 batch_number 的唯一索引，报不出这句话
      if (batchNumber) new OrderBatchService(this.store).reserveNumber(batchNumber);
      insertExport(this.store, {
        id: v.requestId,
        digest: done.digest,
        kind: v.kind,
        recordId: v.id,
        actorId: actor.id,
        format: v.format,
        filename,
        sha256,
        templateId: form.templateId,
        templateRevision: form.templateRevision,
        batchNumber,
        // 纸上印的送货日期（待送货的导出出库时才有）；交付完成出库就按这一天
        shipDate: v.markShipped && record.status === 'draft' ? (done.shipDate ?? null) : null,
        options: exportOptions(v, built),
        templateSnapshot: form.templateSnapshot,
        bytes: done.bytes,
      });
      audit(this.store, actor, {
        action: 'generate',
        entity: auditEntity(v.kind),
        id: v.id,
        document: {
          exportId: v.requestId,
          filename,
          sha256,
          markOrdered: v.markOrdered,
          markShipped: v.markShipped,
          version: record.version,
        },
      });
      return this.status(v.requestId, actor);
    });
  }
  private load(id: string, actor: Actor): DocumentExport {
    requirePermission(actor, 'business:edit');
    z.uuid().parse(id);
    const v = readExport(this.store, id);
    if (!v) throw new AppError('导出文件不存在。', 404);
    if (v.actorId !== actor.id) throw new AppError('导出文件不属于当前账号。', 403);
    return v;
  }
  status(id: string, actor: Actor): DocumentExportStatus {
    const { actorId, ...v } = this.load(id, actor);
    return {
      ...v,
      exportId: id,
      url: '/api/documents/' + id + '/file',
      businessStatus: this.currentStatus(v.kind, v.id),
      deliveryStatus: v.completedAt ? 'completed' : v.deliveredAt ? 'delivered' : 'ready',
      verified: true,
      message:
        superseded(this.store, v) ??
        (v.markOrdered && !v.completedAt
          ? '文件已生成；下载交付完成后才标记已订货。'
          : '文件结果及当前业务状态已核验。'),
    };
  }
  file(id: string, actor: Actor) {
    const v = this.load(id, actor);
    // 这几张已经按另一份订货单订了货：这份文件作废，不再发出去（交付完成那一步也会拦）
    const conflict = superseded(this.store, v);
    if (conflict) throw new AppError(conflict, 409, 'export_superseded');
    const bytes = exportBytes(this.store, id);
    // 过了保存期的文件内容已经清掉（purgeExportFiles），导出记录还在
    if (bytes == null)
      throw new AppError(
        '文件已过期（导出文件只保留 ' + EXPORT_FILE_KEEP_DAYS + ' 天），请重新导出。',
        410,
        'export_expired',
      );
    return { ...v, buffer: bytes };
  }
  /** 记下文件已经完整发给浏览器；只记第一次，重复下载不变 */
  delivered(id: string, actor: Actor) {
    this.load(id, actor);
    markDelivered(this.store, id);
  }
  complete(id: string, sha256: string, actor: Actor): DocumentExportStatus {
    const v = this.load(id, actor);
    // 同一组采购单先后导出了两份订货单、另一份已经交付：这份不能再记成完成，也不能另建批次或沿用别的号。
    // 已经完成的（同一份重复点完成）这里不拦，照常原样返回
    const conflict = superseded(this.store, v);
    if (conflict) throw new AppError(conflict, 409, 'export_superseded');
    if (!v.deliveredAt || sha256 !== v.sha256)
      throw new AppError('文件尚未完整交付或校验失败，单据状态未修改。', 409);
    if (v.completedAt) return this.status(id, actor);
    return inSavepoint(this.store.db, () => {
      // 送货单导出出库：文件完整交付后核对出库，变“送货中”；出库日按纸上印的那天
      if (v.markShipped) shipExported(this.store, v, actor);
      if (v.markOrdered) orderExported(this.store, v, id, actor);
      markCompleted(this.store, id);
      audit(this.store, actor, {
        action: 'download-complete',
        entity: auditEntity(v.kind),
        id: v.id,
        document: { exportId: id, sha256, before: v.statusBefore, after: this.currentStatus(v.kind, v.id) },
      });
      return this.status(id, actor);
    });
  }
}
