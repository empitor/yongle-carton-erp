import { centsInput, toCents } from '../ui/index';
import type { ReactNode } from 'react';
import type { Span } from './fields';

/* 通用表单窗口的数据：初值转成输入框里的文字、提交前转回金额（分）和数字、按节分组。 */

/**
 * 编辑窗里的值：字段是输入框里的文字、勾选项是真假（initialValues 转好的），
 * 初值里不是字段的项原样带着（show、partyKind 可能要读）。
 */
export type FormValues = Readonly<Record<string, unknown>>;
/**
 * 交给 submit 的值：金额是分，整数和单位、资金账户、往来单的编号是数，勾选是真假，其余是去掉首尾空白的文字。
 * 空着的、被藏起来的、自带控件的字段不在里面。
 */
export type SubmitValues = Readonly<Partial<Record<string, string | number | boolean>>>;

type FieldType =
  | 'text'
  | 'money'
  | 'date'
  | 'month'
  | 'int'
  | 'select'
  | 'textarea'
  | 'party'
  | 'account'
  | 'cash-account'
  | 'cash-flow'
  | 'obligation'
  | 'check';
type FieldBase = {
  name: string;
  label: string;
  options?: readonly (readonly [string, string])[];
  required?: boolean;
  wide?: boolean;
  hint?: string;
  partyKind?: 'customer' | 'supplier' | ((values: FormValues) => 'customer' | 'supplier');
  show?: (values: FormValues) => boolean;
  /** 放进哪一节，节标题用大白话，例如“哪一笔”“什么时候”。不写就放在最前面不带标题的一节。 */
  section?: string;
  /** 在这一节里占几列；不写时备注、长文本和勾选项占满一行，其余占一列。 */
  span?: Span;
  placeholder?: string;
  /** 自带的控件，例如选文件；值不经过表单，提交时自己读 */
  render?: () => ReactNode;
};
export type Field =
  | (FieldBase & { type?: Exclude<FieldType, 'obligation'> })
  /** 从这个单位未结清的往来单里选 */
  | (FieldBase & { type: 'obligation'; obligation: { kind: 'receivable' | 'payable'; partyId: unknown } });
export type FormDialogSection = { title: string; columns?: 1 | 2 | 3 | 4; hint?: ReactNode };

/** 一个字段的初值：勾选是真假，金额是“元”的文字，其余是文字，没有就空着 */
function initialValue(f: Field, v: unknown) {
  if (f.type === 'check') return !!v;
  if (f.type === 'money') return centsInput(v);
  return (v ?? '') === '' ? '' : String(v);
}

/** 输入框里的初值：每个字段按 initialValue 转好，初值里别的项原样留着 */
export function initialValues(fields: readonly Field[], initial: FormValues): FormValues {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) out[f.name] = initialValue(f, initial[f.name]);
  return { ...initial, ...out };
}

/** 输入框里的文字：字段的值在 initialValues 里已经转成文字 */
export const fieldText = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''));

/** 金额为分，整数、单位、资金账户、往来单为编号（数），其余是去掉首尾空白的文字 */
function submitValue(f: Field, v: unknown): string | number {
  if (f.type === 'money') return toCents(fieldText(v));
  if (f.type === 'int' || f.type === 'cash-account' || f.type === 'party' || f.type === 'obligation')
    return Number(v);
  return fieldText(v).trim();
}

/** 提交前转换：金额为分，整数和单位 ID 为数字，空值去掉；隐藏的字段和自带控件的字段不提交 */
export function convertValues(fields: readonly Field[], values: FormValues): SubmitValues {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    if (f.render || (f.show && !f.show(values))) continue;
    const v = values[f.name];
    if (f.type === 'check') out[f.name] = !!v;
    else if (v !== '' && v !== null && v !== undefined) out[f.name] = submitValue(f, v);
  }
  return out;
}

/** 按节分组：先按 sections 给的顺序，再补上字段里出现、但 sections 没列出的节 */
export function groupFields(
  fields: readonly Field[],
  sections: FormDialogSection[] | undefined,
  values: FormValues,
) {
  const visible = fields.filter((f) => !f.show || f.show(values));
  const order: (string | undefined)[] = [undefined, ...(sections || []).map((s) => s.title)];
  for (const f of visible) if (!order.includes(f.section)) order.push(f.section);
  return order
    .map((title) => ({
      title,
      meta: sections?.find((s) => s.title === title),
      fields: visible.filter((f) => f.section === title),
    }))
    .filter((g) => g.fields.length);
}
