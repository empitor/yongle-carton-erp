// 修改历史测试共用（record-history-view、record-history-audit）：给人看的文字检查、虚构的引用编号和名称。
import assert from 'node:assert/strict';
import type { HistoryView } from '../../shared/business/overview/record-history.js';
import type { HistoryRefs } from '../../shared/business/index.js';
import { historyFieldLabel } from '../../shared/business/overview/history-fields.js';

/** 给人看的文字里不能有英文键名、英文值、“草稿”、原始 JSON；尺寸的 mm / cm、面积的 m² 是界面写法，除外 */
export function assertClean(view: HistoryView, what: string, internalIds: number[] = []) {
  const texts = [...view.items.flatMap((i) => [i.label, i.value]), view.note || ''];
  for (const t of texts) {
    // 单号（DD-20261101-00001 这类）、导出文件的扩展名是界面上本来就有的写法
    const letters = t.replace(/mm|cm|m²/g, '').replace(/[A-Z]{2,4}-[0-9-]+/g, '').replace(/[.](docx|xlsx|pdf)$/g, '');
    assert.doesNotMatch(letters, /[A-Za-z]/, what + '：出现英文 “' + t + '”');
    assert.doesNotMatch(t, /草稿|[{}[\]"]|null|undefined|NaN/, what + '：出现内部写法 “' + t + '”');
    for (const id of internalIds) assert.ok(!t.includes(String(id)), what + '：露出内部编号 ' + id + ' “' + t + '”');
  }
}
/** 字段名跟着数据管理的名称表走，断言里不写死 */
export const L = (key: string, parent = '') => historyFieldLabel(key, parent) ?? assert.fail('字段 ' + key + ' 没有中文名');
export const row = (view: HistoryView, label: string) => view.items.filter((i) => i.label === label).map((i) => i.value);

// 虚构的引用编号取得特别，断言输出里看不到它们
export const C = 987601, P = 987602, S = 987603, O = 987604, T = 987605, F = 987606, SUP = 987607, SITE = 987608, GONE = 987699;
export const refs: HistoryRefs = {
  customers: { [C]: { name: '虚构客户甲' } },
  customer_sites: { [SITE]: { name: '虚构东厂' } },
  products: { [P]: { name: '虚构五金箱' } },
  stock_items: { [S]: { name: '虚构五层纸板', unit: '张' }, [F]: { name: '虚构五金箱', unit: '只' } },
  orders: { [O]: { name: 'DD-20261101-00001' } },
  flow: { [T]: { name: 'SC-20261106-00013' } },
  suppliers: { [SUP]: { name: '虚构纸板厂' } },
};
export const ids = [C, P, S, O, T, F, SUP, SITE, GONE];
