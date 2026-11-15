/**
 * 是不是普通对象（不是数组、不是 null）：不定形的值（审计内容、命令的参数和结果、读回来的 JSON）按名字取字段前先认它。
 * 全项目只有这一份。
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
