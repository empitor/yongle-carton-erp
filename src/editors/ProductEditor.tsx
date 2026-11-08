import { legacyCents } from '../../shared/precision';
import { useState, type FormEvent } from 'react';
import DimensionUnitSelect from '../DimensionUnitSelect';
import {
  convertDimension,
  normalizeDimensionUnit,
  dimensionKeys,
} from '../../shared/product-details';
import { specification, type Product, type ProductInput } from '../../shared/domain';
import Field from '../ui/Field';
import { Modal, FormFooter } from '../ui/Modal';
import { api } from '../app-api';

export default function ProductEditor({
  value,
  close,
  saved,
}: {
  value?: Product;
  close: () => void;
  saved: (record?: any) => void;
}) {
  const [form, setForm] = useState<ProductInput & { id?: number; version?: number }>(
      value || {
        name: '',
        length: null,
        width: null,
        height: null,
        dimensionUnit: null,
        material: '',
        flute: '',
        requirements: '',
        priceCents: 0,
      },
    ),
    [price, setPrice] = useState(value?.priceExact ?? String((value?.priceCents || 0) / 100)),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const change = (key: string, v: string | number | null) => setForm((f) => ({ ...f, [key]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const record = await api(
        '/products' + (value ? '/' + value.id : ''),
        {
          ...form,
          priceCents: price.trim() ? legacyCents(price) : 0,
          priceExact: price.trim() ? price : undefined,
        },
        value ? 'PUT' : 'POST',
      );
      saved(record);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={value ? '编辑产品' : '新增产品'} close={saving ? () => {} : close}>
      <form onSubmit={submit}>
        <div className="form-body">
          <p className="form-intro">只有名称必填，其余可以后补，不影响保存或导入订单。</p>
          <div className="product-form">
            <div className="span-4">
              <Field label="产品名称 / 型号 *">
                <input
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => change('name', e.target.value)}
                />
              </Field>
            </div>
            <div className="span-2">
              <Field label="客户料号">
                <input
                  maxLength={100}
                  value={form.customerProductCode || ''}
                  onChange={(e) => change('customerProductCode', e.target.value)}
                />
              </Field>
            </div>
            {(['length', 'width', 'height'] as const).map((k, i) => (
              <div className="span-1" key={k}>
                <Field label={['长', '宽', '高'][i]}>
                  <input
                    type="number"
                    min={Number.MIN_VALUE}
                    max={form.dimensionUnit === 'cm' ? 1000 : 10000}
                    step="any"
                    value={form[k] || ''}
                    onChange={(e) =>
                      change(k, e.target.value === '' ? null : Number(e.target.value))
                    }
                  />
                </Field>
              </div>
            ))}
            <div className="span-3">
              <Field label="尺寸单位">
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
                        ? Object.fromEntries(
                            dimensionKeys.map((k) => [k, convertDimension(f[k], from, to)]),
                          )
                        : {}),
                    }));
                  }}
                />
              </Field>
            </div>
            <div className="span-2">
              <Field label="材质 / 配纸">
                <input
                  maxLength={100}
                  value={form.material}
                  onChange={(e) => change('material', e.target.value)}
                />
              </Field>
            </div>
            <div className="span-2">
              <Field label="楞型">
                <input
                  maxLength={50}
                  value={form.flute}
                  onChange={(e) => change('flute', e.target.value)}
                  list="flutes"
                />
                <datalist id="flutes">
                  {['B 楞', 'C 楞', 'E 楞', 'BC 楞', 'BE 楞'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </datalist>
              </Field>
            </div>
            <div className="span-2">
              <Field label="参考单价（元）">
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.0001"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
            </div>
            <div className="span-6">
              <Field label="加工要求">
                <textarea
                  rows={2}
                  maxLength={500}
                  value={form.requirements}
                  onChange={(e) => change('requirements', e.target.value)}
                  placeholder="印刷、开槽、模切、钉箱或粘箱等"
                />
              </Field>
            </div>
          </div>
          <p className="product-spec-preview">规格预览：{specification(form)}</p>
        </div>
        <FormFooter error={error} saving={saving} close={close} />
      </form>
    </Modal>
  );
}
