// 不定形的值按名字取字段：命令的返回值（链接、下载、识别任务状态、搜索到的网址）、方案的参数和改前改后（plan-rules.ts、
// 卡片 card-*.ts）、模型交来的参数。助手里只有这一套，别处都引它。
// 不是对象、没有这个字段都当没有（undefined）。都不复制：交出来的就是原来那个对象、数组。

import { isRecord } from '../../../shared/core/index.js';

/** 是不是数组（元素类型不定） */
export const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** 取对象上的一个字段；不是对象或没有这个字段是 undefined */
export const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** 是数组就交出来；不是数组是 undefined */
export const asList = (value: unknown) => (isList(value) ? value : undefined);
/** 取对象上一个是数组的字段；不是数组是 undefined */
export const listField = (value: unknown, key: string) => asList(field(value, key));

/** 几个候选里第一个有值的（和 a || b || 兜底 一样），写成文字；都没有就是 fallback */
export function firstText(values: unknown[], fallback: string) {
  const found = values.find(Boolean);
  return found ? String(found) : fallback;
}
