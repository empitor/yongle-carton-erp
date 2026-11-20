import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { isRecord } from '../../shared/core/index.js';
// 数据管理保存前查补丁里录入结构不收的栏目（不管在第几层）：读出来的记录本来就带、照原样带回来的放过，
// 改了值的、记录里根本没有的列出来（managed-save.ts 拦下、field-rejection.ts 说清是哪一格）。

type Schema = z.core.$ZodType;
/** 一格的位置：字段名和明细的行号，如 ['lines', 0, 'kind'] */
export type FieldPath = (string | number)[];

/** 去掉可选、可空、默认值、只读、预处理这几层包装（数组不去）；tests/zod-fields.ts 也用这一份 */
export function unwrapped(schema: Schema): Schema {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrapped(schema.unwrap());
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) return unwrapped(schema.unwrap());
  if (schema instanceof z.ZodReadonly || schema instanceof z.ZodCatch) return unwrapped(schema.unwrap());
  // 预处理（preprocess）是“转换 → 结构”，取后面的结构；transform 是“结构 → 转换”，取前面的
  if (schema instanceof z.ZodPipe) return unwrapped(schema.in instanceof z.ZodTransform ? schema.out : schema.in);
  return schema;
}

/**
 * 提交的内容里结构不收的栏目，不管在第几层（对象逐个字段、明细逐行）：zod 的对象会把它们悄悄丢掉。
 * 值不是对象、数组的不往下查（写法不对留给校验去拦）。
 */
export function unknownFields(value: unknown, schema: Schema, path: FieldPath = []): FieldPath[] {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodArray)
    return Array.isArray(value) ? value.flatMap((row, i) => unknownFields(row, inner.element, [...path, i])) : [];
  if (!(inner instanceof z.ZodObject) || !isRecord(value)) return [];
  const shape: Record<string, Schema> = inner.shape;
  return Object.entries(value).flatMap(([key, v]) =>
    Object.hasOwn(shape, key) ? unknownFields(v, shape[key], [...path, key]) : [[...path, key]],
  );
}

/** 按 JSON 比：记录里的值经过接口来回一趟（没写的键、undefined 都去掉）再和补丁比 */
const asJson = (v: unknown): unknown => {
  const text = JSON.stringify(v);
  return text === undefined ? undefined : JSON.parse(text);
};
const same = (a: unknown, b: unknown) => isDeepStrictEqual(asJson(a), asJson(b));

/** 记录里对应的那一格：找到了给值，记录里没有这一格是 undefined */
type Counterpart = { value: unknown } | undefined;
/** 没编号的一行和记录里另一行有几格一样 */
const overlap = (row: unknown, other: unknown) =>
  isRecord(row) && isRecord(other) ? Object.keys(row).filter((k) => Object.hasOwn(other, k) && same(row[k], other[k])).length : 0;
/**
 * 明细的一行在记录里对应哪一行：带编号的按编号找；没编号的（到货、送货单明细）按内容找一样的格子最多的那一行，
 * 一样多的按第几行（删行、对调以后挪了位置也认得出原来是哪一行，不把别的行的金额当成改了）
 */
function rowOf(rows: unknown[], row: unknown, index: number): Counterpart {
  const id = isRecord(row) ? row.id : undefined;
  if (typeof id === 'number') {
    const found = rows.find((r) => isRecord(r) && r.id === id);
    return found === undefined ? undefined : { value: found };
  }
  let best = index < rows.length ? index : -1,
    score = best < 0 ? 0 : overlap(row, rows[best]);
  rows.forEach((r, i) => {
    const s = overlap(row, r);
    if (s > score) [best, score] = [i, s];
  });
  return best < 0 ? undefined : { value: rows[best] };
}
/** 补丁里 path 这一格的值（mine），和它在读出来的记录里对应的那一格（theirs） */
function pairAt(record: unknown, patch: unknown, path: FieldPath): { mine: unknown; theirs: Counterpart } {
  let mine: unknown = patch,
    theirs: Counterpart = { value: record };
  for (const step of path) {
    const from: unknown = theirs?.value;
    if (typeof step === 'number') {
      mine = Array.isArray(mine) ? mine[step] : undefined;
      theirs = Array.isArray(from) ? rowOf(from, mine, step) : undefined;
    } else {
      mine = isRecord(mine) ? mine[step] : undefined;
      theirs = isRecord(from) && Object.hasOwn(from, step) ? { value: from[step] } : undefined;
    }
  }
  return { mine, theirs };
}

/**
 * 补丁里录入结构不收的栏目，按读出来的这条记录（新建时没有）分开：
 * 记录里同一格本来就有、值也一样的（只读的、算出来的栏目，助手照读到的记录原样带回来的）放过，保存时由录入结构去掉；
 * changed 是记录里有这一格、值改了的（算出来的不能改），unknown 是记录里根本没有这一格的（不认识的栏目）。
 */
export function rejectedFields(patch: Record<string, unknown>, schema: Schema, record: unknown) {
  const changed: FieldPath[] = [],
    unknown: FieldPath[] = [];
  for (const path of unknownFields(patch, schema)) {
    const { mine, theirs } = pairAt(record, patch, path);
    if (record === undefined || !theirs) unknown.push(path);
    else if (!same(mine, theirs.value)) changed.push(path);
  }
  return { changed, unknown };
}

/** 改的时候手里的那条：编辑窗的内容（input）和读出来的记录（record） */
export type Current = { input: unknown; record: unknown };
/**
 * 补丁顶层真正改了的栏目：和编辑窗的内容、读出来的记录都不一样的才算，照原样带回的不算
 * （已生效单据整条读出来、只改备注时，日期、明细、单号照原样带回，不当成改了数量）。新建时全都算。
 */
export function editedKeys(patch: Record<string, unknown>, current: Current | undefined): string[] {
  const unchanged = (key: string, from: unknown) => isRecord(from) && Object.hasOwn(from, key) && same(patch[key], from[key]);
  return Object.keys(patch).filter((key) => !current || !(unchanged(key, current.input) || unchanged(key, current.record)));
}
