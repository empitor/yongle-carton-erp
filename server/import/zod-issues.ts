import type { ZodError } from 'zod';
import { fieldLabels } from '../../shared/import/index.js';

const genericFieldPath = new Set([
  'header',
  'lines',
  'note',
  'notes',
  'value',
  'certainty',
]);

/** 栏目的中文名（按键查） */
const labelByKey = new Map<string, string>(Object.entries(fieldLabels));
/** 提示里最多列几个栏目 */
const LABELS_SHOWN = 8;

/** 把模型识别结果的 Zod 校验错误变成可读字段名，避免把 issue JSON 直接展示给用户。 */
export function formatZodIssues(error: ZodError, prefix = '字段不完整或不合法'): string {
  const labels = [
    ...new Set(
      error.issues
        .map((issue) =>
          [...issue.path]
            .reverse()
            .find((part): part is string => typeof part === 'string' && !genericFieldPath.has(part)),
        )
        // 不是表上栏目的（疑点的原因等）没有中文名，不把英文键名给人看
        .map((key) => (key === undefined ? undefined : labelByKey.get(key)))
        .filter((label) => label !== undefined),
    ),
  ];
  if (!labels.length) return prefix + '，请核对原文件或补充资料。';
  return (
    prefix +
    '：' +
    labels.slice(0, LABELS_SHOWN).join('、') +
    (labels.length > LABELS_SHOWN ? '等字段' : '') +
    '。请核对内容后重试或人工补录。'
  );
}
