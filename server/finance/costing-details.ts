/**
 * 成本计算的输入和执行明细：启用月填的期初成本、人填的出入库金额，
 * 和算完记进执行记录（fin_period_jobs.details）的明细。写入（costing.ts 的 commit，经 periodJob）和读出都按这里的结构核对。
 */
import { z } from 'zod';
import { accountCodeSchema, centsSchema } from '../../shared/finance/index.js';
import { parseStoredJson } from '../core/index.js';
import { costingItem, costingResidual, costingSale } from './costing-month.js';
import { id, label } from './query.js';

/** 某次成本计算的时间点：那次计算的时间，和当时库存流水的最大行号。 */
export type Mark = { ranAt: string; maxRowid: number };

/** 启用月已有库存的期初成本：库存品、单位、数量（要和流水结存对上）、金额 */
export const opening = z.strictObject({
  stockId: id,
  unit: label,
  quantity: z.number().int().nonnegative(),
  amount: centsSchema,
});
/** 人填的一笔出入库金额和对方科目 */
export const manual = z.strictObject({
  movementId: label,
  unit: label,
  amount: centsSchema,
  counterAccount: accountCodeSchema.optional(),
  reason: label,
});

/** 每笔出库、完工入库的成本和对方科目：[流水, 分, 科目]，以后月份冲销时按 SQL 的 $[0]、$[1]、$[2] 读 */
const costLink = z.tuple([z.string(), z.number(), z.string()]);
export type CostLink = z.output<typeof costLink>;

/**
 * 成本计算执行记录的明细：各库存品、销售成本、人填的金额、用掉的到票调差（b:发票:往来）和红票冲减（r:红票:往来）、
 * 出库和完工入库的成本、结清的余额、跨期补登的流水，和这次计算的时间、当时流水的最大行号（Mark）。
 */
export const costingDetails = z.object({
  rows: z.array(costingItem),
  sales: z.array(costingSale),
  valuations: z.array(manual),
  applied: z.array(z.string()),
  issues: z.array(costLink),
  receipts: z.array(costLink),
  residuals: z.array(costingResidual),
  late: z.array(z.string()),
  ranAt: z.string(),
  maxRowid: z.number(),
});
type CostingDetails = z.output<typeof costingDetails>;

/** 读某个月成本计算执行记录的明细 */
export function readCostingDetails(job: { period: string; details: string }): CostingDetails {
  return parseStoredJson(costingDetails, job.details, `fin_period_jobs.details（${job.period} 的成本计算）`);
}

/** 那次成本计算的时间点 */
export const markOf = (details: CostingDetails): Mark => ({ ranAt: details.ranAt, maxRowid: details.maxRowid });
