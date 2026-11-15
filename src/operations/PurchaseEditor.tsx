import { useRef, useState, type ReactNode } from 'react';
import type { PurchaseView, StockItemView, SupplierView } from '../../shared/business/index';
import { errorMessage, today } from '../../shared/core/index';
import { ManagementDialog } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import CustomerEditor from '../editors/CustomerEditor';
import { useAuthState } from '../ui/index';
import { purchaseTotalText } from './fields';
import { PurchaseLines, SupplierAndOrder, type PurchaseForm, type PurchaseOrderOption } from './PurchaseEditorParts';
import { blankPurchaseLine, withoutEditorFields, type PurchaseLineForm } from './purchase-seed';
import { changePurchaseStatus, savePurchase, type PurchaseBody } from './purchase-api';

const FORM_ID = 'purchase-editor-form';

type Props = {
  value?: PurchaseView;
  /** 只用于新建，例如从订单“安排订料”带过来的关联订单和预填明细、从供应商或原材料带过来的 */
  initialValues?: Partial<PurchaseForm>;
  /** 换掉默认的保存，自己存、自己办完（例如多张订单“每张一张采购单”时按订单拆开保存）；办完不再调 saved */
  submit?: (body: PurchaseBody) => Promise<void>;
  /** 保存按钮的字，默认“保存采购单” */
  saveLabel?: string;
  /** 放在表单最上面的内容，例如几张订单生成采购单时选“合成一张 / 每单一张” */
  banner?: ReactNode;
  suppliers: readonly SupplierView[];
  orders: readonly PurchaseOrderOption[];
  items: readonly StockItemView[];
  close: () => void;
  saved: (result: PurchaseView) => void;
};

/** 打开窗口时的表单：改的是采购单本身（状态按库里存的），新建的是空白单加预填 */
const initialForm = (value: PurchaseView | undefined, initialValues: Partial<PurchaseForm> | undefined): PurchaseForm =>
  value
    ? { ...value, status: value.baseStatus }
    : {
        supplierId: '',
        customerOrderId: null,
        orderDate: today(),
        expectedDate: '',
        status: '待订货',
        notes: '',
        lines: [blankPurchaseLine()],
        ...initialValues,
      };

/** 交给服务端的内容：去掉编辑窗才有的字段，供应商、关联订单换成数字，预计到货没填是 null */
const purchaseBody = (form: PurchaseForm, status: PurchaseForm['status']): PurchaseBody => ({
  ...form,
  status,
  lines: withoutEditorFields(form.lines),
  supplierId: Number(form.supplierId),
  customerOrderId: form.customerOrderId ? Number(form.customerOrderId) : null,
  expectedDate: form.expectedDate || null,
});

/** 标题下面写的关联订单：下拉里有的写单号和客户，没有的（历史订单）写采购单记着的单号 */
function orderLabelOf(form: PurchaseForm, orders: Props['orders'], value: PurchaseView | undefined) {
  const order = orders.find((o) => o.id === Number(form.customerOrderId));
  if (order) return order.number + (order.customerName ? ' · ' + order.customerName : '');
  return form.customerOrderId && value?.customerOrderNumber ? value.customerOrderNumber : '';
}

/** 底部：合计、取消、“保存为待到货”（只有待订货的有）、保存 */
function PurchaseFooter({
  form,
  isNew,
  busy,
  saveLabel,
  close,
  saveAsOrdered,
}: {
  form: PurchaseForm;
  isNew: boolean;
  busy: boolean;
  saveLabel?: string;
  close: () => void;
  saveAsOrdered: () => void;
}) {
  return (
    <EditorFooter
      note={
        <>
          合计 <strong className="pur-total">{purchaseTotalText(form.lines)}</strong>
          {isNew && <span> · 单号保存时生成</span>}
        </>
      }
    >
      <button type="button" className="secondary" disabled={busy} onClick={close}>
        取消
      </button>
      {/* 订货状态不在窗口里手选：待订货的单子可以直接存成已订货（电话里已经订了、不用发订货单时）；
          退回待订货、取消、恢复在详情的“更多”里 */}
      {form.status === '待订货' && (
        <button type="button" className="secondary" disabled={busy} title="已经在电话里订好了、不用导出订货单时用" onClick={saveAsOrdered}>
          保存为待到货
        </button>
      )}
      <button type="submit" form={FORM_ID} className="primary" disabled={busy}>
        {busy ? '正在保存…' : saveLabel || '保存采购单'}
      </button>
    </EditorFooter>
  );
}

/** 已有到货时的提示、按订单或原材料预填时的提示 */
function EditorNotes({ locked, flexible, seeded }: { locked: boolean; flexible: boolean; seeded?: readonly PurchaseLineForm[] }) {
  return (
    <>
      {locked && (
        <FormMessage tone="info">
          {flexible
            ? '这张采购已有到货，仍可直接修改。计划和实收分开保存；改供应商或纸板规格会解除旧的到货匹配，到货和库存数量保留。'
            : '这张采购已有到货：供应商和纸板规格不能再改，计划和实收分开记录。'}
        </FormMessage>
      )}
      {seeded && (
        <FormMessage tone="info">
          {seeded.every((l) => l.stockItemId)
            ? '已按选中的库存品带出纸板名称、尺寸、材质和楞型，到货入这些库存品；张数和单价自己填。'
            : '已按订单产品带出材质和楞型。纸板尺寸和张数要按开料自己填，系统不推算；单价按供应商报价填。'}
        </FormMessage>
      )}
    </>
  );
}

