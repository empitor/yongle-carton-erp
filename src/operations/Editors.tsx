import { useState, type ReactNode } from 'react';
import ManagementDialog from '../ManagementDialog';
import QuickPartyDialog from '../QuickPartyDialog';
import DimensionUnitSelect from '../DimensionUnitSelect';
import { managementRequest, useAuthState } from '../session';
import { today } from '../../shared/domain';
import {
  convertDimension,
  normalizeDimensionUnit,
  dimensionKeys,
} from '../../shared/product-details';
import { lineMoney, sumMoney, formatStockSize } from '../../shared/operations';
import { purchaseLineAmount } from '../../shared/physical-flow';
export function OpField({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={'op-field' + (wide ? ' op-wide' : '')}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Dimensions({
  value,
  change,
  disabled = false,
}: {
  value: any;
  change: (patch: any) => void;
  disabled?: boolean;
}) {
  return (
    <div className="op-dimensions">
      <DimensionUnitSelect
        unit={value.dimensionUnit}
        hasValues={dimensionKeys.some((k) => value[k] != null)}
        disabled={disabled}
        onChange={(to) => {
          const from = normalizeDimensionUnit(value.dimensionUnit);
          change({
            dimensionUnit: to,
            ...(from && to
              ? Object.fromEntries(
                  dimensionKeys.map((k) => [k, convertDimension(value[k] ?? null, from, to)]),
                )
              : {}),
          });
        }}
      />
      {dimensionKeys.map((k, i) => (
        <OpField
          key={k}
          label={
            ['长', '宽', '高（可选）'][i] + (value.dimensionUnit ? ' / ' + value.dimensionUnit : '')
          }
        >
          <input
            type="number"
            step="any"
            min="0.0000001"
            max={value.dimensionUnit === 'cm' ? 1000 : 10000}
            disabled={disabled}
            value={value[k] ?? ''}
            onChange={(e) => change({ [k]: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </OpField>
      ))}
    </div>
  );
}
export function blankStock(kind = 'raw') {
  return {
    name: kind === 'raw' ? '瓦楞纸板' : '成品纸箱',
    kind,
    unit: kind === 'raw' ? '张' : '只',
    specification: '',
    length: null,
    width: null,
    height: null,
    dimensionUnit: null,
    material: '',
    flute: '',
    notes: '',
    productId: null,
  };
}
const blankLine = () => ({
  ...blankStock(),
  stockItemId: null,
  quantity: '',
  unitPrice: null,
  priceBasis: 'area',
});
function amount(l: any) {
  try {
    return (
      (l.priceBasis === 'area' ? purchaseLineAmount(l) : lineMoney(l.quantity, l.unitPrice)) ||
      '待定价/面积待完善'
    );
  } catch {
    return '待填写';
  }
}
export function PurchaseEditor({
  value,
  suppliers,
  orders,
  items,
  close,
  saved,
}: {
  value?: any;
  suppliers: any[];
  orders: any[];
  items: any[];
  close: () => void;
  saved: () => void;
}) {
  const [form, setForm] = useState<any>(
      value
        ? { ...value, status: value.baseStatus }
        : {
            supplierId: '',
            customerOrderId: null,
            orderDate: today(),
            expectedDate: '',
            status: '待订货',
            notes: '',
            lines: [blankLine()],
          },
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const auth = useAuthState();
  const [createdSuppliers, setCreatedSuppliers] = useState<any[]>([]),
    [quickSupplier, setQuickSupplier] = useState(false);
  const supplierOptions = [
    ...suppliers,
    ...createdSuppliers.filter((s) => !suppliers.some((p) => p.id === s.id)),
  ];
  const locked = !!value?.receipts.length,
    flexible = !!auth?.actor?.localAdministrator;
  const patch = (v: any) => setForm((s: any) => ({ ...s, ...v })),
    line = (i: number, v: any) =>
      setForm((s: any) => ({
        ...s,
        lines: s.lines.map((l: any, n: number) => (i === n ? { ...l, ...v } : l)),
      }));
  return (
    <ManagementDialog
      title={value ? '编辑采购单 ' + value.number : '新建瓦楞纸板采购单'}
      close={close}
      busy={busy}
    >
      <form
        className="op-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const result = await managementRequest<any>(
              '/purchases' + (value ? '/' + value.id : ''),
              {
                ...form,
                supplierId: Number(form.supplierId),
                customerOrderId: form.customerOrderId ? Number(form.customerOrderId) : null,
                expectedDate: form.expectedDate || null,
              },
              value ? 'PUT' : 'POST',
            );
            saved();
            if ((e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'preview')
              location.hash = 'purchases?record=' + result.id + '&previewDocument=1';
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-section-heading">
          <h3>供应商与采购安排</h3>
          <span>标 * 为必填，单号保存时生成。</span>
        </div>
        <div className="op-form-grid">
          <OpField label="供应商 *">
            <select
              required
              disabled={locked && !flexible}
              value={form.supplierId}
              onChange={(e) => patch({ supplierId: e.target.value })}
            >
              <option value="">请选择供应商</option>
              {!suppliers.some((s) => s.id === Number(form.supplierId)) && value && (
                <option value={value.supplierId}>{value.supplierName}（历史档案）</option>
              )}
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.archived ? '（停用）' : ''}
                </option>
              ))}
            </select>
          </OpField>
          <button
            type="button"
            disabled={locked && !flexible}
            onClick={() => setQuickSupplier(true)}
          >
            新增供应商，保留当前采购单
          </button>
          <OpField label="关联客户订单（可不选）">
            <select
              value={form.customerOrderId ?? ''}
              onChange={(e) =>
                patch({ customerOrderId: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">独立采购，不关联客户订单</option>
              {value?.customerOrderId && !orders.some((o) => o.id === value.customerOrderId) && (
                <option value={value.customerOrderId}>
                  {value.customerOrderNumber}（历史订单）
                </option>
              )}
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.number} · {o.customerName}
                  {o.archived ? '（归档）' : ''}
                </option>
              ))}
            </select>
          </OpField>
          <OpField label="采购日期 *">
            <input
              type="date"
              required
              disabled={locked && !flexible}
              value={form.orderDate}
              onChange={(e) => patch({ orderDate: e.target.value })}
            />
          </OpField>
          <OpField label="预计到货日期">
            <input
              type="date"
              value={form.expectedDate || ''}
              onChange={(e) => patch({ expectedDate: e.target.value })}
            />
          </OpField>
          <OpField label="订货状态">
            <select value={form.status} onChange={(e) => patch({ status: e.target.value })}>
              <option disabled={locked && !flexible}>待订货</option>
              <option>已订货</option>
              <option disabled={!flexible && value?.status === '全部到货'}>已取消</option>
            </select>
          </OpField>
        </div>
        <p className="op-hint">
          部分到货、全部到货由实际登记自动计算。
          {locked
            ? flexible
              ? '可直接修改已有到货的采购。计划与实际收货分别保存；更改供应商或实物身份时解除旧到货匹配，保留独立到货和库存数量。'
              : '已有到货的实物身份保留；计划与实收分别记录。'
            : '尺寸、配纸、楞型和价格暂时未知可留空，数量单位需明确。'}
        </p>
        <div className="form-section-heading">
          <h3>采购明细</h3>
          <span>尺寸单位与数量单位分别填写，未知价格可留空。</span>
        </div>
        {form.lines.map((l: any, i: number) => (
          <fieldset className="op-line-card" key={i} disabled={locked && !flexible}>
            <legend>采购明细 {i + 1}</legend>
            <div className="op-form-grid">
              <OpField label="原材料档案" wide>
                <select
                  value={l.stockItemId ?? ''}
                  onChange={(e) => {
                    const stock = items.find((s) => s.id === Number(e.target.value));
                    line(
                      i,
                      stock
                        ? {
                            ...stock,
                            id: l.id,
                            stockItemId: stock.id,
                            quantity: l.quantity,
                            unitPrice: l.unitPrice,
                          }
                        : { stockItemId: null },
                    );
                  }}
                >
                  <option value="">到货时新建独立库存品</option>
                  {items
                    .filter((s) => s.kind === 'raw' && !s.archived)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.specification || formatStockSize(s)} · {s.unit}
                      </option>
                    ))}
                </select>
              </OpField>
              <OpField label="纸板名称 *">
                <input
                  required
                  maxLength={100}
                  value={l.name}
                  onChange={(e) => line(i, { name: e.target.value })}
                />
              </OpField>
              <OpField label="规格说明">
                <input
                  maxLength={2000}
                  value={l.specification}
                  onChange={(e) => line(i, { specification: e.target.value })}
                />
              </OpField>
              <div className="op-wide">
                <Dimensions value={l} change={(v) => line(i, v)} />
              </div>
              <OpField label="楞型">
                <input
                  value={l.flute}
                  maxLength={50}
                  onChange={(e) => line(i, { flute: e.target.value })}
                />
              </OpField>
              <OpField label="材质 / 配纸">
                <input
                  value={l.material}
                  maxLength={100}
                  onChange={(e) => line(i, { material: e.target.value })}
                />
              </OpField>
              <OpField label="订货数量 *">
                <input
                  required
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => line(i, { quantity: e.target.value })}
                />
              </OpField>
              <OpField label="数量单位 *">
                <input
                  required
                  maxLength={20}
                  value={l.unit}
                  onChange={(e) => line(i, { unit: e.target.value })}
                />
              </OpField>
              <OpField label="单价 / 元（可待定，最多4位小数）">
                <input
                  inputMode="decimal"
                  value={l.unitPrice ?? ''}
                  onChange={(e) => line(i, { unitPrice: e.target.value || null })}
                />
              </OpField>
              <OpField label="计价依据">
                <select
                  value={l.priceBasis || 'quantity'}
                  onChange={(e) => line(i, { priceBasis: e.target.value })}
                >
                  <option value="area">平方米（库存仍按张）</option>
                  <option value="quantity">数量单位</option>
                </select>
              </OpField>
              <OpField label="程序计算金额 / 元">
                <output>{amount(l)}</output>
              </OpField>
              <OpField label="明细备注" wide>
                <textarea
                  maxLength={1000}
                  value={l.notes}
                  onChange={(e) => line(i, { notes: e.target.value })}
                />
              </OpField>
            </div>
            {(!locked || flexible) && form.lines.length > 1 && (
              <button
                type="button"
                className="danger"
                onClick={() => patch({ lines: form.lines.filter((_: any, n: number) => n !== i) })}
              >
                移除此未保存明细
              </button>
            )}
          </fieldset>
        ))}
        {(!locked || flexible) && (
          <button
            type="button"
            onClick={() => patch({ lines: [...form.lines, blankLine()] })}
            disabled={form.lines.length >= 50}
          >
            添加纸板明细
          </button>
        )}
        <div className="purchase-amount-total">
          <span>采购金额合计 / 元</span>
          <strong>
            {(() => {
              try {
                return (
                  sumMoney(
                    form.lines.map((l: any) =>
                      l.priceBasis === 'area'
                        ? purchaseLineAmount(l)
                        : lineMoney(l.quantity, l.unitPrice),
                    ),
                  ) || '待定价'
                );
              } catch {
                return '待完善明细';
              }
            })()}
          </strong>
        </div>
        <OpField label="采购备注 / 本单交货、税费及付款约定（选填）">
          <textarea
            maxLength={1000}
            placeholder="按实际约定填写交货地址、税率及含税口径、验收和付款条件；系统不自动推算未知税额。"
            value={form.notes}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </OpField>
        {error && (
          <p className="operation-error" role="alert">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存采购单'}
          </button>
          <button type="submit" name="next" value="preview" disabled={busy}>
            保存并预览订货单
          </button>
        </div>
      </form>
      {quickSupplier && (
        <QuickPartyDialog
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
export function StockEditor({
  value,
  initialValues,
  kind,
  products,
  close,
  saved,
}: {
  value?: any;
  initialValues?: any;
  kind: string;
  products: any[];
  close: () => void;
  saved: (item?: any) => void;
}) {
  const [form, setForm] = useState<any>(value || { ...blankStock(kind), ...initialValues }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const patch = (v: any) => setForm((s: any) => ({ ...s, ...v }));
  return (
    <ManagementDialog
      title={value ? '编辑库存品' : '新建' + (kind === 'raw' ? '原材料' : '成品') + '库存品'}
      close={close}
      busy={busy}
    >
      <form
        className="op-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const item = await managementRequest(
              '/warehouse/items' + (value ? '/' + value.id : ''),
              form,
              value ? 'PUT' : 'POST',
            );
            saved(item);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="op-form-grid">
          <OpField label="库存品名称 *">
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </OpField>
          <OpField label="数量单位 *">
            <input
              required
              maxLength={20}
              value={form.unit}
              onChange={(e) => patch({ unit: e.target.value })}
            />
          </OpField>
          {kind === 'finished' && (
            <OpField label="关联纸箱产品" wide>
              <select
                value={form.productId ?? ''}
                onChange={(e) => {
                  const p = products.find((p) => p.id === Number(e.target.value));
                  patch(
                    p
                      ? {
                          productId: p.id,
                          name: p.name,
                          length: p.length,
                          width: p.width,
                          height: p.height,
                          dimensionUnit: p.dimensionUnit,
                          material: p.material,
                          flute: p.flute,
                        }
                      : { productId: null },
                  );
                }}
              >
                <option value="">不关联产品档案</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </OpField>
          )}
          <OpField label="规格说明" wide>
            <input
              maxLength={2000}
              value={form.specification}
              onChange={(e) => patch({ specification: e.target.value })}
            />
          </OpField>
          <div className="op-wide">
            <Dimensions value={form} change={patch} />
          </div>
          <OpField label="楞型">
            <input
              value={form.flute}
              onChange={(e) => patch({ flute: e.target.value })}
              maxLength={50}
            />
          </OpField>
          <OpField label="材质 / 配纸">
            <input
              value={form.material}
              onChange={(e) => patch({ material: e.target.value })}
              maxLength={100}
            />
          </OpField>
          <OpField label="备注" wide>
            <textarea
              maxLength={1000}
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </OpField>
        </div>
        <p className="op-hint">
          此表单不修改库存数量。已有流水后不可改动数量单位或实际规格；库存变化请使用入库、出库或盘点。
        </p>
        {error && (
          <p role="alert" className="operation-error">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在保存…' : '保存库存品'}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
export function MovementDialog({
  item,
  orders,
  close,
  saved,
}: {
  item: any;
  orders: any[];
  close: () => void;
  saved: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID()),
    [action, setAction] = useState('in'),
    [quantity, setQuantity] = useState(''),
    [date, setDate] = useState(today()),
    [notes, setNotes] = useState(''),
    [orderId, setOrderId] = useState(''),
    [agreed, setAgreed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const direct = !!useAuthState()?.actor?.localAdministrator;
  return (
    <ManagementDialog title={'库存操作 · ' + item.name} close={close} busy={busy}>
      <form
        className="op-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await managementRequest('/warehouse/items/' + item.id + '/move', {
              expectedVersion: item.version,
              requestId,
              action,
              quantity,
              date,
              notes,
              customerOrderId: orderId ? Number(orderId) : null,
              acknowledged: true,
            });
            saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="op-balance">
          当前库存 <strong>{item.quantity}</strong> {item.unit}
        </div>
        <div className="op-form-grid">
          <OpField label="操作类型">
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="in">手动入库</option>
              <option value="out">手动出库</option>
              <option value="adjust">盘点调整</option>
            </select>
          </OpField>
          <OpField
            label={
              (action === 'adjust' ? '实盘数量（调整后余额）' : '本次数量') +
              ' / ' +
              item.unit +
              ' *'
            }
          >
            <input
              required
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </OpField>
          <OpField label="业务日期 *">
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </OpField>
          <OpField label="关联客户订单（可不选）">
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">不关联</option>
              {orders.map((o) => (
                <option value={o.id} key={o.id}>
                  {o.number}
                </option>
              ))}
            </select>
          </OpField>
          <OpField label="出入库用途 / 盘点原因 *" wide>
            <textarea
              required
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </OpField>
        </div>
        <p className="op-hint">
          每次操作都保存原余额、变动量、结果余额和操作者；盘点填写实际总余额，不能通过编辑表单改数。
        </p>
        {!direct && (
          <label className="op-agreement">
            <input
              type="checkbox"
              required
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            已核对实物及数量，确认登记此流水。
          </label>
        )}
        {error && (
          <p role="alert" className="operation-error">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || (!direct && !agreed)}>
            {busy ? '正在登记…' : '确认库存变动'}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
