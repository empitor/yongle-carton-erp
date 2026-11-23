import type { z } from 'zod';
import type { FlowDocView, productionCorrectionPreviewSchema } from '../../shared/business/index';

/**
 * 更正完工单的输入：整理成服务端 POST /api/flow/:id/correction-preview、/correct 要的格式
 * （shared/business/flow/flow-correction.ts 的 productionCorrectionPreviewSchema）。只算数据，不发请求、不依赖 React。
 *
 * - 合格、报废改了才写。领料只要有一处变了（改数、换纸板、加行、删行）就写更正后的整张领料表：
 *   带 index 的是原单那一行（换了纸板另写 stockId），不带的是新加的行（要 stockId）。
 * - 完工日期、产品、挂哪张生产任务只有本机管理员能改；不挂任务写 null。
 */

/** 交给服务端的输入（核验、提交同一份；提交时另加请求号和预览摘要） */
type ProductionCorrectionBody = z.input<typeof productionCorrectionPreviewSchema>;
type BodyMaterial = NonNullable<ProductionCorrectionBody['materials']>[number];
type Production = FlowDocView<'production'>;
/** 完工单里用到的：版本、日期、合格、报废、产品、生产任务，每种领料的纸板、领用、退料 */
type ProductionSource = Pick<Production, 'version' | 'date' | 'goodQuantity' | 'scrapQuantity' | 'productId' | 'taskId'> & {
  materials: Pick<Production['materials'][number], 'stockId' | 'issued' | 'returned'>[];
};

export type MaterialRow = { index?: number; stockId: number | null; issued: string; returned: string };
export type ProductionHead = {
  good: string;
  scrap: string;
  date: string;
  productId: number | null;
  taskId: number | null;
};

const text = (v: unknown) => (v == null ? '' : String(v));

export const productionHead = (doc: ProductionSource): ProductionHead => ({
  good: text(doc.goodQuantity),
  scrap: text(doc.scrapQuantity),
  date: text(doc.date),
  productId: doc.productId,
  taskId: doc.taskId,
});
export const materialRows = (doc: ProductionSource): MaterialRow[] =>
  doc.materials.map((m, index) => ({
    index,
    stockId: m.stockId,
    issued: text(m.issued),
    returned: text(m.returned),
  }));
export const newMaterialRow = (): MaterialRow => ({ stockId: null, issued: '', returned: '0' });

/** 更正后的整张领料表，和它跟原单比有没有变 */
function materialsInput(doc: ProductionSource, rows: MaterialRow[]) {
  const original = doc.materials;
  let changed = rows.length !== original.length;
  const list = rows.map((r): BodyMaterial => {
    const o = r.index === undefined ? null : original[r.index];
    // 换了纸板（或新加的行）：写选了的纸板
    const swapped = !o || r.stockId !== o.stockId;
    if (swapped) changed = true;
    const issued = r.issued.trim(),
      returned = r.returned.trim() || '0';
    if (o && (issued !== text(o.issued) || returned !== text(o.returned))) changed = true;
    return { ...(o ? { index: r.index } : {}), ...(swapped && r.stockId != null ? { stockId: r.stockId } : {}), issued, returned };
  });
  return { list, changed };
}

/** 交给服务端的输入，和这次有没有改东西（没改不去核验） */
export function productionCorrectionInput(
  doc: ProductionSource,
  head: ProductionHead,
  rows: MaterialRow[],
  reason: string,
): { input: ProductionCorrectionBody; changed: boolean } {
  const top: Omit<ProductionCorrectionBody, 'expectedVersion' | 'reason'> = {};
  if (head.good.trim() !== text(doc.goodQuantity)) top.goodQuantity = head.good.trim();
  if (head.scrap.trim() !== text(doc.scrapQuantity)) top.scrapQuantity = head.scrap.trim() || '0';
  const materials = materialsInput(doc, rows);
  if (materials.changed) top.materials = materials.list;
  if (head.date && head.date !== text(doc.date)) top.date = head.date;
  if (head.productId != null && head.productId !== doc.productId) top.productId = head.productId;
  if (head.taskId !== doc.taskId) top.taskId = head.taskId;
  return { input: { expectedVersion: doc.version, reason: reason.trim(), ...top }, changed: Object.keys(top).length > 0 };
}
