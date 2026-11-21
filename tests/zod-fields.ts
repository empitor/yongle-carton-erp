// 读 zod 结构里有哪些字段（清单对得上的几条检查共用）：去掉包装用数据管理查栏目的同一份（server/admin/input-fields.ts），
// 再去掉数组那一层，取对象的字段。
import { z } from 'zod';
import { unwrapped } from '../server/admin/input-fields.js';

type Schema = z.core.$ZodType;

/** 再去掉数组那一层，取里面真正的结构 */
function innerSchema(schema: Schema): Schema {
  const inner = unwrapped(schema);
  return inner instanceof z.ZodArray ? innerSchema(inner.element) : inner;
}

/** 对象结构的字段表；去掉包装以后不是对象的返回 null */
export function objectShape(schema: Schema): Record<string, Schema> | null {
  const inner = innerSchema(schema);
  return inner instanceof z.ZodObject ? inner.shape : null;
}

/** 字段路径上的一步：字段名，和它是不是一组（数组） */
export type FieldStep = { key: string; list: boolean };

/** 结构里每个字段的路径（一步一步写）：送货单明细备注是 [lines（一组）, notes] */
export function fieldSteps(schema: Schema, prefix: FieldStep[] = []): FieldStep[][] {
  const shape = objectShape(schema);
  if (!shape) return [];
  return Object.entries(shape).flatMap(([key, value]) => {
    const path = [...prefix, { key, list: unwrapped(value) instanceof z.ZodArray }];
    return [path, ...fieldSteps(value, path)];
  });
}

/** 路径写成一个词，数组那一层不写：lines.item.name */
export const pathText = (path: readonly FieldStep[]) => path.map((s) => s.key).join('.');
