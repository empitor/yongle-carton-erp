import { uppercaseAmount } from './display-amount.js';
/** Word、Excel 和页面预览共用的单据版式规则。只重排字段位置，不改字段内容。 */
type LayoutForm = {
  number: string;
  fields: [string, string][];
  total?: string | null;
  draft: boolean;
  sample?: boolean;
};
/** 单号、日期放右上角，我方资料放抬头下方，条款放明细之后，其余进客户/供应商信息格。 */
export const numberKeys = ['采购单号', '送货单号'],
  dateKeys = ['下单日期', '实际送货日期', '预计送货日期'],
  ownKeys = ['我方联系人', '我方地址'],
  termKeys = ['交货要求', '验收要求', '付款条件', '税费说明'],
  wideKeys = ['收货地址', '交货地址'];
/** 把表单字段拆成抬头、信息格、条款三块，字段内容不变。 */
export function splitFields(form: LayoutForm) {
  const fields = form.fields.map(([k, v]) => [k, v || '未填写'] as [string, string]);
  const number = fields.find(([k]) => numberKeys.includes(k))?.[1] || form.number,
    date = fields.find(([k]) => dateKeys.includes(k)),
    own = fields.filter(([k]) => ownKeys.includes(k)),
    terms = fields.filter(([k]) => termKeys.includes(k)),
    info = fields.filter(
      ([k]) => ![...numberKeys, ...dateKeys, ...ownKeys, ...termKeys].includes(k),
    );
  return { number, date, own, terms, info };
}
export type InfoItem = { k: string; v: string; slots: number };
/** 标准信息格由模板决定；缺少值仍保留位置，不随业务内容增减。 */
export function templateInfoFields(
  kind: 'purchase' | 'delivery',
  hidden: readonly string[] = [],
  companyAddress = '',
): string[] {
  const keys =
    kind === 'purchase'
      ? ['供应商', '供应商联系信息', '预计交货日期', ...(companyAddress ? ['交货地址'] : [])]
      : ['客户', '收货地址', '客户联系信息', '关联销售订单', '客户采购订单号'];
  return keys.filter((key) => !hidden.includes(key));
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
    while (deferred.length && used + deferred[0].slots <= perRow) {
      const d = deferred.shift()!;
      row.push(d);
      used += d.slots;
      if (used === perRow) close();
    }
  };
  for (const [k, v] of info) {
    const item = { k, v, slots: Math.min(perRow, wideKeys.includes(k) ? 2 : 1) };
    if (used > 0 && used + item.slots > perRow) deferred.push(item);
    else place(item);
  }
  while (deferred.length) place(deferred.shift()!);
  close();
  return rows;
}
export const draftText = (form: LayoutForm) =>
  form.sample ? '测试样张 · 非正式' : form.draft ? '计划单 · 非正式' : '';
/** 合计行文字：有确定金额才写大写；分以下有数时只写小写，不四舍五入。 */
export function totalParts(form: LayoutForm) {
  if (form.total === undefined) return null;
  if (form.total === null) return { label: '合计金额', amount: '待核价' };
  const upper = uppercaseAmount(form.total);
  return { label: upper ? '合计金额（大写）：' + upper : '合计金额', amount: form.total };
}
/** 五个字以内的标题拉开字距（用字距而不是插空格，单据里仍能搜到原标题）。 */
export const spacedTitle = (title: string) => title.length <= 5 && !/[（(]/.test(title);
