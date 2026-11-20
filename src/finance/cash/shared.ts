import type { Tone } from '../../ui/index';
import type { Field, FormValues } from '../form-values';
import { cashKindNames, cashMethods } from '../../../shared/finance/index';

/* 资金发票页各页签共用的名称和字段。 */

/**
 * 收付款的类型：一个类型一个叫法，列表、筛选、详情头部、编辑窗、提示都用这一个（不再有带括号举例的长名）。
 * “其他支出”管哪些，写在编辑窗类型下面的提示里。
 */
export const cashKinds = Object.entries(cashKindNames);
/** 是叫法表里的类型（只认表自己的键） */
const isCashKind = (k: unknown): k is keyof typeof cashKindNames =>
  typeof k === 'string' && Object.hasOwn(cashKindNames, k);
export const kindName = (k: unknown) => (isCashKind(k) ? cashKindNames[k] : String(k));
export const isPartyKind = (k: unknown) => k === 'receipt' || k === 'payment';
/** 核销记录里认转抵要看的几项 */
type AllocationLink = { id: number; reversal_of: number | null; voucher_id: number };
/** 多付转抵生成转出、转入两笔核销，共用一张对冲凭证；普通核销各有各的凭证。 */
export const transferPartner = <A extends AllocationLink>(rows: readonly A[], a: A) =>
  a.reversal_of
    ? undefined
    : rows.find((b) => b.id !== a.id && !b.reversal_of && b.voucher_id === a.voucher_id);
const methods = cashMethods.map((m) => [m, m] as const);
export const monthEnd = (y: string) => {
  const [a, b] = y.split('-').map(Number);
  return y + '-' + String(new Date(a, b, 0).getDate()).padStart(2, '0');
};

const isOther = (v: FormValues) => v.kind === 'income' || v.kind === 'outlay';
export const cashFields: Field[] = [
  {
    name: 'kind',
    label: '类型',
    type: 'select',
    required: true,
    options: cashKinds,
    section: '收付什么',
    hint: '房租、水电这类不是付给供应商货款的，选“其他支出”。',
  },
  { name: 'date', label: '日期', type: 'date', required: true, section: '收付什么' },
  { name: 'amount', label: '金额 / 元', type: 'money', required: true, section: '收付什么' },
  { name: 'method', label: '方式', type: 'select', required: true, options: methods, section: '收付什么' },
  {
    name: 'partyId',
    label: '往来单位',
    type: 'party',
    required: true,
    partyKind: (v) => (v.kind === 'receipt' ? 'customer' : 'supplier'),
    show: (v) => isPartyKind(v.kind),
    section: '和谁、走哪个账户',
  },
  {
    name: 'accountId',
    label: '资金账户',
    type: 'cash-account',
    required: true,
    section: '和谁、走哪个账户',
  },
  {
    name: 'targetAccountId',
    label: '转入账户',
    type: 'cash-account',
    required: true,
    show: (v) => v.kind === 'transfer',
    section: '和谁、走哪个账户',
  },
  {
    name: 'counterAccount',
    label: '对方科目',
    type: 'account',
    required: true,
    show: isOther,
    section: '和谁、走哪个账户',
  },
  {
    name: 'cashFlow',
    label: '现金流量项目',
    type: 'cash-flow',
    required: true,
    show: isOther,
    section: '和谁、走哪个账户',
  },
  { name: 'description', label: '说明', required: true, wide: true, section: '和谁、走哪个账户' },
];

export const invoiceStates: Record<string, string> = {
  draft: '待确认',
  normal: '已确认',
  red: '红字已确认',
  pending_certification: '待认证',
  certified: '已认证',
  nondeductible: '不可抵扣',
  void: '已作废',
};
const invoiceTone: Record<string, Tone> = {
  draft: 'neutral',
  normal: 'success',
  red: 'success',
  pending_certification: 'accent',
  certified: 'success',
  nondeductible: 'warning',
  void: 'danger',
};
/** 发票状态的叫法：表里没有的照原样写 */
export const invoiceStateName = (status: string) =>
  Object.hasOwn(invoiceStates, status) ? invoiceStates[status] : status;
/** 发票状态标签的颜色：表里没有的用中性色 */
export const invoiceStateTone = (status: string): Tone =>
  Object.hasOwn(invoiceTone, status) ? invoiceTone[status] : 'neutral';

export const noteStates = [
  ['endorsed', '背书转让'],
  ['discounted', '贴现'],
  ['matured', '到期承兑'],
  ['returned', '退票'],
] as const;
export const noteStatusName = (s: unknown) =>
  s === 'held' ? '持有中' : s === 'cancelled' ? '已作废' : (noteStates.find(([k]) => k === s)?.[1] ?? String(s));
/** 票据类型：应收票据、应付票据 */
export const noteKind = (r: { kind: string }) => (r.kind === 'receivable' ? '应收票据' : '应付票据');
