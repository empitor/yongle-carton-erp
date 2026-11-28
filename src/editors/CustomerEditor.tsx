import { useId, useState, type SubmitEvent } from 'react';
import { CUSTOMER_NAME_MAX, type Customer, type CustomerInput } from '../../shared/core/index';
import { ManagementDialog, notify, useAction } from '../ui/index';
import { FormField, FormMessage, FormSection } from '../ui/index';
import { saveCustomer } from './editor-api';
import CustomerSites from './CustomerSites';
import { ArchiveFooter, ContactSection } from './party-fields';

/** 改的时候带着打开窗口时读到的版本号（保存靠它做版本校验） */
type CustomerForm = CustomerInput & { version?: number };
const blank: CustomerForm = { name: '', contact: '', phone: '', address: '', notes: '' };
/** 客户的必填：名称；加了厂区，厂区名称也要填，两个以上要选一个默认 */
const CUSTOMER_REQUIRED = '客户名称必填；加了厂区要填厂区名称、选一个默认，其余可以以后补。';

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
      footer={<ArchiveFooter formId={formId} saving={saving} close={close} label="保存客户" note={CUSTOMER_REQUIRED} />}
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
