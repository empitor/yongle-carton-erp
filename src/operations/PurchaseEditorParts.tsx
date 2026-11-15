import { Plus } from 'lucide-react';
import type { PurchaseView, StockItemView, SupplierView } from '../../shared/business/index';
import type { Order } from '../../shared/core/index';
import { Combobox, FormField, FormSection } from '../ui/index';
import PurchaseLineCard from './PurchaseLineCard';
import { blankPurchaseLine, type PurchaseLineForm } from './purchase-seed';

/** 采购单编辑窗（PurchaseEditor.tsx）的几块：向谁订货、订哪些纸板。表单的样子也在这里。 */

/** 编辑窗下拉里的订单：单号、客户名，归档的标出来 */
export type PurchaseOrderOption = Pick<Order, 'id' | 'number' | 'customerName'> & { archived?: boolean };
/**
 * 采购单编辑窗的表单：新建的是空白单（可带预填），改的是采购单视图本身（多带的字段原样留着、整张交给服务端）。
 * 供应商在下拉里是文字，交之前换成数字；预计到货没填是空串，交之前换成 null。
 */
export type PurchaseForm = {
  supplierId: string | number;
  customerOrderId: number | null;
  orderDate: string;
  expectedDate: string | null;
  status: PurchaseView['baseStatus'];
  notes: string;
  lines: PurchaseLineForm[];
  /** 改的时候是打开时读到的版本号 */
  version?: number;
};
type Patch = (v: Partial<PurchaseForm>) => void;

/** 向谁订货：供应商（含刚新建的、历史档案）、关联客户订单 */
export function SupplierAndOrder({
  form,
  value,
  suppliers,
  created,
  orders,
  frozen,
  patch,
  newSupplier,
}: {
  form: PurchaseForm;
  value?: PurchaseView;
  /** 供应商档案 */
  suppliers: readonly SupplierView[];
  /** 这次在窗口里刚新建的供应商（下拉里接在档案后面） */
  created: readonly SupplierView[];
  orders: readonly PurchaseOrderOption[];
  frozen: boolean;
  patch: Patch;
  newSupplier: () => void;
}) {
  // 一张采购单给几张订单订料：各行自己关联订单
  const lineOrders = form.lines.some((l) => l.customerOrderId);
  return (
    <FormSection
      title="向谁订货"
      extra={
        <button type="button" className="secondary" disabled={frozen} onClick={newSupplier}>
          <Plus size={14} aria-hidden="true" />
          新建供应商
        </button>
      }
    >
      <FormField label="供应商" required>
        <Combobox
          ariaLabel="供应商"
          required
          disabled={frozen}
          placeholder="搜索供应商"
          value={String(form.supplierId)}
          onChange={(v) => patch({ supplierId: v })}
          options={[
            ...(!suppliers.some((s) => s.id === Number(form.supplierId)) && value
              ? [{ value: String(value.supplierId), label: value.supplierName + '（历史档案）' }]
              : []),
            ...[...suppliers, ...created.filter((s) => !suppliers.some((p) => p.id === s.id))].map((s) => ({
              value: String(s.id),
              label: s.name + (s.archived ? '（已归档）' : ''),
            })),
          ]}
        />
      </FormField>
      <FormField label="关联客户订单" hint={lineOrders ? '各行已分别关联订单（见每种纸板右上角），这里不用再选' : '不选就是独立采购'}>
        <Combobox
          ariaLabel="关联客户订单"
          placeholder={lineOrders ? '按每行关联的订单' : '独立采购，不关联客户订单'}
          value={form.customerOrderId ? String(form.customerOrderId) : ''}
          onChange={(v) => patch({ customerOrderId: v ? Number(v) : null })}
          options={[
            { value: '', label: lineOrders ? '按每行关联的订单' : '独立采购，不关联客户订单' },
            ...(value?.customerOrderId && !orders.some((o) => o.id === value.customerOrderId)
              ? [{ value: String(value.customerOrderId), label: value.customerOrderNumber + '（历史订单）' }]
              : []),
            ...orders.map((o) => ({ value: String(o.id), label: o.number + (o.archived ? '（归档）' : ''), hint: o.customerName })),
          ]}
        />
      </FormField>
    </FormSection>
  );
}

/** 订哪些纸板：每种一张卡片，能加、能移除（只剩一种时不能移除） */
export function PurchaseLines({
  form,
  value,
  initialLines,
  orders,
  items,
  frozen,
  patch,
  editLine,
}: {
  form: PurchaseForm;
  value?: PurchaseView;
  /** 新建时带过来的预填明细（“安排订料”、选了原材料） */
  initialLines?: readonly PurchaseLineForm[];
  orders: readonly PurchaseOrderOption[];
  items: readonly StockItemView[];
  frozen: boolean;
  patch: Patch;
  /** 改第 i 行（按最新的表单改） */
  editLine: (i: number, v: Partial<PurchaseLineForm>) => void;
}) {
  return (
    <FormSection
      title="订哪些纸板"
      hint={frozen ? undefined : '没选库存里已有的纸板要填长和宽；配纸和单价不知道可以先空着；数量必须填，纸板按张。'}
      columns={1}
      extra={
        !frozen && (
          <button
            type="button"
            className="secondary"
            disabled={form.lines.length >= 50}
            onClick={() => patch({ lines: [...form.lines, blankPurchaseLine()] })}
          >
            <Plus size={14} aria-hidden="true" />
            加一种纸板
          </button>
        )
      }
    >
      {form.lines.map((l, i) => (
        <PurchaseLineCard
          key={i}
          line={l}
          index={i}
          count={form.lines.length}
          frozen={frozen}
          orders={orders}
          items={items}
          saved={
            // 已存的明细按原来的；“安排订料”带过来的预填明细按带过来的；新加的行是刚填的，不用确认
            (l.id && value?.lines.find((x) => x.id === l.id)) || (!value && initialLines?.at(i)) || null
          }
          change={(v) => editLine(i, v)}
          remove={() => patch({ lines: form.lines.filter((_, j) => j !== i) })}
        />
      ))}
    </FormSection>
  );
}
