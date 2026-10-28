import type { ZodError } from 'zod';
import { fieldLabels } from '../../shared/order-draft.js';

export class ImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'validation',
  ) {
    super(message);
  }
}

const genericFieldPath = new Set([
  'header',
  'lines',
  'note',
  'notes',
  'value',
  'sources',
  'quote',
  'certainty',
]);

/** 把模型草稿的 Zod 校验错误变成可读字段名，避免把 issue JSON 直接展示给用户。 */
export function formatZodIssues(error: ZodError, prefix = '字段不完整或不合法'): string {
  const labels = [
    ...new Set(
      error.issues
        .map((issue) =>
          [...issue.path]
            .reverse()
            .find((part) => typeof part === 'string' && !genericFieldPath.has(part)),
        )
        .filter((key): key is string => typeof key === 'string')
        .map((key) => fieldLabels[key as keyof typeof fieldLabels] ?? key),
    ),
  ];
  if (!labels.length) return prefix + '，请核对原文件或补充资料。';
  return (
    prefix +
    '：' +
    labels.slice(0, 8).join('、') +
    (labels.length > 8 ? '等字段' : '') +
    '。请核对原文件后重新识别或人工补录。'
  );
}