/**
 * 采购单编辑窗：向谁订、什么时候要、订哪些纸板（每种纸板一张卡片，次要字段收进“更多”）。
 * initialValues 只用于新建，例如从订单“安排订料”带过来的关联订单和预填明细。
 */
export function PurchaseEditor({ value, initialValues, suppliers, orders, items, close, saved, submit, saveLabel, banner }: Props) {
  const [form, setForm] = useState<PurchaseForm>(() => initialForm(value, initialValues)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  /** 点“保存为已订货”时临时记下要存的状态；平时按原状态保存（新单是待订货） */
  const submitStatus = useRef<PurchaseForm['status'] | null>(null);
  const auth = useAuthState();
  const [createdSuppliers, setCreatedSuppliers] = useState<SupplierView[]>([]),
    [quickSupplier, setQuickSupplier] = useState(false);
  const locked = !!value?.receipts.length,
    flexible = !!auth?.actor?.localAdministrator,
    frozen = locked && !flexible;
  const patch = (v: Partial<PurchaseForm>) => setForm((s) => ({ ...s, ...v })),
    editLine = (i: number, v: Partial<PurchaseLineForm>) =>
      setForm((s) => ({ ...s, lines: s.lines.map((l, n) => (i === n ? { ...l, ...v } : l)) }));
  const orderLabel = orderLabelOf(form, orders, value);
  const seeded = !value && initialValues?.lines?.length ? initialValues.lines : undefined;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      // 已有的采购单“保存为待到货”：整张保存不改状态，先按原状态保存内容，再走“改成待到货”这个动作
      const confirmAfter = !!value && submitStatus.current === '已订货' && form.status === '待订货';
      const body = purchaseBody(form, confirmAfter ? form.status : submitStatus.current || form.status);
      if (submit) return await submit(body);
      const result = await savePurchase(body, value?.id);
      saved(confirmAfter ? await changePurchaseStatus(result, 'confirm') : result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ManagementDialog
      title={value ? '编辑采购单 ' + value.number : '新建采购单'}
      subtitle={[value?.supplierName, orderLabel ? '关联订单 ' + orderLabel : ''].filter(Boolean).join(' · ') || undefined}
      size="xl"
      close={close}
      busy={busy}
      footer={
        <PurchaseFooter
          form={form}
          isNew={!value}
          busy={busy}
          saveLabel={saveLabel}
          close={close}
          saveAsOrdered={() => {
            // 不做成默认提交按钮：在输入框里按回车只按原状态保存
            submitStatus.current = '已订货';
            const formElement = document.getElementById(FORM_ID);
            if (formElement instanceof HTMLFormElement) formElement.requestSubmit();
            submitStatus.current = null;
          }}
        />
      }
    >
      <form
        id={FORM_ID}
        className="pur-editor"
        data-agent-module={value ? 'purchases' : undefined}
        data-agent-record={value?.id}
        data-agent-label={value?.number}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormMessage>{error}</FormMessage>
        {banner}
        <EditorNotes locked={locked} flexible={flexible} seeded={seeded} />
        <SupplierAndOrder
          form={form}
          value={value}
          suppliers={suppliers}
          created={createdSuppliers}
          orders={orders}
          frozen={frozen}
          patch={patch}
          newSupplier={() => setQuickSupplier(true)}
        />
        <FormSection title="什么时候要" columns={2}>
          <FormField label="采购日期" required>
            <input
              type="date"
              aria-label="采购日期"
              required
              disabled={frozen}
              value={form.orderDate}
              onChange={(e) => patch({ orderDate: e.target.value })}
            />
          </FormField>
          <FormField label="预计到货">
            <input type="date" aria-label="预计到货日期" value={form.expectedDate || ''} onChange={(e) => patch({ expectedDate: e.target.value })} />
          </FormField>
        </FormSection>
        <PurchaseLines
          form={form}
          value={value}
          initialLines={initialValues?.lines}
          orders={orders}
          items={items}
          frozen={frozen}
          patch={patch}
          editLine={editLine}
        />
        <FormSection columns={1}>
          <FormField label="备注" span="full" hint="交货地址、税率、付款条件按实际约定写。">
            <textarea aria-label="采购备注" maxLength={1000} value={form.notes} onChange={(e) => patch({ notes: e.target.value })} />
          </FormField>
        </FormSection>
      </form>
      {quickSupplier && (
        <CustomerEditor
          entity="suppliers"
          quick
          close={() => setQuickSupplier(false)}
          saved={(s) => {
            setCreatedSuppliers((v) => [...v, s]);
            patch({ supplierId: s.id });
            setQuickSupplier(false);
          }}
        />
      )}
    </ManagementDialog>
  );
}
