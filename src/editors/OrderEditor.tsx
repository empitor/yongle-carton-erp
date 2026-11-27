import { ORDER_LINES_TITLE } from '../recordkit/OrderLinesView';
import { useId } from 'react';
import { Plus } from 'lucide-react';
import { Combobox, ManagementDialog, EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { centsText, displayAmount, roundingPolicyLabels } from '../../shared/core/index';
import CustomerEditor from './CustomerEditor';
import ProductEditor from './ProductEditor';
import OrderLines from './OrderLines';
import OrderMoreInfo from './OrderMoreInfo';
import { soleRetryButton } from './order-customer-change';
import { useOrderEditor, type OrderEditorProps, type OrderSource } from './useOrderEditor';

type Editor = ReturnType<typeof useOrderEditor>;

/** 底部按钮：待确认的订单有“保存”和“保存并确认”，别的状态只有“保存订单” */
function OrderEditorFooter({ e, formId, close }: { e: Editor; formId: string; close: () => void }) {
  const saving = e.saving;
  return (
    <EditorFooter note={e.pending ? '确认后才能安排生产和送货。' : '订单现在是“' + e.status + '”，保存后不变。'}>
      <button type="button" className="secondary" disabled={saving} onClick={close}>
        取消
      </button>
      {e.pending ? (
        <>
          <button
            type="submit"
            form={formId}
            className="secondary"
            disabled={saving}
            onClick={() => (e.submitStatus.current = '待确认')}
          >
            保存
          </button>
          <button
            type="submit"
            form={formId}
            className="primary"
            disabled={saving}
            onClick={() => (e.submitStatus.current = '已确认')}
          >
            {saving ? '正在保存…' : '保存并确认'}
          </button>
        </>
      ) : (
        <button type="submit" form={formId} className="primary" disabled={saving}>
          {saving ? '正在保存…' : '保存订单'}
        </button>
      )}
    </EditorFooter>
  );
}

/** 表单上方对照的原文资料（由调用方传入） */
function SourceReference({ source }: { source: OrderSource }) {
  return (
    <aside className="sales-order-source" aria-label={source.title}>
      <header>
        <strong>{source.title}</strong>
        {source.meta && <span>{source.meta}</span>}
        {source.hint && <small>{source.hint}</small>}
      </header>
      {source.text && <p>{source.text}</p>}
      {source.file && (
        <a href={source.file.url} download>
          下载 {source.file.name}
        </a>
      )}
    </aside>
  );
}

/** 客户和交期：客户、下单日期、交货日期、客户采购单号 */
function OrderHead({ e, value }: { e: Editor; value: OrderEditorProps['value'] }) {
  return (
    <FormSection
      title="客户和交期"
      columns={4}
      extra={
        <button type="button" className="secondary" disabled={!!e.customerBlocked} onClick={() => e.setQuickCreate({ kind: 'customer' })}>
          <Plus size={14} aria-hidden="true" />
          新建客户
        </button>
      }
    >
      <FormField
        label="客户"
        required
        span={2}
        hint={value ? '下单时客户名称：' + value.customerName + (e.customerWaiting ? '；' + e.customerBlocked : '') : undefined}
      >
        <Combobox
          required
          disabled={!!e.customerBlocked}
          ariaLabel="订单客户"
          placeholder="搜索客户"
          value={String(e.customerId || '')}
          options={e.availableCustomers.map((c) => ({ value: String(c.id), label: c.name, hint: c.contact, keywords: c.phone }))}
          onChange={e.changeCustomer}
        />
      </FormField>
      <FormField label="下单日期" required>
        <input required type="date" value={e.orderDate} onInput={(ev) => e.setOrderDate(ev.currentTarget.value)} />
      </FormField>
      <FormField label="交货日期" required>
        <input
          required
          type="date"
          min={e.orderDate}
          value={e.deliveryDate}
          onInput={(ev) => e.setDeliveryDate(ev.currentTarget.value)}
        />
      </FormField>
      <FormField label="客户采购单号" span={2}>
        <input
          maxLength={100}
          value={e.extras.externalPurchaseOrder}
          onChange={(ev) => e.setExtras((v) => ({ ...v, externalPurchaseOrder: ev.target.value }))}
        />
      </FormField>
    </FormSection>
  );
}

/** 订单明细和合计 */
function OrderLinesSection({ e }: { e: Editor }) {
  const { totalExact, fractional, uncounted } = e.totals,
    retry = soleRetryButton(e.retryingSole);
  return (
    <FormSection
      title={ORDER_LINES_TITLE}
      hint="产品数量按“只”算（客户写“个”也是“只”）。"
      columns={1}
      extra={
        <button type="button" className="secondary" disabled={e.lines.length >= 50} onClick={e.addLine}>
          <Plus size={14} aria-hidden="true" />
          添加明细
        </button>
      }
    >
      {e.customerBlocked && !e.customerWaiting && (
        <FormMessage
          action={
            <button type="button" className="secondary" disabled={retry.disabled} onClick={e.retrySole}>
              {retry.label}
            </button>
          }
        >
          {e.customerBlocked}
        </FormMessage>
      )}
      {e.customerNotice && <FormMessage tone="warning">{e.customerNotice}</FormMessage>}
      <OrderLines
        lines={e.lines}
        products={e.availableProducts}
        customerId={e.customerId ? Number(e.customerId) : null}
        keptProducts={e.keptProducts}
        orderDate={e.orderDate}
        open={e.open}
        toggle={(k) => e.setOpen((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))}
        change={e.changeLine}
        choose={e.chooseProduct}
        quick={(i) => e.setQuickCreate({ kind: 'product', line: i })}
        remove={(i) => e.setLines((rows) => rows.filter((_, n) => n !== i))}
      />
      <div className="sales-order-total">
        {uncounted.length > 0 && (
          <span className="sales-order-total-note">第 {uncounted.join('、')} 项金额算不出来，填好单价和数量后再算合计</span>
        )}
        <span>订单合计</span>
        <strong>{uncounted.length ? '—' : '¥' + displayAmount(totalExact)}</strong>
      </div>
      {fractional && e.extras.roundingPolicy === 'exact-cents' && (
        <FormMessage tone="warning">
          合计有不足一分的尾数，保存前在下面“更多信息”的“金额结算”里选“{roundingPolicyLabels['half-up-cent']}”。
        </FormMessage>
      )}
    </FormSection>
  );
}

/** 订单编辑窗：客户、日期、明细、合计和“更多信息”（税费、合同条件、结算、预估成本）。状态和保存在 useOrderEditor.ts。 */
export default function OrderEditor(props: OrderEditorProps) {
  const { value, source, close, loading = false } = props;
  const formId = useId();
  const e = useOrderEditor(props);
  const { total, fractional, costTotal, uncounted } = e.totals;
  return (
    <ManagementDialog
      title={value ? '编辑订单' : '新建订单'}
      subtitle={value ? value.number : undefined}
      size="xl"
      busy={e.saving}
      close={close}
      footer={<OrderEditorFooter e={e} formId={formId} close={close} />}
    >
      <form id={formId} className="sales-form sales-order-editor" onSubmit={e.submit} onInvalid={e.onInvalid}>
        <FormMessage>{e.error}</FormMessage>
        {source && <SourceReference source={source} />}
        {!loading && (!e.availableCustomers.length || !e.availableProducts.length) && (
          <FormMessage tone="info">还没有客户或产品档案，可以用“新建客户”和每行的“+”先建档，已填的内容会保留。</FormMessage>
        )}
        <OrderHead e={e} value={value} />
        <OrderLinesSection e={e} />
        <FormSection columns={1}>
          <FormField label="订单备注" span="full">
            <textarea rows={2} maxLength={1000} value={e.notes} onChange={(ev) => e.setNotes(ev.target.value)} />
          </FormField>
        </FormSection>
        <OrderMoreInfo
          open={e.moreOpen || (fractional && e.extras.roundingPolicy === 'exact-cents')}
          setOpen={e.setMoreOpen}
          extras={e.extras}
          setExtras={e.setExtras}
          costed={e.costed}
          setCosted={e.setCosted}
          costs={e.costs}
          setCosts={e.setCosts}
          costText={centsText(costTotal)}
          profitText={uncounted.length ? '—' : centsText(total - costTotal)}
        />
      </form>
      {e.quickCreate?.kind === 'customer' && (
        <CustomerEditor close={() => e.setQuickCreate(null)} saved={e.customerCreated} />
      )}
      {e.quickCreate?.kind === 'product' && (
        <ProductEditor
          defaultCustomerId={e.customerId ? Number(e.customerId) : undefined}
          customers={e.availableCustomers}
          close={() => e.setQuickCreate(null)}
          saved={e.productCreated}
        />
      )}
    </ManagementDialog>
  );
}
