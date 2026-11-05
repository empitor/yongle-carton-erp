import { useEffect, useState } from 'react';
import { managementRequest } from './session';
import StatusBadge from './StatusBadge';
import Chain from './ui/Chain';

const SHOWN = 20;
/** 客户、产品详情里的相关订单。 */
export default function RelatedOrders({ query, moreHref }: { query: string; moreHref?: string }) {
  const [orders, setOrders] = useState<any[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    managementRequest<any[]>('/orders?' + query)
      .then((rows) => active && setOrders(rows))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [query]);
  if (error) return <p className="form-error">{error}</p>;
  if (!orders) return <p className="sub">正在读取订单…</p>;
  return (
    <section className="related-orders">
      <h3>相关订单（{orders.length}）</h3>
      {orders.slice(0, SHOWN).map((o) => (
        <a className="queue-row" href={'#orders?order=' + o.id} key={o.id}>
          <span className="record-no">{o.number}</span>
          <span className="queue-main">交期 {o.deliveryDate}</span>
          <Chain order={o} />
          <StatusBadge status={o.status} />
        </a>
      ))}
      {!orders.length && <p className="sub">还没有订单。</p>}
      {orders.length > SHOWN && moreHref && <a href={moreHref}>查看全部 {orders.length} 张</a>}
    </section>
  );
}
