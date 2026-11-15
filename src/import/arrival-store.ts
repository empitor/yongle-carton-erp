import type { FlowDocView } from '../../shared/business/index';
import { flowInput, recognizedArrivalDraft } from '../../shared/business/index';
import type { ArrivalSource } from '../../shared/import/index';
import { arrivalDoc, batchReceiveRows, type ArrivalEditing } from './arrival-review';
import { readOrderBatch, receiveOrderBatch, saveArrivalDoc, type ArrivalCatalog } from './arrival-api';

/**
 * 到货识别结果怎么变成待核对的到货单、怎么登记成待入库的到货单（useArrivalDraft 用）。
 * 挂了订货单的按订货单登记（服务端按订货单分到各张采购单），选了“不挂采购单”的走单据流转的到货单接口。
 */
type Arrival = FlowDocView<'arrival'>;

/** 识别结果整理成待核对的到货单（已经登记的那张还待入库就接着改它）；没有识别结果是 null */
export function recognizedEditing(source: ArrivalSource, catalog: ArrivalCatalog, saved: Arrival | null) {
  const result = source.result;
  if (!result) return null;
  const next = recognizedArrivalDraft({ id: source.id, result }, catalog.suppliers, saved, catalog.batches);
  // 原文数量：识别结果里没写是 null；shared/business 的 recognizedArrivalDraft 收的识别结果类型宽，推出来还可能是 undefined
  const lines = next.draft.lines.map((l) => ({ ...l, statedQuantity: l.statedQuantity ?? null }));
  const editing: ArrivalEditing = { kind: 'arrival', ...next.draft, lines };
  return { warnings: next.warnings, editing };
}

/** 存的时候要的：AI 导入页的接口、这份识别文件、到货原件、这次登记的请求号（没办成再点沿用同一个） */
type StoreDeps = {
  /** 存好以后把识别文件关联到这张到货单（useOrderWorkspace 的 linkArrival） */
  link: (fileId: string, docId: number, sourceId: string | null) => Promise<unknown>;
  fileId: string;
  sourceId: string | null;
  requestId: { current: string };
};

/** 按订货单存成待入库的到货单（重新识别后改存原来那张）：用订货单的最新版本，每行对上订货单的行 */
async function storeByBatch(value: ArrivalEditing, batchId: number, deps: StoreDeps) {
  const batch = await readOrderBatch(batchId);
  const rows = batchReceiveRows(value.lines, batch);
  if (!rows) throw Error('有的纸板在订货单 ' + batch.number + ' 里对不上，请改选订货单或选“不挂采购单”。');
  const result = await receiveOrderBatch(batch, {
    expectedVersion: batch.version,
    requestId: deps.requestId.current,
    date: value.date,
    actualTime: value.actualTime ?? null,
    reference: value.reference,
    notes: value.notes || '',
    pending: true,
    sourceId: value.sourceId || deps.sourceId,
    rows,
    ...(value.id !== undefined && value.version !== undefined ? { arrival: { id: value.id, version: value.version } } : {}),
  });
  return result.arrival;
}

/** 登记或改写到货单（待入库），返回登记好的到货单：挂了订货单的按订货单登记，选了“不挂采购单”的走单据流转的到货单接口 */
export async function storeArrival(value: ArrivalEditing, deps: StoreDeps) {
  // withoutPurchase 只在核对时用，不存（整理成到货单内容时去掉）；不挂订货单的不带 orderBatchId
  const saved =
    value.orderBatchId != null
      ? await storeByBatch(value, value.orderBatchId, deps)
      : arrivalDoc(
          await saveArrivalDoc(value, {
            ...flowInput('arrival', { ...value, orderBatchId: undefined }),
            requestId: deps.requestId.current,
            version: value.version,
          }),
        );
  await deps.link(deps.fileId, saved.id, saved.sourceId || deps.sourceId);
  deps.requestId.current = crypto.randomUUID();
  return saved;
}
