import { useState, type FormEvent } from 'react';
import { type Customer } from '../../shared/domain';
import Field from '../ui/Field';
import { Modal, FormFooter } from '../ui/Modal';
import { api } from '../app-api';

export default function CustomerEditor({
  value,
  close,
  saved,
  entity = 'customers',
}: {
  value?: Customer;
  close: () => void;
  saved: (record?: any) => void;
  entity?: 'customers' | 'suppliers';
}) {
  const [form, setForm] = useState(
      value || { name: '', contact: '', phone: '', address: '', notes: '' },
    ),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const change = (key: string, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const record = await api(
        '/' + entity + (value ? '/' + value.id : ''),
        form,
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
    <Modal
      title={(value ? '编辑' : '新增') + (entity === 'suppliers' ? '供应商' : '客户')}
      close={saving ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <div className="form-grid">
            <Field label={(entity === 'suppliers' ? '供应商' : '客户') + '名称 *'} wide>
              <input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => change('name', e.target.value)}
              />
            </Field>
            <Field label="联系人">
              <input
                maxLength={60}
                value={form.contact}
                onChange={(e) => change('contact', e.target.value)}
              />
            </Field>
            <Field label="联系方式">
              <input
                maxLength={50}
                value={form.phone}
                onChange={(e) => change('phone', e.target.value)}
              />
            </Field>
            <Field label="联系地址" wide>
              <input
                maxLength={300}
                value={form.address}
                onChange={(e) => change('address', e.target.value)}
              />
            </Field>
            <Field label="备注" wide>
              <textarea
                maxLength={1000}
                rows={3}
                value={form.notes}
                onChange={(e) => change('notes', e.target.value)}
              />
            </Field>
          </div>
        </div>
        <FormFooter error={error} saving={saving} close={close} />
      </form>
    </Modal>
  );
}
