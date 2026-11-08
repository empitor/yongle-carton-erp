import { legacyCents, precisionTotal } from '../../shared/precision';
import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { managementRequest } from '../session';
import Combobox from '../ui/Combobox';
import OrderLineTable from '../OrderLineTable';
import { displayAmount } from '../../shared/display-amount';
import {
  statuses,
  derivedOrderStatuses,
  specification,
  today,
  type Customer,
  type Product,
  type Order,
  type OrderInput,
} from '../../shared/domain';
import Field from '../ui/Field';
import { Modal, FormFooter } from '../ui/Modal';
import { api, cents } from '../app-api';
import CustomerEditor from './CustomerEditor';
import ProductEditor from './ProductEditor';

const money = (cents: number) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(cents / 100);

export default function OrderEditor({
  value,
  customers,
  products,
  close,
  saved,
  loading = false,
  inboxId,
}: {
  value?: Order;
  loading?: boolean;
  inboxId?: number;
  customers: Customer[];
  products: Product[];
  close: () => void;
  saved: () => void;
}) {
  // 从收件箱新建时只把原文放在表单上方对照，不解析、不发给模型。
  const [inboxItem, setInboxItem] = useState<any>(null);
  useEffect(() => {
    if (!inboxId) return;
    let live = true;
    managementRequest<any>('/inbox/' + inboxId)
      .then((item) => live && setInboxItem(item))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [inboxId]);
  const [availableCustomers, setAvailableCustomers] = useState(customers),
    [availableProducts, setAvailableProducts] = useState(products),
    [quickCreate, setQuickCreate] = useState<null | {
      kind: 'customer' | 'product';
      line?: number;
    }>(null);
  useEffect(() => setAvailableCustomers(customers), [customers]);
  useEffect(() => setAvailableProducts(products), [products]);
  const [customerId, setCustomerId] = useState(String(value?.customerId || '')),
    [orderDate, setOrderDate] = useState(value?.orderDate || today()),
    [deliveryDate, setDeliveryDate] = useState(value?.deliveryDate || today()),
    [status, setStatus] = useState<OrderInput['status']>(value?.status || '草稿'),
    [notes, setNotes] = useState(value?.notes || '');
  const [orderExtras, setOrderExtras] = useState({
    externalPurchaseOrder: value?.externalPurchaseOrder || '',
    supplierName: value?.supplierName || '',
    currency: 'CNY' as const,
    taxRate: value?.taxRate || '',
    taxMode: value?.taxMode || '未明确',
    terms: value?.terms || '',
    roundingPolicy: value?.roundingPolicy || ('exact-cents' as 'exact-cents' | 'half-up-cent'),
  });
  const blank = () => ({
    id: undefined as number | undefined,
    productId: '',
    productName: '',
    unit: '只',
    notes: '',
    specification: '',
    customerProductCode: '',
    taxRate: '',
    taxMode: '',
    deliveryDate: '',
    quantity: '1',
    price: '0',
  });
  const [lines, setLines] = useState(
    value?.lines.map((l) => ({
      customerProductCode: l.customerProductCode || '',
      taxRate: l.taxRate || '',
      taxMode: l.taxMode || '',
      deliveryDate: l.deliveryDate || '',
      id: l.id,
      productId: String(l.productId),
      productName: l.productName,
      unit: l.unit || '只',
      notes: l.notes || '',
      specification: l.specification,
      quantity: String(l.quantity),
      price: l.unitPriceExact ?? String(l.unitPriceCents / 100),
    })) || [blank()],
  );
  const [costed, setCosted] = useState(value?.costs != null),
    [costs, setCosts] = useState({
      material: String((value?.costs?.material || 0) / 100),
      processing: String((value?.costs?.processing || 0) / 100),
      waste: String((value?.costs?.waste || 0) / 100),
      other: String((value?.costs?.other || 0) / 100),
      basis: value?.costs?.basis || '',
    }),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const changeLine = (index: number, key: string, v: string) =>
    setLines((rows) => rows.map((l, i) => (i === index ? { ...l, [key]: v } : l)));
  const chooseProduct = (index: number, id: string) => {
    const p = availableProducts.find((x) => x.id === Number(id));
    setLines((rows) =>
      rows.map((l, i) =>
        i === index
          ? {
              ...l,
              productId: id,
              productName: p?.name || '',
              customerProductCode: p?.customerProductCode || '',
              specification: p ? specification(p) : '',
              price: p ? (p.priceExact ?? String(p.priceCents / 100)) : '0',
            }
          : l,
      ),
    );
  };
  let total = 0,
    totalExact = '0',
    costTotal = 0;
  try {
    const calculation = precisionTotal(
      lines.map((l) => ({
        quantity: Number(l.quantity),
        unitPriceCents: legacyCents(l.price),
        unitPriceExact: l.price,
      })),
    );
    total = calculation.cents;
    totalExact = calculation.exact;
    costTotal = ['material', 'processing', 'waste', 'other'].reduce(
      (s, k) => s + cents(costs[k as keyof typeof costs]),
      0,
    );
  } catch {
    /* 输入过程中的不完整数值由保存校验处理 */
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload: OrderInput & { version?: number } = {
        ...value,
        ...orderExtras,
        customerId: Number(customerId),
        orderDate,
        deliveryDate,
        status,
        notes,
        version: value?.version,
        lines: lines.map((l) => ({
          id: l.id,
          productId: Number(l.productId),
          productName: l.productName,
          notes: l.notes,
          specification: l.specification,
          quantity: Number(l.quantity),
          unitPriceCents: legacyCents(l.price),
          unitPriceExact: l.price,
          customerProductCode: l.customerProductCode,
          taxRate: l.taxRate,
          taxMode: l.taxMode,
          deliveryDate: l.deliveryDate || undefined,
          unit: l.unit,
        })),
        costs: costed
          ? {
              material: cents(costs.material),
              processing: cents(costs.processing),
              waste: cents(costs.waste),
              other: cents(costs.other),
              basis: costs.basis,
            }
          : null,
      };
      await api('/orders' + (value ? '/' + value.id : ''), payload, value ? 'PUT' : 'POST');
      // 订单已保存；收件状态没改成时不影响订单，收件箱里仍可手动标记已处理。
      if (inboxItem?.status === 'pending')
        await managementRequest('/inbox/' + inboxItem.id + '/status', {
          status: 'converted',
          convertedKind: 'order',
          expectedVersion: inboxItem.version,
        }).catch(() => {});
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      wide
      title={value ? `订单 ${value.number}` : '新建订单'}
      close={saving ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="form-body order-entry">
          <p className="form-intro">
            选择客户 → 添加产品与本次数量 → 核对交期和金额。标 * 为必填，其余按实际业务选填。
          </p>
          {inboxItem && (
            <aside className="order-inbox-source" aria-label="收件箱原文">
              <header>
                <strong>收件箱原文</strong>
                <span>
                  {[inboxItem.senderName, inboxItem.conversation].filter(Boolean).join(' · ') ||
                    '手动添加'}
                </span>
                {inboxItem.status === 'pending' && <small>保存订单后标记为已转单</small>}
              </header>
              {inboxItem.text && <p>{inboxItem.text}</p>}
              {inboxItem.fileName && (
                <a href={'/api/inbox/' + inboxItem.id + '/file'} download>
                  下载 {inboxItem.fileName}
                </a>
              )}
            </aside>
          )}
          {!loading &&(!availableCustomers.length || !availableProducts.length) && (
            <div className="inline-warning">
              尚无客户或产品时，可使用下方快捷建档，已填写订单内容会保留。
            </div>
          )}
          <div className="form-section-heading">
            <h3>客户与交期</h3>
            <span>订单编号由系统保存时生成</span>
          </div>
          <div className="form-grid">
            <div className="field wide">
              <div className="field-label-row">
                <span>客户 *</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setQuickCreate({ kind: 'customer' })}
                >
                  新增客户
                </button>
              </div>
              <Combobox
                required
                ariaLabel="订单客户"
                placeholder="搜索客户"
                value={String(customerId || '')}
                options={availableCustomers.map((c) => ({
                  value: String(c.id),
                  label: c.name,
                  hint: c.contact,
                  keywords: c.phone,
                }))}
                onChange={setCustomerId}
              />
              {value && <small>下单时客户名称：{value.customerName}</small>}
            </div>
            <Field label="下单日期 *">
              <input
                required
                type="date"
                value={orderDate}
                onInput={(e) => setOrderDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="交货日期 *">
              <input
                required
                type="date"
                min={orderDate}
                value={deliveryDate}
                onInput={(e) => setDeliveryDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="订单状态 *">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as OrderInput['status'])}
              >
                {statuses
                  .filter((s) => !derivedOrderStatuses.includes(s) || s === value?.status)
                  .map((s) => (
                    <option key={s}>{s}</option>
                  ))}
              </select>
            </Field>
          </div>
          <details className="order-business-extra">
            <summary>客户采购单号、税费与结算规则</summary>
            <div className="form-grid">
              {(
                [
                  ['externalPurchaseOrder', '客户采购订单号'],
                  ['supplierName', '供应方'],
                  ['taxRate', '税率（%）'],
                  ['taxMode', '含税 / 未税口径'],
                  ['terms', '合同条件'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    value={orderExtras[key]}
                    maxLength={key === 'terms' ? 4000 : 100}
                    onChange={(e) => setOrderExtras((v) => ({ ...v, [key]: e.target.value }))}
                  />
                </Field>
              ))}
              <Field label="金额结算规则">
                <select
                  value={orderExtras.roundingPolicy}
                  onChange={(e) =>
                    setOrderExtras((v) => ({
                      ...v,
                      roundingPolicy: e.target.value as 'exact-cents' | 'half-up-cent',
                    }))
                  }
                >
                  <option value="exact-cents">精确到分，不自动舍入</option>
                  <option value="half-up-cent">明确采用整单四舍五入到分</option>
                </select>
              </Field>
            </div>
            <p className="help-text">
              四位单价原样保存。精确总金额包含不足一分的尾数时，必须明确结算规则；不会自动加减税。
            </p>
          </details>
          <div className="form-section-heading">
            <h3>订单明细</h3>
            <span>数量与单位独立保存 · 单价最多四位小数，保留原始精度</span>
          </div>
          <OrderLineTable
            lines={lines}
            products={availableProducts}
            orderDate={orderDate}
            change={changeLine}
            choose={chooseProduct}
            quick={(i) => setQuickCreate({ kind: 'product', line: i })}
            remove={(i) => setLines((rows) => rows.filter((_, n) => n !== i))}
          />
          <datalist id="order-quantity-units">
            {['只', '张', '箱', '套'].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </datalist>
          <button
            type="button"
            className="add-line"
            disabled={lines.length >= 50}
            onClick={() => setLines((rows) => [...rows, blank()])}
          >
            <Plus size={16} />
            添加明细
          </button>
          <div className="order-total">
            <span>订单合计</span>
            <strong>¥{displayAmount(totalExact)}</strong>
          </div>
          <div className="form-section-heading">
            <h3>预估成本</h3>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={costed}
                onChange={(e) => setCosted(e.target.checked)}
              />
              录入预估成本
            </label>
          </div>
          <p className="help-text">
            填写整张订单的费用总额与估算依据。暂不套用统一纸箱公式；未录入的订单不计入毛利汇总。
          </p>
          {costed && (
            <>
              <div className="form-grid">
                {(
                  [
                    { key: 'material', label: '材料费用 / 元' },
                    { key: 'processing', label: '加工费用 / 元' },
                    { key: 'waste', label: '损耗费用 / 元' },
                    { key: 'other', label: '其他费用 / 元' },
                  ] as const
                ).map((x) => (
                  <Field key={x.key} label={x.label + ' *'}>
                    <input
                      required
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={costs[x.key]}
                      onChange={(e) => setCosts((c) => ({ ...c, [x.key]: e.target.value }))}
                    />
                  </Field>
                ))}
                <Field label="估算依据 *" wide>
                  <textarea
                    required
                    maxLength={1000}
                    rows={2}
                    placeholder="例如：本单实际配纸报价、加工报价、单独确认的损耗及运费"
                    value={costs.basis}
                    onChange={(e) => setCosts((c) => ({ ...c, basis: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="cost-summary">
                <span>预估成本 {money(costTotal)}</span>
                <strong>预估毛利 {money(total - costTotal)}</strong>
              </div>
            </>
          )}
          <Field label="订单备注">
            <textarea
              rows={2}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>
        <FormFooter error={error} saving={saving} close={close} />
      </form>
      {quickCreate?.kind === 'customer' && (
        <CustomerEditor
          close={() => setQuickCreate(null)}
          saved={(record) => {
            setAvailableCustomers((v) => [...v.filter((x) => x.id !== record.id), record]);
            setCustomerId(String(record.id));
            setQuickCreate(null);
            window.dispatchEvent(new Event('erp-business-changed'));
          }}
        />
      )}
      {quickCreate?.kind === 'product' && (
        <ProductEditor
          close={() => setQuickCreate(null)}
          saved={(record) => {
            setAvailableProducts((v) => [...v.filter((x) => x.id !== record.id), record]);
            setLines((v) =>
              v.map((l, i) =>
                i === quickCreate.line
                  ? {
                      ...l,
                      productId: String(record.id),
                      productName: record.name,
                      specification: specification(record),
                      price: record.priceExact ?? String(record.priceCents / 100),
                    }
                  : l,
              ),
            );
            setQuickCreate(null);
            window.dispatchEvent(new Event('erp-business-changed'));
          }}
        />
      )}
    </Modal>
  );
}
