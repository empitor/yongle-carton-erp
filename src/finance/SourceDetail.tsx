import { useAuthState, ActionBar, Facts, Hint, Section, StatusChip, type RecordAction, yuan } from '../ui/index';
import { financeOnlyAccount, flowDocHref, pageHref, pageIdOf, plainPrice } from '../../shared/core/index';
import { missingAmountName } from '../../shared/finance/index';
import { documentName, metricNames, sourceMonthName } from './labels';
import { chipTones, flowStatus } from './status';
import { readSourceDetail, type SourceLine, type SourceRow } from './source-detail-view';

/** 概览下钻和月度台账的详情头部：类型、单号、状态，下面一行写往来单位和日期。 */
export function sourceHeader(row: SourceRow) {
  const [text, tone] = flowStatus(row);
  return {
    kicker: metricNames[row.metric] || '单据',
    title: documentName(row),
    subtitle: [row.party, row.date].filter(Boolean).join(' · '),
    status: <StatusChip tone={chipTones[tone] ?? 'neutral'}>{text}</StatusChip>,
  };
}

/** 打开收付款单（财务资金页） */
const cashLink = (cashId: number) => ({
  label: '打开收付款单',
  href: pageHref('finance-cash', { tab: 'documents', cash: cashId }),
});

/**
 * 原单在哪：接单打开订单，送货、到货打开送货单、到货单；收付款打开收付款单，手工凭证打开凭证。
 * 业务单据只给能看业务的账号（纯财务账号打不开业务页面，不给死链）。
 */
function sourceLink(row: SourceRow, business: boolean): { label: string; href: string } | null {
  const detail = readSourceDetail(row.detail);
  const sourceId = row.source_id ?? '';
  if (row.metric === 'ordered') {
    const id = Number(sourceId);
    return business && Number.isSafeInteger(id) && id > 0 ? { label: '打开订单', href: pageHref('orders', { order: id }) } : null;
  }
  const receivable = ['theoreticalIncome', 'actualIncome', 'discountExpense'].includes(row.metric);
  if (business && sourceId) return businessDocLink(receivable ? 'delivery' : 'arrival', sourceId);
  if (detail.cashId) return cashLink(detail.cashId);
  if (detail.voucherId) return { label: '打开凭证', href: pageHref('finance-ledger', { voucher: detail.voucherId }) };
  return null;
}

/** 打开送货单、到货单（业务页面的地址）；别的来源没有单据页面 */
export function businessDocLink(kind: unknown, id: unknown): { label: string; href: string } | null {
  const doc = Number(id);
  if (!Number.isSafeInteger(doc) || doc <= 0) return null;
  if (kind === 'delivery') return { label: '打开送货单', href: flowDocHref('delivery', doc) };
  if (kind === 'arrival') return { label: '打开到货单', href: flowDocHref('arrival', doc) };
  return null;
}

/** 纯财务账号打不开业务页面，不给它们死链 */
export function useBusinessAccount() {
  const auth = useAuthState();
  return !!auth?.actor && !financeOnlyAccount(auth.actor);
}

/** 详情头部的操作：打开原单；收付款行另给收付款单。 */
export function SourceActions({ row, primary }: { row: SourceRow; primary?: RecordAction | null }) {
  const link = sourceLink(row, useBusinessAccount());
  const { cashId } = readSourceDetail(row.detail);
  const cash = cashId && pageIdOf(link?.href ?? '') !== 'finance-cash' ? cashLink(cashId) : null;
  return (
    <ActionBar
      primary={primary ? [primary] : []}
      secondary={[...(link ? [link] : []), ...(cash ? [cash] : [])]}
    />
  );
}

/** 单据明细的一行：品名、数量和单位、单价、税率和口径 */
function SourceLineRow({ line: l }: { line: SourceLine }) {
  return (
    <tr>
      <td>{l.productName || l.item?.name || l.name || '—'}</td>
      <td className="num">
        {l.stockedQuantity ?? l.quantity ?? '—'} {l.unit || l.item?.unit || ''}
      </td>
      <td className="num">
        {l.unitPriceExact !== undefined ? plainPrice(l.unitPriceExact, 2) : (l.unitPrice ?? '—')}
      </td>
      <td>
        {l.taxRate || <span className="fb-warn">税率未填</span>}
        <small>{l.taxMode || '口径未填'}</small>
      </td>
    </tr>
  );
}

/** 下钻明细的来源单据，给人看的字段，不依赖内部结构细节。 */
export function SourceDetail({ row }: { row: SourceRow }) {
  const detail = readSourceDetail(row.detail);
  const source = detail.source ?? detail;
  const lines = source.doc?.lines ?? [];
  const warnings = source.warnings ?? [];
  return (
    <>
      {warnings.length > 0 && <Hint tone="warning">{warnings.join(' ')}</Hint>}
      <Section title="基本信息">
        <Facts
          items={[
            { label: '类型', value: metricNames[row.metric] || row.metric },
            { label: '日期', value: row.date },
            { label: '单号', value: documentName(row) },
            { label: '往来单位', value: row.party },
            {
              label: '金额',
              // 没算进理论金额的照明细写缺的是什么：缺数量或单位、缺价格
              value: row.amount === null ? missingAmountName(row.detail) + '，未计入' : yuan(row.amount) + ' 元',
            },
            { label: '单据月份', value: sourceMonthName(row.source_month) },
            { label: '到期日', value: row.due_date, hidden: !row.due_date },
            { label: '已收付', value: yuan(row.paid) + ' 元', hidden: !row.paid },
            { label: '说明', value: detail.description, wide: true, hidden: !detail.description },
          ]}
        />
      </Section>
      {lines.length > 0 && (
        <Section title="单据明细">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>品名</th>
                  <th className="num">数量</th>
                  <th className="num">单价</th>
                  <th>税率</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <SourceLineRow key={i} line={l} />
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}
