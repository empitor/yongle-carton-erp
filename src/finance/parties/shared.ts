/* 应收应付页各页签共用的名称。 */
import { financeRecordText } from '../../../shared/finance/index';
import type { ObligationRow } from './parties-api';

export type Kind = 'receivable' | 'payable';
export const kindWord = (kind: Kind) => (kind === 'receivable' ? '应收' : '应付');
export const advanceWord = (kind: Kind) => (kind === 'receivable' ? '预收款' : '预付款');
export const partyKindOf = (k: Kind) => (k === 'receivable' ? 'customer' : 'supplier');
/** 账期那几列（账期表、按单位的应收应付；没设账期的单位都是空的） */
type TermColumns = {
  term_type: string | null;
  term_days: number | null;
  term_months: number | null;
  payment_day: number | null;
  cutoff_day: number | null;
};
export const describeTerm = (r: TermColumns) =>
  r.term_type === 'monthly'
    ? '压 ' + r.term_months + ' 个月，每月 ' + r.payment_day + ' 号付' + (r.cutoff_day ? '，' + r.cutoff_day + ' 号截止' : '')
    : r.term_type === 'days'
      ? Number(r.term_days) > 0
        ? '压 ' + r.term_days + ' 天'
        : '当天到期（压 0 天）'
      : '没有账期';
/**
 * 往来来自哪里：送货、到货的写单号；没有单据的按服务端给的 record_kind 写叫法——期初往来写“期初往来”，
 * 压款利息写“压款利息 11-30 0.10”（和月度台账、凭证来源同一种写法）；手工新建的写 fallback。
 */
export const obligationSource = (
  r: Pick<ObligationRow, 'source_number' | 'record_kind' | 'date' | 'amount_cents'>,
  fallback: string,
): string =>
  r.source_number ||
  (r.record_kind === 'interest'
    ? financeRecordText('interest', r.date, r.amount_cents)
    : r.record_kind === 'opening'
      ? '期初往来'
      : fallback);
