import { uppercaseAmount } from '../core/index.js';
import { UNPRICED_TEXT } from '../business/index.js';
import {
  dateKeys,
  documentFields,
  numberKeys,
  ownKeys,
  termKeys,
  wideKeys,
} from './document-fields.js';
import type { DocumentKind } from './document-templates.js';
/** Word、Excel 和页面预览共用的单据版式规则。只重排字段位置，不改字段内容。 */
type LayoutForm = {
  number: string;
  fields: [string, string][];
  total?: string | null;
  draft: boolean;
  sample?: boolean;
};
/** 把表单字段拆成抬头、信息格、条款三块，字段内容不变。 */
export function splitFields(form: LayoutForm) {
  const fields = form.fields.map(([k, v]): [string, string] => [k, v || '未填写']);
  const number = fields.find(([k]) => numberKeys.includes(k))?.[1] || form.number,
    date = fields.find(([k]) => dateKeys.includes(k)),
    own = fields.filter(([k]) => ownKeys.includes(k)),
    terms = fields.filter(([k]) => termKeys.includes(k)),
    info = fields.filter(
      ([k]) => ![...numberKeys, ...dateKeys, ...ownKeys, ...termKeys].includes(k),
    );
  return { number, date, own, terms, info };
}
type InfoItem = { k: string; v: string; slots: number };
const printedNames = new Map(documentFields.map((f) => [f.key, f.label]));
/** 信息格（和模板设置里勾选隐藏的那一项）印出来的名字 */
export const printedInfoName = (key: string) => printedNames.get(key) ?? key;
/** 标准信息格由模板决定；缺少值仍保留位置，不随业务内容增减。 */
export function templateInfoFields(
  kind: DocumentKind,
  hidden: readonly string[] = [],
  companyAddress = '',
): string[] {
  return documentFields
    .filter(
      (f) =>
        f.zone === 'info' &&
        f.kinds.includes(kind) &&
        (!f.requiresCompanyAddress || Boolean(companyAddress)) &&
        !hidden.includes(f.key),
    )
    .map((f) => f.key);
}
/** 合计独占整行，不依赖明细金额列的位置；数值仅取单据记录。 */
export function totalLine(total: ReturnType<typeof totalParts>, last = true): string {
  if (!total) return '';
  return last ? `${total.label}　（小写）${total.amount}` : '合计金额（见最后一张）';
}
/**
 * 信息格按原字段顺序排，每行 perRow 格；地址占两格。地址放不下当前行时先让后面的短字段补位，
 * 一行末尾的字段补满剩余格。
 */
export function packInfo(info: [string, string][], perRow: number): InfoItem[][] {
  const rows: InfoItem[][] = [],
    deferred: InfoItem[] = [];
  let row: InfoItem[] = [],
    used = 0;
  const close = () => {
    if (row.length) {
      row[row.length - 1].slots += perRow - used;
      rows.push(row);
    }
    row = [];
    used = 0;
  };
  const place = (item: InfoItem) => {
    if (used + item.slots > perRow) close();
    row.push(item);
    used += item.slots;
    if (used < perRow) return;
    close();
    let next = deferred.at(0);
    while (next && used + next.slots <= perRow) {
      deferred.shift();
      row.push(next);
      used += next.slots;
      if (used === perRow) close();
      next = deferred.at(0);
    }
  };
  for (const [k, v] of info) {
    const item = { k: printedInfoName(k), v, slots: Math.min(perRow, wideKeys.includes(k) ? 2 : 1) };
    if (used > 0 && used + item.slots > perRow) deferred.push(item);
    else place(item);
  }
  for (let d = deferred.shift(); d; d = deferred.shift()) place(d);
  close();
  return rows;
}
export const draftText = (form: LayoutForm) =>
  form.sample ? '测试样张 · 非正式' : form.draft ? '预览 · 还没出库' : '';
/** 合计行文字：有确定金额才写大写；分以下有数时只写小写，不四舍五入。 */
export function totalParts(form: LayoutForm) {
  if (form.total === undefined) return null;
  if (form.total === null) return { label: '合计金额', amount: UNPRICED_TEXT };
  const upper = uppercaseAmount(form.total);
  return { label: upper ? '合计金额（大写）：' + upper : '合计金额', amount: form.total };
}
/** 五个字以内的标题拉开字距（用字距而不是插空格，单据里仍能搜到原标题）。 */
const SPACED_TITLE_MAX_CHARS = 5;
export const spacedTitle = (title: string) =>
  title.length <= SPACED_TITLE_MAX_CHARS && !/[（(]/.test(title);
