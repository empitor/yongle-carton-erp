import { useEffect, useState } from 'react';
import { managementRequest, useAuthState } from '../session';

const money = (c: unknown) =>
  c === null || c === undefined ? '—' : (Number(c) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
const statusName: Record<string, string> = {
  info_pending: '待补税率',
  ready: '待制单',
  generated: '已制单',
  difference: '有差异',
  awaiting_allocation_reversal: '待撤销核销',
};

/** 订单、送货详情里的财务状况。没有财务权限的账号看不到；没有财务记录时不显示。 */
export default function FinanceRelated({ kind, id }: { kind: 'orders' | 'delivery'; id: number }) {
  const auth = useAuthState();
  const can = !!auth?.actor?.permissions.includes('finance:view');
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (!can) return;
    let active = true;
    managementRequest<any>('/finance/related/' + kind + '/' + id)
      .then((r) => active && setRows(r.rows))
      .catch(() => active && setRows([]));
    return () => {
      active = false;
    };
  }, [can, kind, id]);
  if (!can || !rows.length) return null;
  return (
    <>
      <h3>财务</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>送货日期</th>
              <th>状态</th>
              <th>到期日</th>
              <th className="num">应收 / 元</th>
              <th className="num">已收 / 元</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id + ':' + i}>
                <td>{r.date}</td>
                <td>{statusName[r.status] || (r.voucher_id ? '已制单' : r.status)}</td>
                <td>{r.due_date || '没有账期'}</td>
                <td className="num">{money(r.obligation_amount)}</td>
                <td className="num">{money(r.paid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <a href="#finance-ar">到应收应付查看</a>
      </p>
    </>
  );
}
