import { orderTaxText } from '../../shared/business/index';
import { canEditBusiness, useAuthState } from '../ui/index';
import RelatedBusiness from './RelatedBusiness';
import { Facts, Hint, Section } from '../ui/index';
import { fieldLabel } from '../../shared/core/index';
import OrderLinesView, { ORDER_LINES_TITLE } from '../recordkit/OrderLinesView';
import { useProductFamily } from '../recordkit/useProductFamily';
import { useRecordContext } from '../recordkit/record-meta';
import { productionHint, productionReasons } from './order-production';
import { useRelatedData, type Related, type RelatedData } from './useRelatedData';
import { orderAmount, type RecordRowOf } from './record-rows';

type OrderRow = RecordRowOf['orders'];

/** 只有“生产中”的订单才读生产任务，用来说明为什么任务做完了订单还没往下走；详情面板已经读了就用它那份。 */
function useProductionRelated(row: OrderRow, enabled: boolean, given: RelatedData | null | undefined) {
  const own = useRelatedData('orders', row, enabled && !given);
  return enabled ? given || own.data : null;
}

/** 订单详情正文：下一步、提示 → 明细和进度 → 基本信息 → 关联单据。 */
export default function OrderDetail({ row, related }: { row: OrderRow; related?: Related }) {
  useRecordContext('orders', row.id, row.number);
  const auth = useAuthState(),
    canEdit = canEditBusiness(auth);
  const production = useProductionRelated(
    row,
    canEdit && row.status === '生产中' && !row.archived,
    related?.data,
  );
  const hint = productionHint(productionReasons(row, production));
  const family = useProductFamily();
  return (
    <RelatedBusiness entity="orders" row={row} related={related}>
      <div
        className="sales-order-detail"
        data-agent-module="orders"
        data-agent-record={row.id}
        data-agent-label={row.number}
      >
        {hint && <Hint tone="warning">{hint}</Hint>}
        <Section
          title={ORDER_LINES_TITLE}
          extra={<span className="sales-section-sum">合计 ¥{orderAmount(row)}</span>}
        >
          <OrderLinesView
            row={row}
            progress={new Map((related?.plan?.lines || []).map((l) => [l.id, l]))}
            family={family}
          />
        </Section>
        <Section title="基本信息">
          <Facts
            items={[
              { label: '客户', value: row.customerName },
              { label: '客户采购单号', value: row.externalPurchaseOrder },
              { label: fieldLabel('orderDate'), value: row.orderDate },
              { label: '交货日期', value: row.deliveryDate },
              {
                label: '金额',
                value:
                  orderAmount(row) +
                  (row.currency && row.currency !== 'CNY' ? ' ' + row.currency : ' 元'),
              },
              {
                label: '税费',
                value: orderTaxText(row),
              },
              { label: '供应方', value: row.supplierName, hidden: !row.supplierName },
              { label: '合同条件', value: row.terms, wide: true, hidden: !row.terms },
              { label: '备注', value: row.notes, wide: true },
            ]}
          />
        </Section>
      </div>
    </RelatedBusiness>
  );
}
