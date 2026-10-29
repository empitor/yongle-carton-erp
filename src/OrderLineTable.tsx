import { Fragment } from 'react';
import { Trash2 } from 'lucide-react';
import { precisionTotal } from '../shared/precision';
export default function OrderLineTable({
  lines,
  products,
  orderDate,
  change,
  choose,
  quick,
  remove,
}: {
  lines: any[];
  products: any[];
  orderDate: string;
  change: (i: number, key: string, value: string) => void;
  choose: (i: number, id: string) => void;
  quick: (i: number) => void;
  remove: (i: number) => void;
}) {
  const amount = (l: any) => {
    try {
      return precisionTotal([
        { quantity: Number(l.quantity), unitPriceCents: 0, unitPriceExact: l.price },
      ]).exact;
    } catch {
      return '待填写';
    }
  };
  return (
    <div className="order-line-table table-wrap">
      <table>
        <thead>
          <tr>
            <th>产品 / 本单名称</th>
            <th>规格与尺寸单位</th>
            <th>订购数量 *</th>
            <th>数量单位 *</th>
            <th>单价 / 元 *</th>
            <th>金额 / 元</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <Fragment key={i}>
              <tr>
                <td>
                  <select
                    required
                    aria-label={'明细' + (i + 1) + '产品档案'}
                    value={l.productId}
                    onChange={(e) => choose(i, e.target.value)}
                  >
                    <option value="">选择产品</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={'明细' + (i + 1) + '本单产品名称'}
                    required
                    maxLength={2000}
                    value={l.productName}
                    onChange={(e) => change(i, 'productName', e.target.value)}
                    placeholder="本单产品名称"
                  />
                  <button type="button" className="text-button" onClick={() => quick(i)}>
                    新增产品
                  </button>
                </td>
                <td>
                  <textarea
                    aria-label={'明细' + (i + 1) + '本单规格型号'}
                    rows={2}
                    maxLength={2000}
                    value={l.specification}
                    onChange={(e) => change(i, 'specification', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={'明细' + (i + 1) + '订购数量'}
                    required
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    value={l.quantity}
                    onChange={(e) => change(i, 'quantity', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={'明细' + (i + 1) + '数量单位'}
                    required
                    maxLength={20}
                    list="order-quantity-units"
                    value={l.unit}
                    onChange={(e) => change(i, 'unit', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={'明细' + (i + 1) + '单价'}
                    required
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.0001"
                    value={l.price}
                    onChange={(e) => change(i, 'price', e.target.value)}
                  />
                </td>
                <td>
                  <output>{amount(l)}</output>
                </td>
                <td>
                  <button
                    type="button"
                    className="text-button danger"
                    aria-label={'移除明细' + (i + 1)}
                    disabled={lines.length === 1}
                    onClick={() => remove(i)}
                  >
                    <Trash2 size={14} />
                    移除
                  </button>
                </td>
              </tr>
              <tr className="order-line-extra-row">
                <td colSpan={7}>
                  <details className="order-line-options">
                    <summary>明细 {i + 1} · 客户料号、分项交期、税费及备注</summary>
                    <div className="form-grid">
                      {(
                        [
                          ['customerProductCode', '客户料号', 100],
                          ['taxRate', '本项税率（%）', 30],
                          ['taxMode', '本项含税 / 未税口径', 60],
                        ] as const
                      ).map(([key, label, max]) => (
                        <label className="field" key={key}>
                          <span>{label}</span>
                          <input
                            maxLength={max}
                            value={l[key]}
                            onChange={(e) => change(i, key, e.target.value)}
                          />
                        </label>
                      ))}
                      <label className="field">
                        <span>本项交货日期</span>
                        <input
                          type="date"
                          min={orderDate}
                          value={l.deliveryDate}
                          onChange={(e) => change(i, 'deliveryDate', e.target.value)}
                        />
                      </label>
                      <label className="field wide">
                        <span>明细备注</span>
                        <textarea
                          rows={2}
                          maxLength={2000}
                          value={l.notes}
                          onChange={(e) => change(i, 'notes', e.target.value)}
                        />
                      </label>
                    </div>
                  </details>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
