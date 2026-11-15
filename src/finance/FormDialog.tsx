import { useState, type ReactNode } from 'react';
import { FormMessage, FormSection, FormField } from '../ui/index';
import {
  convertValues,
  fieldText,
  groupFields,
  initialValues,
  type Field,
  type FormDialogSection,
  type FormValues,
  type SubmitValues,
} from './form-values';
import { EditorShell } from './editor';
import {
  AccountInput,
  CashAccountSelect,
  FinCheck,
  ObligationSelect,
  PartyField,
  UnitInput,
  cashFlowItems,
} from './fields';

/* 通用表单窗口：按字段表生成编辑窗，按业务问题分节，底部固定一排按钮。 */

/** 金额字段的标签不再带“/ 元”，单位放在输入框后面。 */
const moneyLabel = (label: string) => label.replace(/\s*\/\s*元$/, '');

/** 日期、月份、整数之外的普通字段都是文本框 */
const inputTypes: Partial<Record<NonNullable<Field['type']>, string>> = {
  date: 'date',
  month: 'month',
  int: 'number',
};

/** 一个控件要的：字段、输入框里的文字、改了以后回写 */
type ControlProps = { f: Field; value: string; onChange: (v: string) => void };

/** 下拉：普通下拉列字段给的选项（选填的多一个“未选择”），现金流量项目列报表模板里的项目 */
function OptionSelect({ f, value, onChange }: ControlProps) {
  if (f.type === 'cash-flow')
    return (
      <select required={f.required} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择</option>
        {cashFlowItems.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    );
  return (
    <select required={f.required} value={value} onChange={(e) => onChange(e.target.value)}>
      {!f.required && <option value="">未选择</option>}
      {f.options?.map(([k, text]) => (
        <option key={k} value={k}>
          {text}
        </option>
      ))}
    </select>
  );
}

/** 填文字的控件：长文本、带“元”的金额，其余是输入框（日期、月份、整数按类型） */
function TextControl({ f, value, onChange }: ControlProps) {
  if (f.type === 'textarea')
    return (
      <textarea
        required={f.required}
        value={value}
        rows={3}
        placeholder={f.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (f.type === 'money')
    return (
      <UnitInput
        unit="元"
        inputMode="decimal"
        required={f.required}
        placeholder={f.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <input
      type={inputTypes[f.type ?? 'text'] ?? 'text'}
      required={f.required}
      placeholder={f.placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 选单位的字段是客户还是供应商：可以按表单里别的值定，没写是客户 */
const partyKindOf = (f: Field, values: FormValues) =>
  typeof f.partyKind === 'function' ? f.partyKind(values) : f.partyKind || 'customer';

/** 一个字段的输入控件：按字段类型给下拉、文本框、单位、科目、资金账户、往来单、金额 */
function FieldControl({
  f,
  values,
  set,
}: {
  f: Field;
  values: FormValues;
  set: (name: string, v: string) => void;
}) {
  if (f.render) return f.render();
  const value = fieldText(values[f.name]);
  const onChange = (v: string) => set(f.name, v);
  const common = { label: f.label, required: f.required, value, onChange };
  switch (f.type) {
    case 'party':
      return <PartyField {...common} kind={partyKindOf(f, values)} />;
    case 'account':
      return <AccountInput {...common} />;
    case 'cash-account':
      return <CashAccountSelect {...common} />;
    case 'obligation':
      return <ObligationSelect {...common} kind={f.obligation.kind} partyId={f.obligation.partyId} />;
    case 'select':
    case 'cash-flow':
      return <OptionSelect f={f} value={value} onChange={onChange} />;
    // 勾选项在外面画成 FinCheck（FormDialog），走不到这里
    case 'check':
    case 'textarea':
    case 'money':
    case 'text':
    case 'date':
    case 'month':
    case 'int':
    case undefined:
      return <TextControl f={f} value={value} onChange={onChange} />;
  }
}

export function FormDialog({
  title,
  intro,
  fields,
  initial = {},
  submitLabel = '保存',
  submit,
  close,
  danger,
  children,
  size,
  subtitle,
  note,
  columns = 2,
  sections,
  leading,
  notice,
}: {
  title: string;
  /** 必须让人知道的一句规则，显示在窗口顶部的提示条里 */
  intro?: ReactNode;
  fields: readonly Field[];
  initial?: FormValues;
  submitLabel?: string;
  /** 收到已转换的值：金额为分，整数和单位 ID 为数字，空值已去掉。 */
  submit: (values: SubmitValues) => Promise<unknown>;
  close: () => void;
  danger?: boolean;
  /** 放在各节字段后面的内容，例如上传文件、明细表 */
  children?: ReactNode;
  /** 窗口宽度：sm 480、md 640、lg 880、xl 1120；不写按字段多少自动选 */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 标题下一行的上下文，例如“虚构客户 · 1,000.00 元” */
  subtitle?: ReactNode;
  /** 底部按钮左边的一句话，例如“保存后待确认，确认才入账。” */
  note?: ReactNode;
  /** 每节默认几列 */
  columns?: 1 | 2 | 3 | 4;
  /** 节的顺序、列数和一句说明；不写就按字段出现的顺序分节 */
  sections?: FormDialogSection[];
  /** 放在各节字段前面的内容，例如要先选的文件、预览表 */
  leading?: ReactNode;
  /** 成功后关窗，在页面底部提示这句话 */
  notice?: string;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(fields, initial));
  const set = (name: string, v: string | boolean) => setValues((s) => ({ ...s, [name]: v }));
  const groups = groupFields(fields, sections, values);
  const width = size ?? (children || leading ? 'lg' : fields.length <= 3 ? 'sm' : 'md');
  return (
    <EditorShell
      title={title}
      subtitle={subtitle}
      size={width}
      close={close}
      danger={danger}
      note={note}
      submitLabel={submitLabel}
      submit={async () => {
        await submit(convertValues(fields, values));
        return notice;
      }}
    >
      {intro && <FormMessage tone={danger ? 'warning' : 'info'}>{intro}</FormMessage>}
      {leading}
      {groups.map((g, i) => (
        <FormSection
          key={g.title ?? '#' + i}
          title={g.title}
          hint={g.meta?.hint}
          columns={g.meta?.columns ?? (width === 'sm' && g.fields.length < 2 ? 1 : columns)}
        >
          {g.fields.map((f) =>
            f.type === 'check' ? (
              <FinCheck
                key={f.name}
                label={f.label}
                hint={f.hint}
                span={f.span ?? 'full'}
                checked={!!values[f.name]}
                onChange={(v) => set(f.name, v)}
              />
            ) : (
              <FormField
                key={f.name}
                label={f.type === 'money' ? moneyLabel(f.label) : f.label}
                required={f.required}
                hint={f.hint}
                span={f.span ?? (f.wide || f.type === 'textarea' ? 'full' : 1)}
              >
                <FieldControl f={f} values={values} set={set} />
              </FormField>
            ),
          )}
        </FormSection>
      ))}
      {children}
    </EditorShell>
  );
}
