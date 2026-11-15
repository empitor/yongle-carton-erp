import { FormField, FormSection, RowDelete } from '../ui/index';

export type PlanLine = { orderId: number; orderLineId: number; stockId: number; quantity: string; notes: string };
/** 一张送货单（一个客户）在窗口里改的：计划送货日期、收货信息、超订单的原因 */
export type GroupInput = { plannedDate: string; address: string; contact: string; phone: string; reason: string };

/**
 * 安排送货窗口里的一张送货单（一个客户）：计划送货日期、收货地址和联系人（按客户档案预填，能改）、
 * 每行成品和本次数量（能改、能去掉）。有行超过订单还没发的数量时要写超订单的原因（服务端要超级管理员）。
 */
export default function DeliveryPlanGroup({
  title,
  lines,
  input,
  change,
  over,
  locked,
  stockName,
  lineInfo,
  setQuantity,
  remove,
}: {
  title: string;
  lines: (PlanLine & { key: string })[];
  input: GroupInput;
  change: (patch: Partial<GroupInput>) => void;
  /** 超过订单还没发的那几行（key） */
  over: string[];
  /** 已经建好的送货单不能再改 */
  locked: boolean;
  stockName: (id: number) => string;
  lineInfo: (l: PlanLine) => { order: string; product: string; unit: string; due?: string };
  setQuantity: (key: string, quantity: string) => void;
  remove: (key: string) => void;
}) {
  const field = (key: 'address' | 'contact' | 'phone', label: string, span?: 'full') => (
    <FormField label={label} span={span}>
      <input
        aria-label={title + ' ' + label}
        value={input[key]}
        disabled={locked}
        onChange={(e) => change({ [key]: e.target.value })}
      />
    </FormField>
  );
  return (
    <FormSection title={title} columns={3}>
      <FormField label="计划送货日期" required>
        <input
          type="date"
          required
          aria-label={title + ' 计划送货日期'}
          value={input.plannedDate}
          disabled={locked}
          onChange={(e) => change({ plannedDate: e.target.value })}
        />
      </FormField>
      {field('contact', '收货联系人')}
      {field('phone', '联系方式')}
      {field('address', '收货地址', 'full')}
      <div className="line-table span-full">
        <table>
          <thead>
            <tr>
              <th>成品</th>
              <th>对应订单明细</th>
              <th className="num">本次送货</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const info = lineInfo(l);
              return (
                <tr key={l.key}>
                  <td>{stockName(l.stockId)}</td>
                  <td className="wh-cell-text">
                    {info.order} · {info.product}
                    {info.due && <small>交期 {info.due}</small>}
                    {over.includes(l.key) && <small className="wh-late">超过订单还没发的数量</small>}
                  </td>
                  <td className="num">
                    <div className="wh-qty">
                      <input
                        aria-label={info.order + ' ' + info.product + ' 本次送货数量'}
                        aria-required="true"
                        inputMode="decimal"
                        value={l.quantity}
                        disabled={locked}
                        onChange={(e) => setQuantity(l.key, e.target.value)}
                      />
                      <span>{info.unit}</span>
                    </div>
                  </td>
                  <td>
                    <RowDelete
                      label={'去掉 ' + info.order + ' ' + info.product}
                      disabled={locked}
                      onClick={() => remove(l.key)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {over.length > 0 && (
        <FormField label="超订单原因" required span="full" hint="超过订单数量发货要超级管理员，仍不能超过库存">
          <textarea
            aria-label={title + ' 超订单发货原因'}
            value={input.reason}
            disabled={locked}
            onChange={(e) => change({ reason: e.target.value })}
          />
        </FormField>
      )}
    </FormSection>
  );
}
