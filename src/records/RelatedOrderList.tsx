import { FormMessage, Loading, Section, StatusChip, useLoad } from '../ui/index';
import { loadOrdersWhere, type OrdersWhere } from './list-api';
import Chain from './Chain';
import { orderDisplayStatus, pageHref } from '../../shared/core/index';
import { businessStatusTone } from '../recordkit/record-meta';

const SHOWN = 20;

/** 客户、产品详情最后一节：相关订单，点单号打开订单。 */
export default function RelatedOrderList({
  query,
  moreHref,
  moreLabel = '查看全部',
}: {
  query: OrdersWhere;
  /** 订单页按这条记录筛好的地址；有订单就显示，列表里最多列 20 张 */
  moreHref?: string;
  moreLabel?: string;
}) {
  const loaded = useLoad(JSON.stringify(query), () => loadOrdersWhere(query));
  // 换了条件：上一份不再显示
  const orders = loaded.loading || loaded.error ? null : loaded.data,
    error = loaded.loading ? '' : loaded.error;
  return (
    <Section
      title={'相关订单' + (orders ? ' ' + orders.length : '')}
      extra={
        orders && orders.length > 0 && moreHref ? (
          <a className="sales-section-link" href={moreHref}>
            {moreLabel}
          </a>
        ) : undefined
      }
    >
      {error ? (
        <FormMessage>{error}</FormMessage>
      ) : !orders ? (
        <Loading what="订单" />
      ) : !orders.length ? (
        <p className="sales-muted">还没有订单。</p>
      ) : (
        <ul className="sales-order-links">
          {orders.slice(0, SHOWN).map((o) => (
            <li key={o.id}>
              <a href={pageHref('orders', { order: o.id })}>{o.number}</a>
              <small>交期 {o.deliveryDate}</small>
              <Chain order={o} />
              <StatusChip tone={businessStatusTone(orderDisplayStatus(o))}>
                {orderDisplayStatus(o)}
              </StatusChip>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
