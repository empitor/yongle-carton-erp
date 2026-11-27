import { ChevronDown, Plus } from 'lucide-react';
import { orderLineAmount } from '../recordkit/OrderLinesView';
import { fieldLabel, fieldTitle, finishedUnit, orderTaxModeHint, productsForCustomer, type FieldKey, type Product } from '../../shared/core/index';
import { Combobox, RowDelete } from '../ui/index';
import { FormField } from '../ui/index';

import type { OrderLineDraft } from './order-draft';
import TaxModeSelect from './TaxModeSelect';
import OrderTaxRateField from './OrderTaxRateField';

const extraKeys = ['customerProductCode', 'taxRate', 'taxMode', 'deliveryDate', 'notes'] as const;
/** 订单明细一层的栏目叫法（本单名称、分项交期、本项税率……，栏目登记表） */
const lineName = (key: FieldKey) => fieldLabel(key, { record: 'orders', parent: 'lines' });
/** 单价、金额列名带单位：“单价（元）” */
const priceTitle = fieldTitle('unitPrice'),
  amountTitle = fieldTitle('amount');

const amount = (l: OrderLineDraft) => orderLineAmount({ quantity: l.quantity, unitPriceExact: l.price });

type Option = { value: string; label: string; hint: string; keywords: string | undefined };
/** 一行明细要的：这一行、第几行（从 0 起）、能选的产品，和改这一行的几个动作 */
type LineProps = {
  l: OrderLineDraft;
  i: number;
  options: Option[];
  products: Product[];
  orderDate: string;
  expanded: boolean;
  single: boolean;
  toggle: (key: string) => void;
  change: (index: number, key: keyof OrderLineDraft, value: string) => void;
  choose: (index: number, id: string) => void;
  quick: (index: number) => void;
  remove: (index: number) => void;
};

