import { FormMessage } from '../ui/index';
import type { deliveryBlockers } from '../../shared/business/index';

type Blocker = ReturnType<typeof deliveryBlockers>[number];

/** 有订单、有库存却排不了送货时说清原因：订单还没确认、规格不一致。 */
export default function DeliveryBlockers({ blockers }: { blockers: Blocker[] }) {
  // 同一条订单明细可能被几个同产品的库存品各报一次，只列一次
  const list = [...new Map(blockers.map((b) => [b.orderLineId + '|' + b.kind, b])).values()];
  if (!list.length) return null;
  return (
    <FormMessage tone="warning">
      <strong>这些订单在等这批货，但现在对不上：</strong>
      <ul className="help-list delivery-blockers">
        {list.map((b) => (
          <li key={b.orderLineId + b.kind}>
            {b.orderNumber} · {b.productName}：{b.text}
          </li>
        ))}
      </ul>
    </FormMessage>
  );
}
