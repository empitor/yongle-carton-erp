import type { SubmitValues } from './form-values';

/*
 * 通用表单窗口交给 submit 的值（SubmitValues：文字、数、真假）取成接口正文要的类型：
 * 下拉选出来的取值、必选的下拉、必填的文字。表单已经要求填了，没填上时说清楚缺什么，不发出去。
 */

/** 下拉的一个选项：取值、给人看的字 */
export type Option<T extends string> = readonly [T, string];
type Value = SubmitValues[string];

/** 下拉选出来的值：是选项之一就是它，没选是 undefined */
export const optionOf = <T extends string>(value: Value, options: readonly Option<T>[]) =>
  options.find(([key]) => key === value)?.[0];

/** 必选的下拉 */
export function chosen<T extends string>(value: Value, options: readonly Option<T>[], label: string): T {
  const found = optionOf(value, options);
  if (found === undefined) throw new Error('请选择' + label + '。');
  return found;
}

/** 必填的文字（日期、摘要、原因这类） */
export function filled(value: Value, label: string) {
  if (typeof value !== 'string' || !value) throw new Error('请填写' + label + '。');
  return value;
}
