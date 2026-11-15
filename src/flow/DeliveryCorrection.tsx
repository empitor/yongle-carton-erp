import { useState } from 'react';
import { pendingOrder } from '../../shared/business/index';
import { finishedUnit } from '../../shared/core/index';
import { FormField, FormSection, RowDelete, useAuthState, useLoad } from '../ui/index';
import { readCatalog } from '../recordkit/catalog-api';
import { AddRow, CorrectionTable, CorrectQuantity } from './CorrectionParts';
import CorrectionShell from './CorrectionShell';
import { Overdelivery } from './DeliveryStockPicker';
import Select from './Select';
import { deliveryCorrectionInput, deliveryHead, deliveryRows, newDeliveryRow, type DeliveryHead, type DeliveryRow } from './delivery-correction';
import { dateInput } from './form-inputs';
import { useCorrection, useCorrectionRows, type CorrectionPartProps } from './useCorrection';

/** 订单清单（每行的产品和订单号、管理员换挂和加行的候选，都按订单明细找） */
type Orders = Awaited<ReturnType<typeof readCatalog<'orders'>>>['orders'];

/** 一条订单明细在窗口里怎么叫：产品 · 订单号，后面小字订了多少 */
function orderLineOf(orders: Orders, orderLineId: number | null) {
  for (const order of orders) for (const line of order.lines) if (line.id === orderLineId) return { order, line };
  return null;
}

/**
 * 更正送货单的几栏：业务账号改每行数量、删掉没发的行（至少留一行）；本机管理员另能改出库日期、换挂订单明细、加行；
 * 超级管理员模式下增加数量超出订单剩余的要勾“超订单数量发货”并写原因。外壳、核验和提交在 CorrectionShell、useCorrection。
 */
export default function DeliveryCorrection(part: CorrectionPartProps<'delivery'>) {
  const doc = part.doc;
  const auth = useAuthState(),
    admin = !!auth?.actor?.localAdministrator,
    superMode = !!auth?.actor?.superAdminMode;
  const [head, setHead] = useState(() => deliveryHead(doc));
  const { rows, setRows, patch } = useCorrectionRows(() => deliveryRows(doc), doc.lines);
  const catalog = useLoad('delivery-correction', () => readCatalog(['orders']));
  const orders = catalog.data?.orders ?? [];
  const c = useCorrection(part, (reason) => deliveryCorrectionInput(doc, head, rows, reason));
  const busy = c.busy;
  const changeHead = (p: Partial<DeliveryHead>) => setHead((h) => ({ ...h, ...p }));
  const name = (r: DeliveryRow) => {
    const o = r.index === undefined ? null : doc.lines[r.index],
      found = orderLineOf(orders, r.orderLineId);
    return {
      product: found?.line.productName || o?.productName || '新加的一行',
      order: found?.order.number || o?.orderNumber || '',
      unit: finishedUnit(found?.line.unit || o?.unit),
    };
  };
  return (
    <CorrectionShell
      kind="delivery"
      subtitle={[doc.number, doc.customerName, doc.date].filter(Boolean).join(' · ')}
      hint="整张没发生用“撤销这次送货”，数量登记错了才用更正。"
      placeholder="例如：实际只送了 550 只，原登记误填 600 只"
      correction={c}
      loadError={catalog.error}
      close={part.close}
    >
      <FormSection title="改成多少" hint="其实没发的那一行删掉；出库日期和送达记录照旧" columns={1}>
        <CorrectionTable first="产品 · 订单号" extra={<th aria-label="删掉这一行" />}>
          {rows.map((r, i) => {
            const o = r.index === undefined ? null : doc.lines[r.index],
              n = name(r);
            return (
              <tr key={i}>
                <td className="wh-cell-text">
                  {n.product}
                  <small>{n.order || '—'}</small>
                </td>
                <td className="num wh-cell-text">{o ? o.quantity + ' ' + n.unit : '新加'}</td>
                <CorrectQuantity
                  label={n.product + '正确数量'}
                  value={r.quantity}
                  unit={n.unit}
                  busy={busy}
                  change={(quantity) => patch(i, { quantity })}
                />
                <td>
                  <RowDelete
                    label={'删掉第 ' + (i + 1) + ' 行'}
                    disabled={busy || rows.length === 1}
                    onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                  />
                </td>
              </tr>
            );
          })}
        </CorrectionTable>
        {superMode && <Overdelivery value={head} change={changeHead} />}
      </FormSection>
      {admin && (
        <DeliveryCorrectionAdmin
          customerId={doc.customerId}
          orders={orders}
          date={head.date}
          setDate={(date) => changeHead({ date })}
          rows={rows}
          setRows={setRows}
          busy={busy}
        />
      )}
    </CorrectionShell>
  );
}

/** 只有本机管理员能改的一栏：出库日期、每行挂哪条订单明细（同一客户、还没发完的订单）、加一行 */
function DeliveryCorrectionAdmin(o: {
  customerId: number;
  orders: Orders;
  date: string;
  setDate: (date: string) => void;
  rows: DeliveryRow[];
  setRows: (update: (rows: DeliveryRow[]) => DeliveryRow[]) => void;
  busy: boolean;
}) {
  const options = o.orders
    .filter((order) => order.customerId === o.customerId && pendingOrder(order))
    .flatMap((order) =>
      order.lines.map((line) => ({
        id: line.id,
        label: [order.number, line.productName, '订 ' + line.quantity + ' ' + finishedUnit(line.unit)].join(' · '),
      })),
    );
  const withCurrent = (r: DeliveryRow) => {
    const found = orderLineOf(o.orders, r.orderLineId);
    return found && !options.some((x) => x.id === r.orderLineId)
      ? [{ id: found.line.id, label: [found.order.number, found.line.productName].join(' · ') }, ...options]
      : options;
  };
  return (
    <FormSection
      title="管理员还能改"
      hint="改了这里的内容也是撤销原单、另出一张更正后的送货单；只能挂同一客户的订单"
      columns={2}
      extra={
        <AddRow busy={o.busy} add={() => o.setRows((rows) => [...rows, newDeliveryRow()])}>
          加一行
        </AddRow>
      }
    >
      <FormField label="出库日期">{dateInput(o.date, o.setDate, '更正后的出库日期')}</FormField>
      {o.rows.map((r, i) => (
        <Select
          key={i}
          label={'第 ' + (i + 1) + ' 行挂哪条订单明细'}
          span="full"
          value={r.orderLineId}
          options={withCurrent(r)}
          onChange={(orderLineId) => o.setRows((rows) => rows.map((x, j) => (j === i ? { ...x, orderLineId } : x)))}
        />
      ))}
    </FormSection>
  );
}
