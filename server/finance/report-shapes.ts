/**
 * 资产负债表、利润表、现金流量表的样子：report-sheets.ts 按它算；结账时三张一起存进
 * fin_report_snapshots.document（closing.ts 用 reportSnapshotText 写，写之前按这里核对），
 * 已结账月份看报表、结账归档打包时用 readReportSnapshot 读回来。
 */
import { z } from 'zod';
import { parseStoredJson } from '../core/index.js';
import type { snapshotKinds } from '../../shared/finance/index.js';

/** 报表一行点进去：这个科目这个月的明细账 */
const drill = z.strictObject({ kind: z.literal('detail'), period: z.string(), account: z.string() });
/** 几张表都有的：期间、项目和公式待财务复核、表名 */
const reportHead = { period: z.string(), needsReview: z.boolean(), name: z.string() };

/** 资产负债表一行：期末、期初（按科目方向取过正负） */
const balanceLine = z.strictObject({
  id: z.string(),
  name: z.string(),
  amount: z.number(),
  opening: z.number(),
  drill: z.array(drill),
});
const balanceReport = z.strictObject({
  ...reportHead,
  assets: z.array(balanceLine),
  liabilities: z.array(balanceLine),
  equity: z.array(balanceLine),
  totalAssets: z.number(),
  totalLiabilities: z.number(),
  totalEquity: z.number(),
  difference: z.number(),
  balanced: z.boolean(),
});
/** 利润表一行：本月、本年累计 */
const profitLine = z.strictObject({
  id: z.string(),
  name: z.string(),
  amount: z.number(),
  ytd: z.number(),
  drill: z.array(drill),
});
const profitReport = z.strictObject({
  ...reportHead,
  lines: z.array(profitLine),
  netProfit: z.number(),
  yearProfit: z.number(),
});
/** 现金流量表一行：一个现金流量项目在一个现金科目上的净额、几条分录，归哪类活动 */
const cashflowLine = z.strictObject({
  item: z.string().nullable(),
  account_code: z.string(),
  amount: z.number(),
  entries: z.number(),
  group: z.string(),
  drill,
});
const cashflowReport = z.strictObject({
  ...reportHead,
  lines: z.array(cashflowLine),
  opening: z.number(),
  total: z.number(),
  ending: z.number(),
  unclassified: z.array(cashflowLine),
});
/** 结账时存下的三张报表 */
const reportSnapshot = z.strictObject({ balance: balanceReport, profit: profitReport, cashflow: cashflowReport });

export type Drill = z.output<typeof drill>;
export type BalanceReport = z.output<typeof balanceReport>;
export type ProfitReport = z.output<typeof profitReport>;
export type CashflowReport = z.output<typeof cashflowReport>;
export type ReportSnapshot = z.output<typeof reportSnapshot>;
export type SnapshotKind = (typeof snapshotKinds)[number];

/** 写进 fin_report_snapshots.document 的文字：先按结构核对，对不上是程序算错了（服务端错误，不是用户填错） */
export function reportSnapshotText(document: ReportSnapshot): string {
  const checked = reportSnapshot.safeParse(document);
  if (!checked.success) throw new Error('报表快照和结构对不上：' + checked.error.message, { cause: checked.error });
  return JSON.stringify(document);
}

/** 读一份结账报表快照 */
export function readReportSnapshot(row: { period: string; version: number; document: string }): ReportSnapshot {
  return parseStoredJson(reportSnapshot, row.document, `fin_report_snapshots.document（${row.period} 第 ${row.version} 版）`);
}
