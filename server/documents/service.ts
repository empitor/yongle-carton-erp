import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { OperationsService } from '../operations/service.js';
import { FlowService } from '../flow/service.js';
import { requirePermission, audit } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { documentExportSchema } from '../../shared/business-export.js';
import { formatStockSize } from '../../shared/operations.js';
import { renderBusinessForm, applyDocumentTemplate, type BusinessForm } from './templates.js';
import { DocumentTemplateSettings } from './settings.js';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const joinSpecification = (...values: (string | null | undefined)[]) => {
  const parts = values.filter(Boolean).flatMap((v) => v!.split(' / '));
  const seen = new Set<string>();
  return parts
    .filter((p) => {
      const key = p.replace(/\s+/g, '').replaceAll('×', 'x');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' / ');
};
export class BusinessDocuments {
  private tx<T>(job: () => T): T {
    this.store.db.exec('SAVEPOINT document_export');
    try {
      const result = job();
      this.store.db.exec('RELEASE document_export');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO document_export; RELEASE document_export');
      throw error;
    }
  }
  constructor(
    readonly store: Store,
    readonly render = renderBusinessForm,
  ) {}
  form(
    kind: 'purchase' | 'delivery',
    id: number,
    templateId?: string,
  ): { form: BusinessForm; record: any } {
    const { form, record } = this.rawForm(kind, id),
      state = new DocumentTemplateSettings(this.store).get(),
      template = state.templates.find(
        (t) => t.id === (templateId || state.defaults[kind]) && t.kind === kind,
      );
    if (!template) throw new ImportError('模板与当前单据类型不一致或已移除。');
    return {
      record,
      form: applyDocumentTemplate(
        {
          ...form,
          title: form.title + (record.businessStatus === '已取消' ? '（已取消，仅供存档）' : ''),
        },
        template,
        state.revision,
      ),
    };
  }
  private rawForm(kind: 'purchase' | 'delivery', id: number): { form: BusinessForm; record: any } {
    if (kind === 'purchase') {
      const record = new OperationsService(this.store).repo
        .purchases(true)
        .find((p) => p.id === id);
      if (!record) throw new ImportError('采购单不存在。', 404);
      const supplier = this.store.suppliers(true).find((s) => s.id === record.supplierId);
      return {
        record,
        form: {
          title: '采购订货单',
          number: record.number,
          draft: false,
          fields: [
            ['采购单号', record.number],
            ['供应商', record.supplierName],
            [
              '供应商联系信息',
              [supplier?.contact, supplier?.phone, supplier?.address].filter(Boolean).join(' · '),
            ],
            ['下单日期', record.orderDate],
            ['预计交货日期', record.expectedDate || '未约定'],
          ],
          headers: [
            '序号',
            '产品名称',
            '规格及尺寸',
            '单位',
            '订购数量',
            '单价及计价单位',
            '金额（元）',
          ],
          rows: record.lines.map((l: any, i: number) => [
            String(i + 1),
            l.name,
            joinSpecification(l.specification, formatStockSize(l), l.material, l.flute),
            l.unit,
            l.quantity,
            (l.unitPrice ?? '待核价') + (l.priceBasis === 'area' ? ' 元/㎡' : ' 元/' + l.unit),
            l.amount ?? '待核价',
          ]),
          lineData: record.lines.map((l: any) => ({
            material: l.material,
            flute: l.flute,
            dimensions: formatStockSize(l),
            notes: l.notes,
            productCode: '',
          })),
          total: record.totalAmount,
          notes: record.notes,
          signatures: ['采购方确认', '供应商确认'],
        },
      };
    }
    const record = new FlowService(this.store).get(id);
    if (record.kind !== 'delivery') throw new ImportError('请选择送货记录。');
    if (['cancelled', 'reversed'].includes(record.status))
      throw new ImportError('取消或冲销的送货单不能导出为有效送货单。', 409);
    const customer = this.store.customers(true).find((c) => c.id === record.customerId),
      orders = this.store.orders(true);
    return {
      record,
      form: {
        title: '送货单',
        number: record.number,
        draft: record.status !== 'confirmed',
        fields: [
          ['送货单号', record.number],
          ['客户', customer?.name || '历史客户'],
          ['收货地址', record.address || customer?.address || '未记录'],
          [
            '客户联系信息',
            [
              record.contact || customer?.contact,
              record.phone || customer?.phone,
              record.address || customer?.address,
            ]
              .filter(Boolean)
              .join(' · '),
          ],
          [
            '关联销售订单',
            [
              ...new Set(
                record.lines.map(
                  (l: any) => l.orderNumber || orders.find((o) => o.id === l.orderId)?.number,
                ),
              ),
            ].join(' / '),
          ],
          [
            record.status === 'confirmed' ? '实际送货日期' : '预计送货日期',
            record.status === 'confirmed'
              ? record.date + ' ' + (record.actualTime || '时间未记录')
              : (record.plannedDate || record.date) + ' ' + (record.plannedTime || ''),
          ],
          [
            '客户采购订单号',
            [
              ...new Set(
                record.lines
                  .map(
                    (l: any) =>
                      l.externalPurchaseOrder ??
                      orders.find((o) => o.id === l.orderId)?.externalPurchaseOrder,
                  )
                  .filter(Boolean),
              ),
            ].join(' / ') || '未记录',
          ],
        ],
        headers: ['序号', '产品名称', '规格及尺寸', '单位', '本批送货数量', '备注'],
        columnKeys: ['index', 'name', 'specification', 'unit', 'quantity', 'notes'],
        rows: record.lines.map((l: any, i: number) => {
          const ol = orders
            .find((o) => o.id === l.orderId)
            ?.lines.find((x) => x.id === l.orderLineId);
          return [
            String(i + 1),
            l.productName || ol?.productName || '历史产品',
            joinSpecification(
              l.specification || ol?.specification,
              l.length != null || l.width != null ? formatStockSize(l) : '',
            ),
            l.unit || ol?.unit || '未记录',
            l.quantity,
            l.notes || '',
          ];
        }),
        lineData: record.lines.map((l: any) => {
          const o = orders.find((o) => o.id === l.orderId),
            ol = o?.lines.find((x) => x.id === l.orderLineId);
          return {
            orderNumber: l.orderNumber || o?.number || '',
            customerOrderNumber: l.externalPurchaseOrder ?? o?.externalPurchaseOrder ?? '',
            productCode: l.customerProductCode ?? ol?.customerProductCode ?? '',
            unitPrice: l.unitPriceExact || l.unitPrice || '未记录',
            amount: l.amountExact || l.amount || '未记录',
            dimensions: l.length != null || l.width != null ? formatStockSize(l) : '',
            material: l.material || '',
            flute: l.flute || '',
          };
        }),
        notes: record.notes,
        signatures: ['送货人签字', '收货人签字'],
      },
    };
  }
  async generate(raw: unknown, who: Actor) {
    const actor = requirePermission(who, 'business:edit'),
      v = documentExportSchema.parse(raw),
      digest = hash(JSON.stringify({ v, actor: actor.id }));
    const prior = this.store.db
      .prepare(
        "SELECT digest,result FROM operation_requests WHERE kind='document-export' AND request_id=?",
      )
      .get(v.requestId);
    if (prior) {
      if (prior.digest !== digest) throw new ImportError('导出请求编号已用于其他内容。', 409);
      return this.status(v.requestId, actor);
    }
    const { form, record } = this.form(v.kind, v.id, v.templateId);
    if (v.templateId && v.templateId !== form.templateId)
      throw new ImportError('模板与当前单据类型不一致。');
    if (record.version !== v.expectedVersion)
      throw new ImportError('单据已更新，请重新读取后导出。', 409);
    if (v.markOrdered && (record.archived || record.businessStatus === '已取消'))
      throw new ImportError('已取消或归档的采购单不能导出并标记已订货。', 409);
    const bytes = await this.render(form, v.format);
    const latest = this.form(v.kind, v.id).record;
    if (new DocumentTemplateSettings(this.store).get().revision !== form.templateRevision)
      throw new ImportError('生成期间模板已更新，请重新导出。', 409);
    if (latest.version !== record.version)
      throw new ImportError('文件生成期间单据已更新，未改变状态，请重新导出。', 409);
    const result = {
      ...v,
      actorId: actor.id,
      filename:
        record.number + '-' + form.title + (form.draft ? '-计划非正式' : '') + '.' + v.format,
      sha256: hash(bytes),
      bytes: bytes.toString('base64'),
      size: bytes.length,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      completedAt: null,
      draft: form.draft,
      statusBefore: record.businessStatus || record.status,
      templateId: form.templateId,
      templateRevision: form.templateRevision,
      templateSnapshot: form.templateSnapshot,
    };
    return this.tx(() => {
      const inserted = this.store.db
        .prepare("INSERT OR IGNORE INTO operation_requests VALUES('document-export',?,?,?)")
        .run(v.requestId, digest, JSON.stringify(result));
      if (!inserted.changes) {
        const saved = this.store.db
          .prepare(
            "SELECT digest FROM operation_requests WHERE kind='document-export' AND request_id=?",
          )
          .get(v.requestId);
        if (saved?.digest !== digest) throw new ImportError('导出请求编号已用于其他内容。', 409);
        return this.status(v.requestId, actor);
      }
      audit(
        this.store,
        actor,
        'business-documents',
        'generate',
        v.kind === 'purchase' ? 'purchases' : 'flow_delivery',
        v.id,
        {
          exportId: v.requestId,
          filename: result.filename,
          sha256: result.sha256,
          markOrdered: v.markOrdered,
          version: record.version,
        },
      );
      return this.status(v.requestId, actor);
    });
  }
  private load(id: string, actor: Actor): any {
    requirePermission(actor, 'business:edit');
    z.string().uuid().parse(id);
    const row = this.store.db
      .prepare(
        "SELECT result FROM operation_requests WHERE kind='document-export' AND request_id=?",
      )
      .get(id);
    if (!row) throw new ImportError('导出文件不存在。', 404);
    const value = JSON.parse(String(row.result));
    if (value.actorId !== actor.id) throw new ImportError('导出文件不属于当前账号。', 403);
    return value;
  }
  private put(v: any) {
    this.store.db
      .prepare(
        "UPDATE operation_requests SET result=? WHERE kind='document-export' AND request_id=?",
      )
      .run(JSON.stringify(v), v.requestId);
  }
  status(id: string, actor: Actor) {
    const { bytes, actorId, ...v } = this.load(id, actor),
      record = this.form(v.kind, v.id).record;
    return {
      ...v,
      exportId: id,
      url: '/api/documents/' + id + '/file',
      businessStatus: record.businessStatus || record.status,
      deliveryStatus: v.completedAt ? 'completed' : v.deliveredAt ? 'delivered' : 'ready',
      verified: true,
      message:
        v.markOrdered && !v.completedAt
          ? '文件已生成；下载交付完成后才标记已订货。'
          : '文件结果及当前业务状态已核验。',
    };
  }
  file(id: string, actor: Actor) {
    const v = this.load(id, actor);
    return { ...v, buffer: Buffer.from(v.bytes, 'base64') };
  }
  delivered(id: string, actor: Actor) {
    const v = this.load(id, actor);
    if (!v.deliveredAt) {
      v.deliveredAt = new Date().toISOString();
      this.put(v);
    }
  }
  complete(id: string, sha256: string, actor: Actor) {
    const v = this.load(id, actor);
    if (!v.deliveredAt || sha256 !== v.sha256)
      throw new ImportError('文件尚未完整交付或校验失败，采购状态未修改。', 409);
    if (v.completedAt) return this.status(id, actor);
    this.store.db.exec('SAVEPOINT document_delivery');
    try {
      if (v.markOrdered) {
        const ops = new OperationsService(this.store),
          record = this.form('purchase', v.id).record;
        if (record.archived || record.businessStatus === '已取消')
          throw new ImportError('采购已取消或归档，已交付文件但未修改业务状态。', 409);
        if (record.businessStatus !== '已订货') {
          if (record.version !== v.expectedVersion)
            throw new ImportError(
              '采购单已变化，已交付文件但未标记订货，请读取最新采购单后重新导出。',
              409,
            );
          ops.savePurchase({ ...record, status: '已订货', version: record.version }, actor, v.id);
        }
      }
      v.completedAt = new Date().toISOString();
      this.put(v);
      audit(
        this.store,
        actor,
        'business-documents',
        'download-complete',
        v.kind === 'purchase' ? 'purchases' : 'flow_delivery',
        v.id,
        {
          exportId: id,
          sha256,
          before: v.statusBefore,
          after:
            this.form(v.kind, v.id).record.businessStatus || this.form(v.kind, v.id).record.status,
        },
      );
      this.store.db.exec('RELEASE document_delivery');
      return this.status(id, actor);
    } catch (e) {
      this.store.db.exec('ROLLBACK TO document_delivery; RELEASE document_delivery');
      throw e;
    }
  }
}
