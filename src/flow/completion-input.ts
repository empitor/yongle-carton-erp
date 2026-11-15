import type { FlowApi } from '../../shared/business/index';
import { RAW_UNIT } from '../../shared/core/index';
import type { Allocation, Material } from './CompletionSections';
import type { CompletionRow } from './CompletionTasks';
import type { UntaskedRow } from './UntaskedCompletions';

/* 登记完工窗口（ProductionBatchDialog）交给服务端的正文：只算数据，不发请求、不依赖 React。 */

/** 登记完工的正文（核验、登记同一份） */
type CompletionBody = FlowApi['POST /flow/production-completion/preview']['body'];
/** 逐任务填的领退料：键是“任务编号:纸板编号” */
export type Distribution = Record<string, { issued: string; returned: string }>;
/** 窗口里填好的：完工日期、机台操作、勾选的任务（按加进来的先后）、不挂任务的几行、分配方式、批次备注、领料、逐任务分配 */
type CompletionFields = {
  date: string;
  operator: string;
  chosen: CompletionRow[];
  untasked: UntaskedRow[];
  allocation: Allocation;
  notes: string;
  materials: Material[];
  distribution: Distribution;
};

/** 逐任务填的分配：每张勾选的任务只列领用大于 0 的纸板 */
function explicitDistribution(f: CompletionFields) {
  return f.chosen.map((r) => ({
    taskId: r.id,
    materials: f.materials
      .filter((m) => Number(f.distribution[r.id + ':' + m.stockId]?.issued || 0) > 0)
      .map((m) => ({
        stockId: Number(m.stockId),
        issued: f.distribution[r.id + ':' + m.stockId].issued,
        returned: f.distribution[r.id + ':' + m.stockId].returned,
      })),
  }));
}

/**
 * 交给服务端的正文。pending：只登记、稍后核对入库（requestId 和直接入库的分开，重复提交同一种才算同一次）。
 * 只登记不挂任务的也行：没选任务时不传任务。
 */
export function completionInput(f: CompletionFields, requestId: string, pending: boolean): CompletionBody {
  return {
    requestId,
    ...(pending ? { pending: true } : {}),
    date: f.date,
    operator: f.operator,
    ...(f.chosen.length
      ? {
          taskIds: f.chosen.map((r) => r.id),
          quantities: f.chosen.map((r) => ({ taskId: r.id, goodQuantity: r.good, scrapQuantity: r.scrap })),
        }
      : {}),
    ...(f.untasked.length
      ? {
          untasked: f.untasked.map((u) => ({ productId: Number(u.productId), goodQuantity: u.good, scrapQuantity: u.scrap || '0' })),
        }
      : {}),
    allocation: f.allocation,
    notes: f.notes,
    materials: f.materials.map((m) => ({ ...m, stockId: Number(m.stockId), unit: RAW_UNIT })),
    ...(f.allocation === 'explicit' ? { distribution: explicitDistribution(f) } : {}),
  };
}
