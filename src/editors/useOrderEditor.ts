import { useEffect, useRef, useState, type SubmitEvent, type SyntheticEvent } from 'react';
import { costYuan, today, type Customer, type Order, type OrderInput, type Product } from '../../shared/core/index';
import { emit, notify, useAction, useLoad, useSlots, type Slots } from '../ui/index';
import { changeOrderStatus } from '../recordkit/record-api';
import { saveOrder } from './editor-api';
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

export type OrderEditorProps = {
  value?: Order;
  loading?: boolean;
  inboxId?: number;
  /** 从客户或产品“新建订单”时带进来的内容；只用于新建 */
  preset?: { customerId?: number; productIds?: number[] };
  customers: Customer[];
  products: Product[];
  close: () => void;
  saved: () => void;
};

const initialExtras = (value?: Order): OrderExtras => ({
  externalPurchaseOrder: value?.externalPurchaseOrder || '',
  supplierName: value?.supplierName || '',
  currency: 'CNY' as const,
  taxRate: value?.taxRate || '',
  taxMode: value?.taxMode || '未明确',
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

/** 窗口里填的内容：表头、明细（行 key 只在页面里记哪一行展开了，不提交）、更多信息、预估成本 */
function useOrderDraft({ value, preset, products }: OrderEditorProps) {
  const [customerId, setCustomerId] = useState(String(value?.customerId || (!value && preset?.customerId) || '')),
    [orderDate, setOrderDate] = useState(value?.orderDate || today()),
    [deliveryDate, setDeliveryDate] = useState(value?.deliveryDate || ''),
    [notes, setNotes] = useState(value?.notes || ''),
    [extras, setExtras] = useState<OrderExtras>(() => initialExtras(value));
  const nextKey = useRef(0);
  const key = () => 'line-' + nextKey.current++;
  const [lines, setLines] = useState<OrderLineDraft[]>(() => initialLines(value, preset, products, key)),
    [open, setOpen] = useState<string[]>([]);
  // 税费、合同条件、金额结算、预估成本、供应方用得少，默认收进“更多信息”；
  // 合计有不足一分的尾数要选结算方式、或里面有没填好的必填项时自动展开
  const [moreOpen, setMoreOpen] = useState(false),
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

/** 从收件箱新建时对照的原文：收件箱由识别导入提供（插槽里的服务接口），不是从收件箱新建或没装上收件箱时不读 */
function useInboxItem(inbox: Slots['inbox'], inboxId: number | undefined) {
  const load = inbox && inboxId ? () => inbox.item(inboxId) : null;
  return useLoad(load ? String(inboxId) : null, () => (load ? load() : Promise.reject(new Error('没有要对照的收件。'))))
    .data;
}

/** 保存后的提示：新建、保存、保存并确认各一句 */
const savedText = (number: string | undefined, editing: boolean, confirmed: boolean) =>
  '订单' +
  (number ? ' ' + number : '') +
  (confirmed ? (editing ? ' 已保存并确认。' : ' 已建立并确认。') : editing ? ' 已保存。' : ' 已建立，待确认。');

/** 订单编辑窗的状态和动作：填的内容、保存（保存并确认）、快速建档回填、收件箱原文。数据怎么算在 order-draft.ts。 */
export function useOrderEditor(props: OrderEditorProps) {
  const { value, inboxId, customers, products, saved } = props;
  // 从收件箱新建时只把原文放在表单上方对照，不解析、不发给模型。收件箱由识别导入提供（插槽里的服务接口）。
  const { inbox } = useSlots();
  const inboxItem = useInboxItem(inbox, inboxId);
  const [availableCustomers, setAvailableCustomers] = useState(customers),
    [availableProducts, setAvailableProducts] = useState(products),
    [quickCreate, setQuickCreate] = useState<null | { kind: 'customer' | 'product'; line?: number }>(null);
  useEffect(() => setAvailableCustomers(customers), [customers]);
  useEffect(() => setAvailableProducts(products), [products]);
  const d = useOrderDraft(props);
  // 订单状态不在窗口里手选：待确认的订单底部有“保存”和“保存并确认”；
  // 已确认的照原状态保存；生产中、待发货、已发货由生产和送货单据推进。
  const status: OrderInput['status'] = value?.status || '待确认',
    pending = status === '待确认',
    submitStatus = useRef<OrderInput['status']>(status);
  const save = useAction();
  const [invalid, setInvalid] = useState('');
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setInvalid('');
    void save
      .run(async () => {
        // 已有的待确认订单“保存并确认”：整张保存不改状态，先按原状态保存内容，再走“确认订单”这个动作
        const confirmAfter = !!value && pending && submitStatus.current === '已确认';
        const { customerId, orderDate, deliveryDate, notes, lines, costed, costs, extras } = d;
        const body = { value, extras, customerId, orderDate, deliveryDate, notes, lines, costed, costs };
        let record = await saveOrder(value?.id, orderPayload({ ...body, status: confirmAfter ? status : submitStatus.current }));
        if (confirmAfter) record = await changeOrderStatus(record, 'confirm');
        // 订单已保存；收件状态没改成时不影响订单，收件箱里仍可手动标记已处理。
        if (inboxItem?.status === 'pending') await inbox?.converted(inboxItem, 'order').catch(() => {});
        saved();
        notify(savedText(record?.number || value?.number, !!value, pending && submitStatus.current === '已确认'));
      })
      // 回车提交时按原状态保存；要确认就点“保存并确认”
      .finally(() => (submitStatus.current = status));
  };
  const chooseProduct = (index: number, id: string) => {
    const p = availableProducts.find((x) => x.id === Number(id));
    d.setLines((rows) => rows.map((l, i) => (i === index ? fillProduct(l, p, id) : l)));
  };
  /** 快速新建客户、产品后选进当前订单（产品带出名称、料号、规格和参考单价，和下拉选产品一样） */
  const customerCreated = (record: Customer) => {
    setAvailableCustomers((v) => [...v.filter((x) => x.id !== record.id), record]);
    d.setCustomerId(String(record.id));
    setQuickCreate(null);
    emit('erp-business-changed');
  };
  const productCreated = (record: Product) => {
    setAvailableProducts((v) => [...v.filter((x) => x.id !== record.id), record]);
    const line = quickCreate?.line;
    d.setLines((v) => v.map((l, i) => (i === line ? fillProduct(l, record, String(record.id)) : l)));
    setQuickCreate(null);
    emit('erp-business-changed');
  };
  return {
    ...d,
    inbox, inboxItem, availableCustomers, availableProducts, quickCreate, setQuickCreate, customerCreated, productCreated,
    status, pending, submitStatus, chooseProduct, submit,
    onInvalid: invalidHandler(d, setInvalid),
    error: invalid || save.error,
    saving: save.busy,
  };
}