/** 一行明细的主行：产品、规格、数量（单位固定“只”）、单价、金额，行尾展开和移除 */
function OrderLineMain({ l, i, options, products, expanded, single, toggle, change, choose, quick, remove }: LineProps) {
  const product = products.find((p) => String(p.id) === String(l.productId)),
    renamed = !!product && !!l.productName && l.productName !== product.name,
    filled = extraKeys.filter((k) => l[k]).length + (renamed ? 1 : 0),
    n = i + 1;
  return (
    <tr className="sales-line-main">
      <td className="sales-col-product" data-label="产品">
        <div className="sales-line-product">
          <Combobox
            required
            ariaLabel={'第 ' + n + ' 行产品'}
            placeholder="搜索产品"
            value={String(l.productId || '')}
            options={options}
            onChange={(id) => choose(i, id)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={'新建产品（明细' + n + '）'}
            title="找不到这个产品？新建产品档案"
            onClick={() => quick(i)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {renamed && <small>本单名称：{l.productName}</small>}
      </td>
      <td className="sales-col-spec" data-label="规格">
        <input
          aria-label={'第 ' + n + ' 行规格'}
          maxLength={2000}
          value={l.specification}
          title={l.specification}
          onChange={(e) => change(i, 'specification', e.target.value)}
        />
      </td>
      <td className="sales-col-qty" data-label="数量">
        <div className="form-inline">
          <input
            aria-label={'第 ' + n + ' 行数量'}
            required
            type="number"
            min="1"
            max="1000000"
            step="1"
            placeholder="数量"
            value={l.quantity}
            onChange={(e) => change(i, 'quantity', e.target.value)}
          />
          <span className="unit-fixed" aria-label={'第 ' + n + ' 行数量单位'}>
            {finishedUnit(l.unit)}
          </span>
        </div>
      </td>
      <td className="num sales-col-price" data-label={priceTitle}>
        <input
          aria-label={'第 ' + n + ' 行单价'}
          required
          type="number"
          min="0"
          max="1000000"
          step="0.0001"
          placeholder="填单价"
          value={l.price}
          onChange={(e) => change(i, 'price', e.target.value)}
        />
      </td>
      <td className="num sales-col-amount" data-label={amountTitle}>
        <output>{amount(l)}</output>
      </td>
      <td className="sales-col-actions">
        <div className="sales-line-actions">
          <button
            type="button"
            className={'icon-button sales-line-toggle' + (filled ? ' has-extra' : '')}
            aria-expanded={expanded}
            aria-label={'第 ' + n + ' 行的本单名称、料号、交期、税费和备注'}
            title={filled ? '本单名称、料号、交期、税费和备注（已填 ' + filled + ' 项）' : '本单名称、料号、交期、税费和备注'}
            onClick={() => toggle(l.key)}
          >
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <RowDelete label={'移除明细' + n} disabled={single} onClick={() => remove(i)} />
        </div>
      </td>
    </tr>
  );
}

/** 一行明细下面的展开行：本单名称、客户料号、分项交期、税费和备注（一直在页面上，只是隐藏，必填检查照常生效） */
function OrderLineExtras({ l, i, orderDate, expanded, change }: LineProps) {
  const n = i + 1;
  return (
    <tr className="sales-line-extra" hidden={!expanded} data-line-key={l.key}>
      <td colSpan={6}>
        <div className="ed-grid cols-4">
          <FormField label={lineName('productName')} required span={2} hint="选产品时自动带出，可改成客户单据上的叫法">
            <input
              aria-label={'第 ' + n + ' 行本单产品名称'}
              data-field={lineName('productName')}
              required
              maxLength={2000}
              value={l.productName}
              onChange={(e) => change(i, 'productName', e.target.value)}
            />
          </FormField>
          <FormField label={lineName('customerProductCode')}>
            <input
              aria-label={'第 ' + n + ' 行' + lineName('customerProductCode')}
              maxLength={100}
              value={l.customerProductCode}
              onChange={(e) => change(i, 'customerProductCode', e.target.value)}
            />
          </FormField>
          <FormField label={lineName('deliveryDate')}>
            <input
              aria-label={'第 ' + n + ' 行本项交货日期'}
              data-field={lineName('deliveryDate')}
              type="date"
              min={orderDate}
              value={l.deliveryDate}
              onChange={(e) => change(i, 'deliveryDate', e.target.value)}
            />
          </FormField>
          <OrderTaxRateField line={n} tax={l} change={(v) => change(i, 'taxRate', v)} />
          <FormField label={lineName('taxMode')} hint={orderTaxModeHint(l.taxText, l.taxMode)}>
            <TaxModeSelect
              label={'第 ' + n + ' 行' + lineName('taxMode')}
              blank="同整单"
              value={l.taxMode}
              onChange={(v) => change(i, 'taxMode', v)}
            />
          </FormField>
          <FormField label="明细备注" span={2}>
            <input
              aria-label={'第 ' + n + ' 行备注'}
              maxLength={2000}
              value={l.notes}
              onChange={(e) => change(i, 'notes', e.target.value)}
            />
          </FormField>
        </div>
      </td>
    </tr>
  );
}

/**
 * 订单明细（编辑）：表头一次，每行一排——产品、规格、数量（单位固定“只”）、单价、金额。
 * 只看时用 recordkit/OrderLinesView，名字、金额算法共用。
 * 本单名称、客户料号、分项交期、税费和备注收在每行下面的展开行里；
 * 展开行一直在页面上（只是隐藏），必填检查照常生效，没填好时会自动展开。
 */
const productOption = (p: Product): Option => ({
  value: String(p.id),
  label: p.name,
  hint: [p.customerName, p.material, p.flute].filter(Boolean).join(' / '),
  keywords: p.customerProductCode,
});

export default function OrderLines({
  lines,
  products,
  customerId,
  keptProducts,
  orderDate,
  open,
  toggle,
  change,
  choose,
  quick,
  remove,
}: {
  lines: OrderLineDraft[];
  products: Product[];
  customerId: number | null;
  keptProducts: ReadonlyMap<number, number>;
  orderDate: string;
  open: string[];
  toggle: (key: string) => void;
  change: (index: number, key: keyof OrderLineDraft, value: string) => void;
  choose: (index: number, id: string) => void;
  quick: (index: number) => void;
  remove: (index: number) => void;
}) {
  // 选了客户后，下拉只列该客户的产品和没定客户的通用产品；留着原产品的明细（老订单没换客户，或换了客户但产品跟着改归新客户，
  // 见 order-customer-change.ts）把原产品补进这一行的下拉供显示
  const scoped = customerId ? productsForCustomer(products, customerId) : products;
  const baseOptions = scoped.map(productOption);
  const optionsFor = (l: OrderLineDraft) => {
    if (!customerId || !l.productId || l.id == null || keptProducts.get(l.id) !== Number(l.productId)) return baseOptions;
    if (baseOptions.some((o) => o.value === l.productId)) return baseOptions;
    const kept = products.find((p) => String(p.id) === l.productId);
    return kept ? [productOption(kept), ...baseOptions] : baseOptions;
  };
  return (
    <div className="line-table sales-line-table">
      <table>
        <thead>
          <tr>
            <th className="sales-col-product">产品</th>
            <th className="sales-col-spec">规格</th>
            <th className="sales-col-qty">数量</th>
            <th className="num sales-col-price">{priceTitle}</th>
            <th className="num sales-col-amount">{amountTitle}</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        {lines.map((l, i) => {
          const line: LineProps = {
            l,
            i,
            options: optionsFor(l),
            products,
            orderDate,
            expanded: open.includes(l.key),
            single: lines.length === 1,
            toggle,
            change,
            choose,
            quick,
            remove,
          };
          return (
            <tbody key={l.key} className={line.expanded ? 'is-open' : undefined}>
              <OrderLineMain {...line} />
              <OrderLineExtras {...line} />
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
