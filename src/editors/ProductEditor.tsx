import { errorMessage, legacyCents, plainPrice, priceFromCents, fieldLabel, fieldTitle } from '../../shared/core/index';
import { useId, useState, type SubmitEvent } from 'react';
import DimensionUnitSelect from './DimensionUnitSelect';
import { convertDimension, normalizeDimensionUnit, dimensionKeys } from '../../shared/core/index';
import { specification, type Product, type ProductInput } from '../../shared/core/index';
import { ManagementDialog, notify } from '../ui/index';
import { FormField, FormMessage, FormSection } from '../ui/index';
import { ArchiveFooter } from './CustomerEditor';
import { Combobox } from '../ui/index';
import { saveProduct } from './editor-api';
import { useProductFamily } from '../recordkit/useProductFamily';
import { descendantIds } from '../../shared/business/index';

const dimensionLabels = { length: '长', width: '宽', height: '高' } as const;

/** 窗口里填的产品：录入的内容，改的时候带着打开时读到的编号和版本号 */
type ProductForm = ProductInput & { id?: number; version?: number };
type Change = <K extends keyof ProductForm>(key: K, v: ProductForm[K]) => void;
type SectionProps = { value?: Product; form: ProductForm; change: Change };

const blankProduct: ProductForm = {
  name: '',
  length: null,
  width: null,
  height: null,
  dimensionUnit: null,
  material: '',
  flute: '',
  requirements: '',
  priceCents: 0,
};

/** 没定过价的留空，不显示成 0；定了价的去掉多余尾零（接口里固定四位小数） */
const initialPrice = (value?: Product) =>
  value?.priceExact != null
    ? plainPrice(value.priceExact)
    : value?.priceCents
      ? plainPrice(priceFromCents(value.priceCents))
      : '';

/** 服务端说已有同名、尺寸或材质不同的产品（要人确认“是另一个产品”） */
const isSameName = (e: unknown): e is Error => e instanceof Error && 'code' in e && e.code === 'same-name-product';

/** 附属于哪个产品：不能选自己，也不能选挂在自己下面的（免得绕成一圈） */
function ParentField({ value, form, change }: SectionProps) {
  const family = useProductFamily();
  const blocked = value ? descendantIds(family.products, value.id) : new Set<number>();
  const parentOptions = family.products
    .filter((p) => p.id !== value?.id && !blocked.has(p.id))
    .map((p) => ({ value: String(p.id), label: p.name }));
  return (
    <FormField
      label={fieldLabel('parentProductId')}
      span={3}
      hint="比如小箱套在大箱里，就选大箱。只是列表里挂在它下面看着清楚，订单、价格、库存还是各算各的。"
    >
      <div className="form-inline">
        <Combobox
          ariaLabel="附属于哪个产品"
          placeholder="不附属于别的产品"
          value={form.parentProductId ? String(form.parentProductId) : ''}
          options={parentOptions}
          onChange={(id) => change('parentProductId', id ? Number(id) : null)}
        />
        {form.parentProductId ? (
          <button type="button" className="secondary" onClick={() => change('parentProductId', null)}>
            不附属
          </button>
        ) : null}
      </div>
    </FormField>
  );
}

/** 尺寸：长宽高和单位在窄屏上也排一行，不拆成四行；换单位时已填的数字跟着换算 */
function DimensionSection({
  value,
  form,
  change,
  setForm,
}: SectionProps & { setForm: (update: (f: ProductForm) => ProductForm) => void }) {
  const unit = normalizeDimensionUnit(form.dimensionUnit);
  return (
    <FormSection title="尺寸" hint="单位不确定就先不选。" columns={1}>
      {/* 长宽高和单位在窄屏上也排一行，不拆成四行 */}
      <div className="sales-dims">
        {dimensionKeys.map((k) => (
          <FormField key={k} label={dimensionLabels[k] + (unit ? '（' + unit + '）' : '')}>
            <input
              type="number"
              min={Number.MIN_VALUE}
              max={form.dimensionUnit === 'cm' ? 1000 : 10000}
              step="any"
              value={form[k] || ''}
              onChange={(e) => change(k, e.target.value === '' ? null : Number(e.target.value))}
            />
          </FormField>
        ))}
        <FormField label={fieldLabel('dimensionUnit')}>
          <DimensionUnitSelect
            unit={form.dimensionUnit ?? form.dimensionUnitRaw}
            // 只有已保存的旧尺寸才需要确认单位；刚填的数字本来就按所选单位理解。
            hasValues={!!value && dimensionKeys.some((k) => value[k] !== null)}
            onChange={(to) => {
              const from = normalizeDimensionUnit(form.dimensionUnit);
              setForm((f) => ({
                ...f,
                dimensionUnit: to,
                dimensionUnitRaw: to ? '' : f.dimensionUnitRaw,
                ...(from && to
                  ? Object.fromEntries(dimensionKeys.map((k) => [k, convertDimension(f[k], from, to)]))
                  : {}),
              }));
            }}
          />
        </FormField>
      </div>
    </FormSection>
  );
}

