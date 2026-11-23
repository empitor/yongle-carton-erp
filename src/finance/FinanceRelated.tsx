import { pageHref } from '../../shared/core/index';
import { Section, StatusChip, yuan } from '../ui/index';
import { useFinPerms, useFinRead, type FinData } from './fin-api';
import { FinStatusChip, RedInk } from './status';

/** 一张单据的一条财务记录：财务事件，和它挂的往来、已收付、冲销关系 */
type RelatedRow = FinData<'GET /finance/related/:kind/:id'>['rows'][number];

/** 红字冲销的两笔：原来那笔已冲销，冲销那笔记负数，两笔一起看不欠钱。 */
const reversalName: Record<string, string> = { reversed: '已冲销', reversal: '红字冲销' };

/** 状态标签：和应收逐笔一样，已冲销、红字冲销用中性色，红色只留给红字和负数金额。 */
function RowStatus({ row }: { row: RelatedRow }) {
  const reversal = row.reversal_state === null ? undefined : reversalName[row.reversal_state];
  if (reversal) return <StatusChip tone="neutral">{reversal}</StatusChip>;
  if (shownStatuses.has(row.status)) return <FinStatusChip value={row.status} />;
  return <FinStatusChip value={row.voucher_id ? 'generated' : row.status} />;
}

/** 这几种状态照状态词表显示（待补税率、可记账、已生成凭证、有差异、待撤销核销）；别的状态有凭证就写“已生成凭证”。 */
const shownStatuses = new Set([
  'info_pending',
  'ready',
  'generated',
  'difference',
  'awaiting_allocation_reversal',
]);

/** 订单、送货、到货详情里的财务状况（到货是应付一侧）。没有财务权限的账号看不到；没有财务记录时不显示。 */
export default function FinanceRelated({
  kind,
  id,
}: {
  kind: 'orders' | 'delivery' | 'arrival';
  id: number;
}) {
  const payable = kind === 'arrival';
  const can = useFinPerms().view;
  // 详情开着时确认、冲销了单据，财务这一段跟着重读（useFinRead 自己听业务数据变了）
  const { data, error } = useFinRead(can ? ['GET /finance/related/:kind/:id', { params: { kind, id } }] : null);
  // 读失败时不显示，不留上一张单的数据
  const rows = (!error && data?.rows) || [];
  // 没挂往来、也说不出状态的事件（比如已处理完、什么都没留下的）不显示，免得出现一整行“—”
  const shown = rows.filter(
    (r) => r.obligation_id != null || shownStatuses.has(r.status) || r.voucher_id,
  );
  if (!can || !shown.length) return null;
  return (
    <Section title="财务" extra={<a href={pageHref('finance-ar')}>到应收应付查看</a>}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>状态</th>
              <th className="num">{payable ? '应付 / 元' : '应收 / 元'}</th>
              <th className="num">{payable ? '已付 / 元' : '已收 / 元'}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.id + ':' + i}>
                {/* 红字冲销、重记的那笔写它自己那天，不写原单日期 */}
                {/* 日期不折行（用全站的 nowrap 工具类：详情卡片里的表格统一设了 white-space: normal，选择器很长，只有它压得住）；状态一格的“重记”“已冲销”标签和到期小字放不下时自己换行，不挤日期 */}
                <td className="nowrap">{r.obligation_date || r.date}</td>
                <td>
                  <span className="fin-pair">
                    {r.rerecorded !== 0 && <StatusChip tone="neutral">重记</StatusChip>}
                    <RowStatus row={r} />
                    {!r.reversal_state && (
                      <small>{r.due_date ? '到期 ' + r.due_date : '没有账期'}</small>
                    )}
                  </span>
                </td>
                <td className="num">
                  {r.obligation_amount !== null && r.obligation_amount < 0 ? (
                    <>
                      <RedInk /> <span className="fin-negative">{yuan(r.obligation_amount)}</span>
                    </>
                  ) : r.obligation_amount == null && r.amount_cents != null ? (
                    // 还没进往来（待补税率、还没生成凭证）：写单据的理论金额，标明是理论金额
                    <>
                      {yuan(r.amount_cents)}
                      <small>理论金额</small>
                    </>
                  ) : (
                    yuan(r.obligation_amount)
                  )}
                </td>
                <td className="num">{yuan(r.paid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
