import { useId, useState, type SubmitEvent } from 'react';
import { SUPPLIER_NAME_MAX, type Supplier } from '../../shared/business/index';
import { FormField, FormMessage, FormSection, ManagementDialog, notify, useAction } from '../ui/index';
import { ArchiveFooter, ContactSection } from './party-fields';
import { saveSupplier, type SavedSupplier } from './editor-api';

/** 供应商表单：改的时候带着打开窗口时读到的版本号（保存靠它做版本校验） */
type SupplierForm = Pick<Supplier, 'name' | 'contact' | 'phone' | 'address' | 'notes'> & { version?: number };
const blank: SupplierForm = { name: '', contact: '', phone: '', address: '', notes: '' };

/**
 * 供应商档案编辑窗：名称、怎么联系、备注。只有名称必填。
 * quick：在采购单里“新建供应商”，保存后直接选进当前采购单。
 */
export default function SupplierEditor({
  value,
  close,
  saved,
  quick = false,
}: {
  value?: Supplier;
  close: () => void;
  saved: (record: SavedSupplier) => void;
  quick?: boolean;
}) {
  const formId = useId();
  const [form, setForm] = useState<SupplierForm>(value ?? blank),
    { busy: saving, error, run } = useAction();
  const change = (key: keyof SupplierForm, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void run(async () => {
      const record = await saveSupplier(value?.id, form);
      saved(record);
      notify('供应商 ' + (record.name || form.name) + (value ? ' 已保存。' : ' 已建立。'));
    });
  };
  return (
    <ManagementDialog
      title={(value ? '编辑' : '新建') + '供应商'}
      subtitle={quick ? '保存后直接选进当前单据，已填的内容保留' : value?.name}
      size="md"
      busy={saving}
      close={close}
      footer={<ArchiveFooter formId={formId} saving={saving} close={close} label="保存供应商" />}
    >
      <form
        id={formId}
        className="sales-form"
        onSubmit={submit}
        data-agent-module={value ? 'suppliers' : undefined}
        data-agent-record={value?.id}
        data-agent-label={value?.name}
      >
        <FormMessage>{error}</FormMessage>
        <FormSection>
          <FormField label="供应商名称" required span="full">
            <input
              aria-label="供应商名称"
              required
              maxLength={SUPPLIER_NAME_MAX}
              value={form.name}
              onChange={(e) => change('name', e.target.value)}
            />
          </FormField>
        </FormSection>
        <ContactSection noun="供应商" form={form} change={change} />
      </form>
    </ManagementDialog>
  );
}
