import { orderLineAmount, orderLineExtra, ORDER_LINES_TITLE } from '../recordkit/index';
import { finishedUnit, linePrice } from '../../shared/core/index';
import { amountText, specLine, taxText } from '../../shared/business/index';
import { Facts, Section, StatusChip } from '../ui/index';
import type { Plan } from '../../shared/import/index';

/**
 * 正式导入前的预览：客户和订单、每行明细（数量、单价、程序算的金额、产品档案是已有还是新建）、核对提示。
 * 单份导入和批量导入用同一张表。
 * 要新建、但已有同名产品（尺寸或材质不同）的行列在最上面，勾上“是另一个产品”才能导入（confirmed、toggle）。
 */
export default function ImportPlanView({
  plan,
  confirmed,
  toggle,
}: {
  plan: Plan;
  confirmed?: Set<string>;
  toggle?: (lineId: string) => void;
}) {
  const order = plan.order;
  return (
    <>
      {plan.confirmations.length > 0 && (
        <Section title="同名产品要确认">
          <ul className="aii-same-name">
            {plan.confirmations.map((c) => (
              <li key={c.lineId}>
                <p>
                  第 {c.line} 行“{c.name}”要新建，已有同名产品：
                </p>
                <ul>
                  {c.existing.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
                <label className="sales-check">
                  <input
                    type="checkbox"
                    aria-label={'第 ' + c.line + ' 行是另一个产品'}
                    checked={!!confirmed?.has(c.lineId)}
                    disabled={!toggle}
                    onChange={() => toggle?.(c.lineId)}
                  />
                  是另一个产品，导入时新建
                </label>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="客户和订单">
        <Facts
          items={[
            {
              label: '客户',
              value: (
                <span className="aii-inline">
                  {plan.customer.name}
                  <StatusChip tone={plan.customer.mode === 'new' ? 'accent' : 'neutral'}>
                    {plan.customer.mode === 'new' ? '新建客户' : '已有客户'}
                  </StatusChip>
                </span>
              ),
            },
            { label: '客户采购单号', value: order.externalPurchaseOrder },
            { label: '订单日期', value: order.orderDate },
            { label: '交货日期', value: order.deliveryDate },
            { label: '状态', value: order.status },
            { label: '币种', value: order.currency === 'CNY' ? '人民币' : order.currency },
            { label: '税费', value: taxText(order.taxRate, order.taxMode) },
            { label: '合同条件', value: order.terms, wide: !!order.terms },
            { label: '整单备注', value: order.notes, wide: !!order.notes },
          ]}
        />
      </Section>
      <Section title={ORDER_LINES_TITLE}>
        <div className="table-wrap">
          <table className="aii-preview-lines">
            <thead>
              <tr>
                <th>产品</th>
                <th className="num">数量</th>
                <th className="num">单价 / 元</th>
                <th className="num">金额 / 元</th>
                <th>产品档案</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line, i) => {
                const product = plan.products[i];
                return (
                  <tr key={i}>
                    <td>
                      {i + 1}. {line.productName}
                      <small>{orderLineExtra(line).join(' · ') || '—'}</small>
                    </td>
                    <td className="num">
                      {line.quantity} {finishedUnit(line.unit)}
                    </td>
                    <td className="num">{linePrice(line)}</td>
                    <td className="num">{orderLineAmount(line)}</td>
                    <td>
                      <StatusChip tone={product.mode === 'new' ? 'accent' : 'neutral'}>
                        {product.mode === 'new' ? '新建' : '已有'}
                      </StatusChip>{' '}
                      {product.name}
                      {product.mode === 'new' && (
                        <small>
                          {[specLine(product.input), product.input.requirements].filter(Boolean).join(' · ') || '—'}
                        </small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>合计</td>
                <td />
                <td />
                <td className="num">
                  <strong>{amountText(plan.total)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
      {plan.warnings.length > 0 && (
        <Section title="核对提示">
          <details className="aii-fold">
            <summary>查看全部 {plan.warnings.length} 项</summary>
            <ul>
              {plan.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </details>
        </Section>
      )}
    </>
  );
}
