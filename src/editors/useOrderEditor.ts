import { useRef, useState, type SubmitEvent, type SyntheticEvent } from 'react';
import { costYuan, hasUnrecognizedTax, productFitsCustomer, today, type Customer, type Order, type OrderInput, type Product } from '../../shared/core/index';
import { emit, useAction, useLoad } from '../ui/index';
import { changeOrderStatus } from '../recordkit/record-api';
import { saveOrder, soleOrderProducts } from './editor-api';
import { crossCustomerLine, customerChangeBlocked, keptLineProducts, movingNotice, pruneLinesForCustomer } from './order-customer-change';
import {
  blankLine,
  fillProduct,
  initialLines,
  orderPayload,
  orderTotals,
  type CostDraft,
  type OrderExtras,
  type OrderLineDraft,
} from './order-draft';

/** 表单上方对照的原文资料（从别处发起新建订单时传入，编辑窗只管显示） */
export type OrderSource = {
  title: string;
  meta?: string;
  hint?: string;
  text?: string;
  file?: { name: string; url: string };
};

export type OrderEditorProps = {
  value?: Order;
  loading?: boolean;
  /** 表单上方对照的原文和原文件下载链接；只用于对照，不发给模型 */
  source?: OrderSource;
  /** 从客户或产品“新建订单”时带进来的内容；只用于新建 */
  preset?: { customerId?: number; productIds?: number[] };
  customers: Customer[];
  products: Product[];
  close: () => void;
  saved: (record: Order, message: string) => void | Promise<void>;
};

const initialExtras = (value?: Order): OrderExtras => ({
  externalPurchaseOrder: value?.externalPurchaseOrder || '',
  supplierName: value?.supplierName || '',
  currency: 'CNY' as const,
  taxRate: value?.taxRate?.toString() ?? '',
  taxText: value?.taxText,
  taxMode: value?.taxMode || '',
  terms: value?.terms || '',
  roundingPolicy: value?.roundingPolicy || 'exact-cents',
});
const initialCosts = (value?: Order): CostDraft => ({
  material: costYuan(value?.costs?.material || 0),
  processing: costYuan(value?.costs?.processing || 0),
  waste: costYuan(value?.costs?.waste || 0),
  other: costYuan(value?.costs?.other || 0),
  basis: value?.costs?.basis || '',
});

