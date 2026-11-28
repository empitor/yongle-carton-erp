import { EditorFooter, FormField, FormSection } from '../ui/index';
import { fieldLabel } from '../../shared/core/index';

// 客户、供应商、产品档案编辑窗共用的两块：底栏（取消、保存）和“怎么联系”加备注。

/** 客户、供应商、产品档案窗口的底部：取消和保存（保存提交 formId 那张表单）。note 是左边那句必填说明 */
export function ArchiveFooter({
  formId,
  saving,
  close,
  label,
  note = '只有名称必填，其余可以以后补。',
}: {
  formId: string;
  saving: boolean;
  close: () => void;
  label: string;
  note?: string;
}) {
  return (
    <EditorFooter note={note}>
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
