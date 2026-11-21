import { useState } from 'react';
import { ManagementDialog } from '../ui/index';
import { Combobox } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { useAction, useAuthState, useLoad } from '../ui/index';
import { today, fieldLabel } from '../../shared/core/index';
import { movementSchema, type StockItemView } from '../../shared/business/index';
import { readCatalog } from '../recordkit/catalog-api';
import { moveStock } from '../warehouse/stock-api';

const FORM_ID = 'stock-movement-form';
/** 操作类型：手动入库、手动出库、盘点调整（和服务端出入库规则同一组取值） */
type MoveAction = (typeof movementSchema.shape.action.options)[number];

/**
 * 手动入库、出库和盘点调整（库存页的“出入库 / 盘点”，数据管理里的库存品也打开它）。
 * 每笔都留原余额、变动量、结果余额和操作人。能关联的客户订单打开窗口时读（超级管理员模式连同已归档的）。
 */
export function MovementDialog({
  item,
  close,
  saved,
}: {
  item: Pick<StockItemView, 'id' | 'version' | 'name' | 'quantity' | 'unit'>;
  close: () => void;
  saved: () => void;
}) {
  const actor = useAuthState()?.actor;
  const [requestId] = useState(() => crypto.randomUUID()),
    [action, setAction] = useState<MoveAction>('in'),
    [quantity, setQuantity] = useState(''),
    [date, setDate] = useState(today()),
    [notes, setNotes] = useState(''),
    [orderId, setOrderId] = useState(''),
    [agreed, setAgreed] = useState(false);
  const all = !!actor?.superAdminMode;
  const ordersLoad = useLoad(String(all), () => readCatalog(['orders'], { all }).then((lists) => lists.orders));
  const orders = ordersLoad.data || [];
  const { busy, error, run } = useAction();
  const direct = !!actor?.localAdministrator;
  return (
    <ManagementDialog
      title={'出入库 / 盘点 · ' + item.name}
      subtitle={'当前库存 ' + item.quantity + ' ' + item.unit}
      size="md"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="每笔都记下原余额、变动量、结果余额和操作人。">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            form={FORM_ID}
            className="primary"
            disabled={busy || (!direct && !agreed)}
          >
            {busy ? '正在登记…' : '确认库存变动'}
          </button>
        </EditorFooter>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await moveStock(item, {
              expectedVersion: item.version,
              requestId,
              action,
              quantity,
              date,
              notes,
              customerOrderId: orderId ? Number(orderId) : null,
              acknowledged: true,
            });
            saved();
          });
        }}
      >
        <FormMessage>{error || ordersLoad.error}</FormMessage>
        <FormSection title="怎么变" columns={3}>
          <FormField label="操作类型">
            <select
              aria-label="操作类型"
              value={action}
              onChange={(e) => {
                const picked = movementSchema.shape.action.safeParse(e.target.value);
                if (picked.success) setAction(picked.data);
              }}
            >
              <option value="in">手动入库</option>
              <option value="out">手动出库</option>
              <option value="adjust">盘点调整</option>
            </select>
          </FormField>
          <FormField
            label={(action === 'adjust' ? '实盘数量' : '本次数量') + '（' + item.unit + '）'}
            required
            hint={action === 'adjust' ? '填盘点后的实际总数' : undefined}
          >
            <input
              aria-label={action === 'adjust' ? '实盘数量' : '本次数量'}
              required
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </FormField>
          <FormField label="业务日期" required>
            <input
              type="date"
              aria-label="业务日期"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </FormField>
        </FormSection>
        <FormSection title="为什么">
          <FormField label={action === 'adjust' ? '盘点原因' : '用途'} required span="full">
            <textarea
              aria-label="出入库用途 / 盘点原因"
              required
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormField>
          <FormField label={fieldLabel('customerOrderId')}>
            <Combobox
              ariaLabel={fieldLabel('customerOrderId')}
              placeholder="不关联"
              value={String(orderId)}
              onChange={setOrderId}
              options={[
                { value: '', label: '不关联' },
                ...orders.map((o) => ({
                  value: String(o.id),
                  label: o.number,
                  hint: o.customerName,
                })),
              ]}
            />
          </FormField>
        </FormSection>
        {!direct && (
          <label className="pur-agreement">
            <input
              type="checkbox"
              required
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            已核对实物和数量，确认登记这笔流水。
          </label>
        )}
      </form>
    </ManagementDialog>
  );
}

