import { FINISHED_UNIT, RAW_UNIT, nameWithCustomer, specification, type Product, fieldLabel } from '../../shared/core/index';
import { sizeText, type StockItemView } from '../../shared/business/index';
import { Combobox, FormField, FormSection } from '../ui/index';
import { DimensionFields } from './fields';
import type { StockFields } from './purchase-seed';

/**
 * 库存品编辑窗（StockEditor.tsx）的字段：成品的“是什么”（选产品）和跟着产品的规格，原材料自己填的名称和规格，备注。
 */

/**
 * 编辑窗的表单：新建时是空白库存品（purchase-seed.ts 的 blankStock），修改时就是打开的那个库存品
 * （整个交上去，带着打开时读到的版本号；视图里多的几项服务端不收）
 */
export type StockForm = StockFields & { version?: number };
type Patch = (patch: Partial<StockForm>) => void;

const shown = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? '—' : String(v));

/** 成品选了产品：名称、尺寸、材质、楞型、规格说明都按这个产品（服务端保存时也按产品填） */
export const fromProduct = (p: Product): Partial<StockForm> => ({
  productId: p.id,
  name: p.name,
  length: p.length ?? null,
  width: p.width ?? null,
  height: p.height ?? null,
  dimensionUnit: p.dimensionUnit ?? null,
  material: p.material ?? '',
  flute: p.flute ?? '',
  specification: specification(p),
});

/** 成品的“是什么”：选产品（用过的不能换，只显示），库存品名称跟着产品，数量单位只有“只” */
export function ProductPicker(o: {
  form: StockForm;
  product: Product | undefined;
  productId: number | null;
  products: Product[];
  /** 关联产品已归档不在下拉里时，沿用库存品视图带出的所属客户名 */
  fallbackCustomerName?: string;
  /** 有没有出入库记录或被单据用过；null 是还没读到 */
  used: boolean | null;
  choose: (productId: string) => void;
}) {
  // 产品不在下拉里（比如已归档）时，按库存品自己记的（本来就是从产品来的）显示
  const shownProduct = o.product || (o.productId ? o.form : null);
  const customerName = o.product?.customerName || (o.productId ? o.fallbackCustomerName : undefined);
  const options = o.products.map((p) => ({
    value: String(p.id),
    label: p.name,
    hint: [p.customerName, sizeText(p)].filter(Boolean).join(' · ') || undefined,
  }));
  if (o.productId && !o.product)
    options.unshift({
      value: String(o.productId),
      label: o.form.name,
      hint: [customerName, sizeText(o.form)].filter(Boolean).join(' · ') || undefined,
    });
  return (
    <FormSection title="是什么">
      <FormField
        label="产品"
        required
        span="full"
        hint={
          o.used
            ? '这个成品已有出入库记录或被单据用过，不能换产品；另一种产品的成品请新建'
            : '名称、尺寸、材质、楞型、规格都按这个产品'
        }
      >
        {o.used ? (
          <output className="unit-fixed" aria-label="产品">
            {nameWithCustomer(o.product?.name || o.form.name, customerName)}
          </output>
        ) : (
          <Combobox
            ariaLabel="产品"
            required
            disabled={o.used === null}
            placeholder="选这是哪个产品的成品"
            value={o.productId ? String(o.productId) : ''}
            onChange={o.choose}
            options={options}
          />
        )}
      </FormField>
      <FormField label="库存品名称">
        <output className="unit-fixed" aria-label="库存品名称">
          {shownProduct ? nameWithCustomer(shownProduct.name, customerName) : '先选产品'}
        </output>
      </FormField>
      <FormField label="数量单位" hint="成品只按“只”记（“个”就是“只”）">
        <output className="unit-fixed" aria-label="数量单位">
          {FINISHED_UNIT}
        </output>
      </FormField>
    </FormSection>
  );
}

/** 成品的规格：跟着产品，只显示；产品不在下拉里时按库存品自己记的 */
export function FinishedSpec({
  form,
  product,
  productId,
  fallbackCustomerName,
}: {
  form: StockForm;
  product: Product | undefined;
  productId: number | null;
  fallbackCustomerName?: string;
}) {
  const shownProduct = product || (productId ? form : null);
  const customerName = product?.customerName || (productId ? fallbackCustomerName : undefined);
  const rawSpec = product ? specification(product) : productId ? form.specification : '';
  const specText = [customerName, rawSpec].filter(Boolean).join(' · ');
  return (
    <FormSection title="规格" columns={4}>
      <FormField label="尺寸" span={2}>
        <output className="unit-fixed" aria-label="尺寸">
          {shownProduct ? sizeText(shownProduct) || '—' : '—'}
        </output>
      </FormField>
      <FormField label="材质 / 配纸">
        <output className="unit-fixed" aria-label="材质 / 配纸">
          {shownProduct ? shown(shownProduct.material) : '—'}
        </output>
      </FormField>
      <FormField label="楞型">
        <output className="unit-fixed" aria-label="楞型">
          {shownProduct ? shown(shownProduct.flute) : '—'}
        </output>
      </FormField>
      <FormField label={fieldLabel('specification')} span="full">
        <output className="unit-fixed" aria-label={fieldLabel('specification')}>
          {shown(specText)}
        </output>
      </FormField>
    </FormSection>
  );
}

/** 原材料：名称、单位（只有“张”）、尺寸、材质、楞型、规格说明都自己填 */
export function RawFields({ form, patch, saved }: { form: StockForm; patch: Patch; saved: StockItemView | null }) {
  return (
    <>
      <FormSection title="是什么">
        <FormField label="库存品名称" required>
          <input
            aria-label="库存品名称"
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </FormField>
        <FormField label="数量单位" hint="原材料只按“张”记">
          <output className="unit-fixed" aria-label="数量单位">
            {RAW_UNIT}
          </output>
        </FormField>
      </FormSection>
      <FormSection title="规格" columns={4}>
        <DimensionFields value={form} change={patch} saved={saved} />
        <FormField label="材质 / 配纸">
          <input
            aria-label="材质 / 配纸"
            maxLength={100}
            value={form.material}
            onChange={(e) => patch({ material: e.target.value })}
          />
        </FormField>
        <FormField label="楞型">
          <input aria-label="楞型" maxLength={50} value={form.flute} onChange={(e) => patch({ flute: e.target.value })} />
        </FormField>
        <FormField label={fieldLabel('specification')} span={2}>
          <input
            aria-label={fieldLabel('specification')}
            maxLength={2000}
            value={form.specification}
            onChange={(e) => patch({ specification: e.target.value })}
          />
        </FormField>
      </FormSection>
    </>
  );
}

/** 备注：成品、原材料都能改 */
export function StockNotes({ form, patch }: { form: StockForm; patch: Patch }) {
  return (
    <FormSection columns={1}>
      <FormField label="备注" span="full">
        <textarea
          aria-label="库存品备注"
          maxLength={1000}
          value={form.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </FormField>
    </FormSection>
  );
}
