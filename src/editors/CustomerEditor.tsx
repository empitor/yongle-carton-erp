import { useId, useState, type SubmitEvent } from 'react';
import { type Customer, fieldLabel } from '../../shared/core/index';
import { ManagementDialog, notify, useAction } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { saveCustomer, saveSupplier, type SavedSupplier } from './editor-api';

/** 客户和供应商同样的结构 */
type Party = Pick<Customer, 'id' | 'version' | 'name' | 'contact' | 'phone' | 'address' | 'notes'>;
/** 改的时候带着打开窗口时读到的版本号（保存靠它做版本校验） */
type PartyForm = Pick<Party, 'name' | 'contact' | 'phone' | 'address' | 'notes'> & { version?: number };
const blank: PartyForm = { name: '', contact: '', phone: '', address: '', notes: '' };

/** 存哪种档案，存好的那条交给 saved：客户（不写 entity 就是客户）或供应商 */
type Target =
  | { entity?: 'customers'; saved: (record: Customer) => void }
  | { entity: 'suppliers'; saved: (record: SavedSupplier) => void };

/** 按档案种类保存，存好的那条交给 saved，交回名称（页面提示用） */
async function saveParty(target: Target, id: number | undefined, form: PartyForm) {
  if (target.entity === 'suppliers') {
    const record = await saveSupplier(id, form);
    target.saved(record);
    return record.name;
  }
  const record = await saveCustomer(id, form);
  target.saved(record);
  return record.name;
}

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

/**
 * 客户或供应商档案，两种档案同一个窗口、同样的结构：名称、怎么联系、备注。只有名称必填。
 * quick：在订单、采购单里“新建客户 / 新建供应商”，保存后直接选进当前单据。
 */
export default function CustomerEditor(
  props: Target & {
    value?: Party;
    close: () => void;
    quick?: boolean;
  },
) {
  const { value, close, quick = false } = props,
    entity = props.entity ?? 'customers';
  const formId = useId(),
    noun = entity === 'suppliers' ? '供应商' : '客户';
  // 改的时候表单从打开时的记录起，保存带的是这时读到的版本号；页面重读这条也不跟着换
  const [form, setForm] = useState<PartyForm>(value ?? blank),
    { busy: saving, error, run } = useAction();
  const change = (key: keyof PartyForm, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void run(async () => {
      const name = await saveParty(props, value?.id, form);
      notify(noun + ' ' + (name || form.name) + (value ? ' 已保存。' : ' 已建立。'));
    });
  };
  return (
    <ManagementDialog
      title={(value ? '编辑' : '新建') + noun}
      subtitle={quick ? '保存后直接选进当前单据，已填的内容保留' : value?.name}
      size="md"
      busy={saving}
      close={close}
      footer={<ArchiveFooter formId={formId} saving={saving} close={close} label={'保存' + noun} />}
    >
      <form
        id={formId}
        className="sales-form"
        onSubmit={submit}
        data-agent-module={value ? entity : undefined}
        data-agent-record={value?.id}
        data-agent-label={value?.name}
      >
        <FormMessage>{error}</FormMessage>
        <FormSection>
          <FormField label={noun + '名称'} required span="full">
            <input
              aria-label={noun + '名称'}
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => change('name', e.target.value)}
            />
          </FormField>
        </FormSection>
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
      </form>
    </ManagementDialog>
  );
}
