import { useId, useState, type SubmitEvent } from 'react';
import { CUSTOMER_NAME_MAX, type Customer, type CustomerInput, fieldLabel } from '../../shared/core/index';
import { ManagementDialog, notify, useAction } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { saveCustomer } from './editor-api';
import CustomerSites from './CustomerSites';

/** 改的时候带着打开窗口时读到的版本号（保存靠它做版本校验） */
type CustomerForm = CustomerInput & { version?: number };
const blank: CustomerForm = { name: '', contact: '', phone: '', address: '', notes: '' };

/** 客户、供应商、产品档案窗口的底部：取消和保存（保存提交 formId 那张表单）。 */
export function ArchiveFooter({
  formId,
  saving,
  close,
  label,
}: {
  formId: string;
  saving: boolean;
  close: () => void;
  label: string;
}) {
  return (
    <EditorFooter note="只有名称必填，其余可以以后补。">
      <button type="button" className="secondary" disabled={saving} onClick={close}>
        取消
      </button>
      <button type="submit" form={formId} className="primary" disabled={saving}>
        {saving ? '正在保存…' : label}
      </button>
    </EditorFooter>
  );
}

/** 客户、供应商编辑窗共用的“怎么联系”（联系人、联系方式、地址）和备注。 */
export function ContactSection({
  noun,
  form,
  change,
}: {
  noun: string;
  form: { contact: string; phone: string; address: string; notes: string };
  change: (key: 'contact' | 'phone' | 'address' | 'notes', v: string) => void;
}) {
  return (
    <>
      <FormSection title="怎么联系">
        <FormField label={fieldLabel('contact')}>
          <input
            aria-label="联系人"
            maxLength={60}
            value={form.contact}
            onChange={(e) => change('contact', e.target.value)}
          />
        </FormField>
        <FormField label="联系方式">
          <input
            aria-label="联系方式"
            maxLength={50}
            value={form.phone}
            onChange={(e) => change('phone', e.target.value)}
          />
        </FormField>
        <FormField label={fieldLabel('address')} span="full">
          <input
            aria-label={noun + '地址'}
            maxLength={300}
            value={form.address}
            onChange={(e) => change('address', e.target.value)}
          />
        </FormField>
      </FormSection>
      <FormSection columns={1}>
        <FormField label="备注" span="full">
          <textarea
            aria-label={noun + '备注'}
            maxLength={1000}
            rows={3}
            value={form.notes}
            onChange={(e) => change('notes', e.target.value)}
          />
        </FormField>
      </FormSection>
    </>
  );
}

/** 客户档案编辑窗：名称、怎么联系、备注。只有名称必填。 */
export default function CustomerEditor({
  value,
  close,
  saved,
}: {
  value?: Customer;
  close: () => void;
  saved: (record: Customer) => void;
}) {
  const formId = useId();
  // 改的时候表单从打开时的记录起，保存带的是这时读到的版本号；页面重读这条也不跟着换
  const [initialSites] = useState(() => value?.sites ?? []);
  const [form, setForm] = useState<CustomerForm>(value ? { ...value, sites: undefined } : blank),
    { busy: saving, error, run } = useAction();
  const change = (key: 'name' | 'contact' | 'phone' | 'address' | 'notes', v: string) => setForm((f) => ({ ...f, [key]: v }));
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void run(async () => {
      const record = await saveCustomer(value?.id, form);
      saved(record);
      notify('客户 ' + (record.name || form.name) + (value ? ' 已保存。' : ' 已建立。'));
    });
  };
  return (
    <ManagementDialog
      title={(value ? '编辑' : '新建') + '客户'}
      subtitle={value?.name}
      size="md"
      busy={saving}
      close={close}
      footer={<ArchiveFooter formId={formId} saving={saving} close={close} label="保存客户" />}
    >
      <form
        id={formId}
        className="sales-form"
        onSubmit={submit}
        data-agent-module={value ? 'customers' : undefined}
        data-agent-record={value?.id}
        data-agent-label={value?.name}
      >
        <FormMessage>{error}</FormMessage>
        <FormSection>
          <FormField label="客户名称" required span="full">
            <input
              aria-label="客户名称"
              required
              maxLength={CUSTOMER_NAME_MAX}
              value={form.name}
              onChange={(e) => change('name', e.target.value)}
            />
          </FormField>
        </FormSection>
        <ContactSection noun="客户" form={form} change={change} />
        <CustomerSites
          sites={form.sites ?? initialSites}
          change={(sites) => setForm((f) => ({ ...f, sites }))}
        />
      </form>
    </ManagementDialog>
  );
}
