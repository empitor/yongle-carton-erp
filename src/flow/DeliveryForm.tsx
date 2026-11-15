import { FormField, FormSection } from '../ui/index';
import DeliveryStockPicker from './DeliveryStockPicker';
import Select from './Select';
import type { DeliveryEditing, DeliveryFormData } from './delivery-stock';
import { dateInput as date, timeInput as time } from './form-inputs';

/**
 * 编辑已有的送货单：送给谁、什么时候送、送哪些货。导出送货单时才出库。
 * 新建送货只有“安排送货”窗口（src/warehouse/DeliveryPlanDialog.tsx）。
 */
export default function DeliveryForm({
  value: v,
  change,
  data,
}: {
  value: DeliveryEditing;
  change: (patch: Partial<DeliveryEditing>) => void;
  data: DeliveryFormData;
}) {
  return (
    <>
      <FormSection title="送给谁">
        <Select
          label="客户"
          required
          span="full"
          value={v.customerId}
          options={data.customers}
          onChange={(customerId) => {
            const c = data.customers.find((c) => c.id === customerId);
            // 换了客户：成品留着，原来挂的订单明细和数量清掉重选
            change({
              customerId,
              address: c?.address || '',
              contact: c?.contact || '',
              phone: c?.phone || '',
              lines: v.lines.filter((l) => l.stockId).map((l) => ({ ...l, orderId: null, orderLineId: null, quantity: '' })),
            });
          }}
        />
        <FormField label="收货地址" span="full">
          <input aria-label="收货地址" value={v.address} onChange={(e) => change({ address: e.currentTarget.value })} />
        </FormField>
        <FormField label="收货联系人">
          <input aria-label="收货联系人" value={v.contact} onChange={(e) => change({ contact: e.currentTarget.value })} />
        </FormField>
        <FormField label="联系方式">
          <input aria-label="联系方式" value={v.phone} onChange={(e) => change({ phone: e.currentTarget.value })} />
        </FormField>
      </FormSection>
      {/* 安排送货只定计划；实际发货日是导出送货单出库的那天（已出库的改日期走“更正送货单”） */}
      <FormSection title="什么时候送" columns={2}>
        <FormField label="计划送货日期" required>
          {date(v.plannedDate || v.date, (plannedDate) => change({ plannedDate }), '计划送货日期')}
        </FormField>
        <FormField label="计划时间" hint="选填">
          {time(v.plannedTime, (plannedTime) => change({ plannedTime }), '预计送货时间')}
        </FormField>
      </FormSection>
      <DeliveryStockPicker value={v} data={data} change={change} />
    </>
  );
}
