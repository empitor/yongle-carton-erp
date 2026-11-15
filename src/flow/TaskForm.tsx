import { FINISHED_UNIT } from '../../shared/core/index';
import { pendingOrder, type FlowDocView } from '../../shared/business/index';
import { FormField, FormGroup, FormSection } from '../ui/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import Select from './Select';
import { dateInput as date, timeInput as time } from './form-inputs';

/** 编辑窗里的生产任务：已有任务的副本，产品可能清空了还没重选 */
export type TaskEditing = Omit<FlowDocView<'task'>, 'productId'> & { productId: number | null };
/** 生产任务表单要对照的档案：订单、产品 */
export type TaskFormData = Pick<CatalogLists, 'orders' | 'products'>;

/** 生产任务编辑窗：生产什么、什么时候做、给哪张订单做。 */
export default function TaskForm({
  value: v,
  change,
  data,
}: {
  value: TaskEditing;
  change: (patch: Partial<TaskEditing>) => void;
  data: TaskFormData;
}) {
  const taskOrders = data.orders.filter((o) => pendingOrder(o) && o.lines.some((l) => l.productId === v.productId));
  return (
    <>
      <FormSection title="生产什么">
        <Select
          label="产品"
          required
          span="full"
          value={v.productId}
          options={data.products}
          onChange={(productId) => change({ productId, orderIds: [] })}
        />
        <FormField label="计划数量" required hint="单位要和订单一致，否则不算进订单的生产量">
          <div className="form-inline">
            <input
              aria-label="计划生产数量"
              inputMode="decimal"
              value={v.quantity}
              onChange={(e) => change({ quantity: e.currentTarget.value })}
            />
            <span className="unit-fixed" aria-label="成品计量单位">
              {FINISHED_UNIT}
            </span>
          </div>
        </FormField>
      </FormSection>
      <FormSection title="什么时候做" columns={3}>
        <FormField label="计划生产日期" required>
          {date(v.plannedDate || v.date, (plannedDate) => change({ plannedDate }), '计划生产日期')}
        </FormField>
        <FormField label="计划时间" hint="选填">
          {time(v.plannedTime, (plannedTime) => change({ plannedTime }), '计划生产时间')}
        </FormField>
        <FormField label="登记日期" required>
          {date(v.date, (d) => change({ date: d }), '任务登记日期')}
        </FormField>
      </FormSection>
      <FormSection title="给哪张订单做" hint="可以多选；不选就是独立备货生产。" columns={1}>
        <FormGroup>
          {taskOrders.length ? (
            <div className="choice-list">
              {taskOrders.map((o) => (
                <label key={o.id}>
                  <input
                    type="checkbox"
                    checked={v.orderIds.includes(o.id)}
                    onChange={(e) =>
                      change({
                        orderIds: e.currentTarget.checked ? [...v.orderIds, o.id] : v.orderIds.filter((id) => id !== o.id),
                      })
                    }
                  />
                  <span>
                    {o.number} · {o.customerName}
                  </span>
                  <small>{o.deliveryDate ? '交期 ' + o.deliveryDate : o.status}</small>
                </label>
              ))}
            </div>
          ) : (
            <p className="choice-list-empty">
              {v.productId ? '这个产品没有待生产的订单，保存后按独立备货生产。' : '先选产品，再选订单。'}
            </p>
          )}
        </FormGroup>
      </FormSection>
    </>
  );
}
