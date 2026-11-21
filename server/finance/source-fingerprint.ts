import { createHash } from 'node:crypto';
import { financialContent } from '../../shared/business/index.js';

/**
 * 进事件快照的单据内容：单号以单据表的单号列为准（窗口的 sources.texts 给）。财务口径的内容不带单号，补进快照给财务各处显示；
 * 来源指纹不含这里补的单号（见 sourceHash）。
 */
export const withNumber = <T extends object>(doc: T, number: string | null): T =>
  number ? { ...doc, number } : doc;
/**
 * 来源指纹：状态、日期和财务用得到的单据内容的 sha256。判断“来源变没变”只看它。
 * 算进去的栏目和去掉的理由归业务管（shared/business/finance-source.ts 的 financeFieldClasses、financialContent）：
 * 只改说明、备注这类不算的栏目，版本号变了也不新增、替换、改动财务事件。
 * doc 是业务的完整内容，或窗口按 financialContent 取好的（sources.read 的 counted）：再取一遍结果不变，指纹一样。
 */
export const sourceHash = (source: { kind: string; status: string; date: string }, doc: unknown) =>
  createHash('sha256')
    .update(JSON.stringify({ status: source.status, date: source.date, doc: financialContent(source.kind, doc) }))
    .digest('hex');