/** 材料、加工和价格：材质、楞型、参考单价、加工要求，和按这些拼出来的规格 */
function MaterialSection({ form, change, price, setPrice }: SectionProps & { price: string; setPrice: (v: string) => void }) {
  return (
    <FormSection title="材料、加工和价格" columns={3}>
      <FormField label={fieldLabel('material')}>
        <input maxLength={100} value={form.material} onChange={(e) => change('material', e.target.value)} />
      </FormField>
      <FormField label={fieldLabel('flute')}>
        <input maxLength={50} value={form.flute} onChange={(e) => change('flute', e.target.value)} list="flutes" />
        <datalist id="flutes">
          {['B 楞', 'C 楞', 'E 楞', 'BC 楞', 'BE 楞'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </datalist>
      </FormField>
      <FormField label={fieldTitle('priceExact')} hint="不知道可以先空着">
        <input
          inputMode="decimal"
          type="number"
          min="0"
          max="1000000"
          step="0.0001"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </FormField>
      <FormField label={fieldLabel('requirements')} span="full">
        <textarea
          rows={2}
          maxLength={500}
          value={form.requirements}
          onChange={(e) => change('requirements', e.target.value)}
          placeholder="印刷、开槽、模切、钉箱或粘箱等"
        />
      </FormField>
      <FormField label={fieldLabel('specification')} span="full" hint="订单里选这个产品时，规格按这一行自动带出">
        <output className="sales-output">{specification(form) || '—'}</output>
      </FormField>
    </FormSection>
  );
}

/** 产品档案：名称必填；尺寸、材质、楞型、单价都可以以后补，不影响保存或导入订单。 */
export default function ProductEditor({
  value,
  close,
  saved,
}: {
  value?: Product;
  close: () => void;
  saved: (record: Product) => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<ProductForm>(value || blankProduct),
    [price, setPrice] = useState(() => initialPrice(value)),
    [error, setError] = useState(''),
    // 已有同名、尺寸或材质不同的产品：服务端列出来，在这个窗口里确认“是另一个产品”再保存（不另弹窗）
    [sameName, setSameName] = useState(''),
    [saving, setSaving] = useState(false);
  const change: Change = (key, v) => {
    setForm((f) => ({ ...f, [key]: v }));
    setSameName('');
  };
  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const record = await saveProduct(value?.id, {
        ...form,
        priceCents: price.trim() ? legacyCents(price) : 0,
        priceExact: price.trim() ? price : undefined,
        ...(sameName ? { confirmDistinct: true } : {}),
      });
      saved(record);
      notify('产品 ' + (record.name || form.name) + (value ? ' 已保存。' : ' 已建立。'));
    } catch (e) {
      if (isSameName(e)) setSameName(e.message);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const section = { value, form, change };
  return (
    <ManagementDialog
      title={value ? '编辑产品' : '新建产品'}
      size="md"
      busy={saving}
      close={close}
      footer={
        <ArchiveFooter
          formId={formId}
          saving={saving}
          close={close}
          label={sameName ? '是另一个产品，保存' : '保存产品'}
        />
      }
    >
      <form id={formId} onSubmit={submit} className="sales-form sales-product-editor">
        <FormMessage>{error}</FormMessage>
        {sameName && <FormMessage tone="warning">{sameName}</FormMessage>}
        <FormSection columns={3}>
          <FormField label={fieldLabel('productName')} required span={2}>
            <input required maxLength={100} value={form.name} onChange={(e) => change('name', e.target.value)} />
          </FormField>
          <FormField label={fieldLabel('customerProductCode')}>
            <input
              maxLength={100}
              value={form.customerProductCode || ''}
              onChange={(e) => change('customerProductCode', e.target.value)}
            />
          </FormField>
          <ParentField {...section} />
        </FormSection>
        <DimensionSection {...section} setForm={setForm} />
        <MaterialSection {...section} price={price} setPrice={setPrice} />
      </form>
    </ManagementDialog>
  );
}
