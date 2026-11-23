import { createHash } from 'node:crypto';

/**
 * 进事件快照的单据内容：单号以单据表的单号列为准（窗口的 sources.texts 给）。财务口径的内容不带单号，补进快照给财务各处显示；
 * 来源指纹不含这里补的单号（见 sourceHash）。
 */
export const withNumber = <T extends object>(doc: T, number: string | null): T =>
  number ? { ...doc, number } : doc;
/**
 * 来源指纹：状态、日期和算进指纹的内容的 sha256。判断“来源变没变”只看它。
 * counted 是窗口按约定取好的（server/flow/finance-facts/sources.ts 的 read，shared/business/flow/finance-source.ts 的
 * financeFingerprint）：归“算”的栏目、财务口径的名字，键排好序。只改说明、备注这类不算的栏目，版本号变了也不新增、
 * 替换、改动财务事件；业务改栏目名只改约定里的改名表，指纹不变。
 */
export const sourceHash = (source: { status: string; date: string }, counted: unknown) =>
  createHash('sha256').update(JSON.stringify({ status: source.status, date: source.date, doc: counted })).digest('hex');
