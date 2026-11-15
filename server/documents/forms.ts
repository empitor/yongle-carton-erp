import type { Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import type { FlowDocView, OrderBatchView, PurchaseView, ScheduleEntry } from '../../shared/business/index.js';
import { sameSpecification } from '../../shared/core/index.js';
import type { BusinessForm, DocumentKind, TemplatedForm } from '../../shared/documents/index.js';
import { applyDocumentTemplate } from './apply-template.js';
import { DocumentTemplateSettings } from './settings.js';
// 从业务数据拼出要印的单据内容（只读，不写库）：送货单在 delivery-form.ts、订货单在 purchase-form.ts，这里套上模板。
// 导出记录的生成和交付在 service.ts。

/** 订货单里每张采购单导出时的样子（核对版本、能不能标已订货） */
type ExportMember = Pick<PurchaseView, 'id' | 'number' | 'version' | 'businessStatus' | 'archived'>;
/** 订货单拼出来的记录：排在最前的采购单，换上订货单号，带上批次、各张采购单和到货安排 */
export type PurchaseRecord = PurchaseView & {
  batch: OrderBatchView | null;
  members: ExportMember[];
  schedule: ScheduleEntry[];
};
/** 每种单据拼出来的记录：订货单是上面的记录，送货单是单据视图 */
type FormRecords = { purchase: PurchaseRecord; delivery: FlowDocView<'delivery'> };
/** 拼好、还没套模板的单据内容和它的记录 */
export type RawForm<K extends DocumentKind> = { form: BusinessForm; record: FormRecords[K] };
/** 套上模板的单据内容和它的记录 */
export type FormResult<K extends DocumentKind> = { form: TemplatedForm; record: FormRecords[K] };

/** 规格、尺寸、材质常常说的是同一件事（60*40*30cm 和 60 × 40 × 30 cm），单据上只留一份。 */
export const joinSpecification = (...values: (string | null | undefined)[]) => {
  const parts = values.flatMap((v) => (v ? v.split(' / ') : []));
  const kept: string[] = [];
  const key = (p: string) => p.replace(/\s+/g, '').replaceAll('×', 'x').toLowerCase();
  return parts
    .filter((p) => {
      if (kept.some((k) => sameSpecification(k, p) || key(k).includes(key(p)))) return false;
      kept.push(p);
      return true;
    })
    .join(' / ');
};
/** 订货单整份取消了，标题注明只供存档（送货单取消了不能导出，见 delivery-form.ts） */
const cancelledOnly = (record: FormRecords[DocumentKind]) => 'businessStatus' in record && record.businessStatus === '已取消';

/** 套上模板：不指定就用这类单据的默认模板；模板不是这类单据的或已移除报错。 */
export function templated<K extends DocumentKind>(
  store: Store,
  kind: K,
  { form, record }: RawForm<K>,
  templateId?: string,
): FormResult<K> {
  const state = new DocumentTemplateSettings(store).get(),
    template = state.templates.find((t) => t.id === (templateId || state.defaults[kind]) && t.kind === kind);
  if (!template) throw new AppError('模板与当前单据类型不一致或已移除。');
  return {
    record,
    form: applyDocumentTemplate(
      { ...form, title: form.title + (cancelledOnly(record) ? '（已取消，仅供存档）' : '') },
      template,
      state.revision,
    ),
  };
}