/** 多选产品开单时，只有所有带归属客户的产品都指向唯一同一客户才预填；跨客户或都没归属就留空不猜 */
function uniquePresetCustomer(preset: OrderEditorProps['preset'], products: Product[]) {
  if (preset?.customerId) return preset.customerId;
  if (!preset?.productIds?.length) return undefined;
  const owners = new Set(
    products
      .filter((p) => preset.productIds?.includes(p.id) && p.customerId != null)
      .map((p) => p.customerId),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

/** 窗口里填的内容：表头、明细（行 key 只在页面里记哪一行展开了，不提交）、更多信息、预估成本 */
function useOrderDraft({ value, preset, products }: OrderEditorProps) {
  const presetCustomer = !value ? uniquePresetCustomer(preset, products) : undefined;
  const [customerId, setCustomerId] = useState(String(value?.customerId || presetCustomer || '')),
    [orderDate, setOrderDate] = useState(value?.orderDate || today()),
    [deliveryDate, setDeliveryDate] = useState(value?.deliveryDate || ''),
    [notes, setNotes] = useState(value?.notes || ''),
    [extras, setExtras] = useState<OrderExtras>(() => initialExtras(value));
  const nextKey = useRef(0);
  const key = () => 'line-' + nextKey.current++;
  const [lines, setLines] = useState<OrderLineDraft[]>(() => initialLines(value, preset, products, key)),
    // 税率或含税口径没认出来（原话认不出、口径还没选）的明细自动展开，叫人对照原件填
    [open, setOpen] = useState<string[]>(() =>
      lines.filter((l) => hasUnrecognizedTax(l.taxText, l.taxRate, l.taxMode)).map((l) => l.key),
    );
  // 税费、合同条件、金额结算、预估成本、供应方用得少，默认收进“更多信息”；
  // 税率或含税口径没认出来、合计有不足一分的尾数要选结算方式、或里面有没填好的必填项时自动展开
  const [moreOpen, setMoreOpen] = useState(() => hasUnrecognizedTax(extras.taxText, extras.taxRate, extras.taxMode)),
    [costed, setCosted] = useState(value?.costs != null),
    [costs, setCosts] = useState<CostDraft>(() => initialCosts(value));
  return {
    customerId, setCustomerId, orderDate, setOrderDate, deliveryDate, setDeliveryDate, notes, setNotes,
    extras, setExtras, lines, setLines, open, setOpen, moreOpen, setMoreOpen, costed, setCosted, costs, setCosts,
    addLine: () => setLines((rows) => [...rows, blankLine(key())]),
    changeLine: (index: number, k: keyof OrderLineDraft, v: string) =>
      setLines((rows) => rows.map((l, i) => (i === index ? { ...l, [k]: v } : l))),
    totals: orderTotals(lines, costs),
  };
}
type Draft = ReturnType<typeof useOrderDraft>;

/** 会报“没填好”的输入框（输入框、多行文字、下拉框） */
const isField = (el: EventTarget) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

/** 收起的地方有没填好的（“更多信息”里的、收起的明细附加项）：自动展开，说明是哪一项 */
const invalidHandler = (d: Draft, setInvalid: (text: string) => void) => (e: SyntheticEvent<HTMLFormElement>) => {
  const el = e.target;
  if (!isField(el)) return;
  const row = el.closest<HTMLElement>('[data-line-key]');
  const folded = el.closest('details');
  if (folded && !folded.open) {
    d.setMoreOpen(true);
    setInvalid('“更多信息”里的' + (el.dataset.field || '必填项') + '没填好：' + el.validationMessage);
  }
  const k = row?.hidden ? row.dataset.lineKey : undefined;
  if (k === undefined) return;
  const index = d.lines.findIndex((l) => l.key === k);
  d.setOpen((v) => (v.includes(k) ? v : [...v, k]));
  setInvalid('明细 ' + (index + 1) + ' 的' + (el.dataset.field || '附加项') + '没填好：' + el.validationMessage);
};

/** 保存后的提示：新建、保存、保存并确认各一句 */
const savedText = (number: string | undefined, editing: boolean, confirmed: boolean) =>
  '订单' +
  (number ? ' ' + number : '') +
  (confirmed ? (editing ? ' 已保存并确认。' : ' 已建立并确认。') : editing ? ' 已保存。' : ' 已建立，待确认。');

/** 把本窗里刚快速新建的档案叠到外部传入列表后，防止外部慢读返回时覆盖刚回填的记录 */
const mergeRecords = <T extends { id: number }>(base: T[], added: T[]) => [
  ...base.filter((x) => !added.some((a) => a.id === x.id)),
  ...added,
];

/**
 * 换客户：编辑已有订单时读“订单明细只在这张订单里”的产品，跟着改归新客户的行不清空，属别家客户的行清空
 * （留哪些行、提示怎么写在 order-customer-change.ts）。还在读、读失败都不能换客户（blocked 是原因和怎么办，
 * waiting 是还在读，retry 重读）。
 * notice：保存后会一起改归新客户的产品按现在的明细每次现算，后面接换客户时清空了哪几行（clearedNotice）。kept 是现在这家客户下留着原产品的行。
 */
function useCustomerChange(value: Order | undefined, d: Draft, customers: Customer[], products: Product[]) {
  const sole = useLoad(value ? String(value.id) : null, (id) => soleOrderProducts(Number(id)));
  const soleIds = new Set(sole.data?.productIds),
    blocked = customerChangeBlocked(!!value, sole);
  const [clearedNotice, setClearedNotice] = useState('');
  const change = (nextId: string) => {
    if (blocked) return;
    d.setCustomerId(nextId);
    const pruned = pruneLinesForCustomer(d.lines, nextId ? Number(nextId) : null, products, keptLineProducts(value, nextId, products, soleIds));
    d.setLines(pruned.nextRows);
    setClearedNotice(pruned.notice);
  };
  const current = customers.find((c) => String(c.id) === d.customerId);
  return {
    kept: keptLineProducts(value, d.customerId, products, soleIds),
    notice: movingNotice(d.lines, value, current, products, soleIds) + clearedNotice,
    setNotice: setClearedNotice,
    change,
    blocked,
    waiting: !!value && sole.loading && !sole.error,
    retry: sole.reload,
  };
}

/** 订单编辑窗的状态和动作：填的内容、保存（保存并确认）、快速建档回填。数据怎么算在 order-draft.ts。 */
export function useOrderEditor(props: OrderEditorProps) {
  const { value, customers, products, saved } = props;
  const [createdCustomers, setCreatedCustomers] = useState<Customer[]>([]),
    [createdProducts, setCreatedProducts] = useState<Product[]>([]),
    [quickCreate, setQuickCreate] = useState<null | { kind: 'customer' | 'product'; line?: number }>(null);
  const availableCustomers = mergeRecords(customers, createdCustomers),
    availableProducts = mergeRecords(products, createdProducts);
  const d = useOrderDraft(props);
  // 订单状态不在窗口里手选：待确认的订单底部有“保存”和“保存并确认”；
  // 已确认的照原状态保存；生产中、待发货、已发货由生产和送货单据推进。
  const status: OrderInput['status'] = value?.status || '待确认',
    pending = status === '待确认',
    submitStatus = useRef<OrderInput['status']>(status);
  const save = useAction();
  const [invalid, setInvalid] = useState('');
  const customer = useCustomerChange(value, d, availableCustomers, availableProducts),
    { kept: keptProducts, notice: customerNotice, setNotice: setCustomerNotice } = customer;
  const changeCustomer = (nextId: string) => {
    setInvalid('');
    customer.change(nextId);
  };
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setInvalid('');
    const bad = d.lines.findIndex((l) => crossCustomerLine(l, d.customerId ? Number(d.customerId) : null, availableProducts, keptProducts));
    if (bad >= 0) return setInvalid(`第 ${bad + 1} 行的产品属于其他客户，请重新选择当前客户的产品或通用产品。`);
    void save
      .run(async () => {
        // 已有的待确认订单“保存并确认”：整张保存不改状态，先按原状态保存内容，再走“确认订单”这个动作
        const confirmAfter = !!value && pending && submitStatus.current === '已确认';
        const { customerId, orderDate, deliveryDate, notes, lines, costed, costs, extras } = d;
        const body = { value, extras, customerId, orderDate, deliveryDate, notes, lines, costed, costs };
        let record = await saveOrder(value?.id, orderPayload({ ...body, status: confirmAfter ? status : submitStatus.current }));
        if (confirmAfter) record = await changeOrderStatus(record, 'confirm');
        const message = savedText(record?.number || value?.number, !!value, pending && submitStatus.current === '已确认');
        await saved(record, message);
      })
      // 回车提交时按原状态保存；要确认就点“保存并确认”
      .finally(() => (submitStatus.current = status));
  };
  const chooseProduct = (index: number, id: string) => {
    const p = availableProducts.find((x) => x.id === Number(id));
    setCustomerNotice('');
    d.setLines((rows) => rows.map((l, i) => (i === index ? fillProduct(l, p, id) : l)));
  };
  /** 快速新建客户、产品后选进当前订单（产品带出名称、料号、规格和参考单价，和下拉选产品一样） */
  const customerCreated = (record: Customer) => {
    setCreatedCustomers((v) => [...v.filter((x) => x.id !== record.id), record]);
    setInvalid('');
    customer.change(String(record.id));
    setQuickCreate(null);
    emit('erp-business-changed');
  };
  const productCreated = (record: Product) => {
    setCreatedProducts((v) => [...v.filter((x) => x.id !== record.id), record]);
    const line = quickCreate?.line;
    const orderCustomerId = d.customerId ? Number(d.customerId) : null;
    if (orderCustomerId != null && !productFitsCustomer(record, orderCustomerId)) {
      setCustomerNotice(
        '新建的产品“' + record.name + '”属于其他客户，未填入当前订单明细；请选当前客户的产品或通用产品。',
      );
    } else {
      setCustomerNotice('');
      d.setLines((v) => v.map((l, i) => (i === line ? fillProduct(l, record, String(record.id)) : l)));
    }
    setQuickCreate(null);
    emit('erp-business-changed');
  };
  return {
    ...d,
    changeCustomer, keptProducts, customerNotice, customerBlocked: customer.blocked, customerWaiting: customer.waiting, retrySole: customer.retry,
    availableCustomers, availableProducts, quickCreate, setQuickCreate, customerCreated, productCreated,
    status, pending, submitStatus, chooseProduct, submit,
    onInvalid: invalidHandler(d, setInvalid),
    error: invalid || save.error,
    saving: save.busy,
  };
}
