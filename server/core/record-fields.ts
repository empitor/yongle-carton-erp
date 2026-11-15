import { legacyCents, samePrice } from '../../shared/core/index.js';
import { InputError } from './errors.js';

/* 客户、产品、订单读写共用的规则：改哪条、存完读回来、没给的附加字段怎么读、精确价和“分”都给了时听谁的 */

/** 要改的那条记录：编号和打开时的版本号（库里的版本对不上就是别人先改了） */
export type ExistingRecord = { id: number; version: number };
/** 保存的目标：给了编号（不是 0）是改那一条，要带打开时的版本号；没给编号是新建，返回 undefined */
export function existingRecord(id: number | undefined, version: number | undefined): ExistingRecord | undefined {
  if (!id) return undefined;
  if (version === undefined) throw new Error('改已有记录要带打开时的版本号');
  return { id, version };
}
/** 刚存好的记录按同样的范围读回来：读不到是程序问题（调用方保存前已经按这个范围确认过记录在） */
export function readBack<T>(saved: T | undefined, what: string): T {
  if (saved === undefined) throw new Error(what + '保存以后读不回来');
  return saved;
}

/**
 * 可以不填的附加字段：从没给过的库里是 NULL，读出来不带这个键（接口里“没给”一直是没有这个键，不是 null）；
 * 给了空串的照存空串、照样读出来。用法：{ ...given('notes', row.notes) }
 */
export function given<K extends string, V>(key: K, value: V | null) {
  const out: Partial<Record<K, V>> = {};
  if (value !== null) out[key] = value;
  return out;
}

/**
 * 精确价和“分”都给了时听谁的（产品参考价、订单明细单价同一条规则；价格不猜）：
 * - 两个对得上：按精确价存；
 * - 只改了一头，另一头还是原来的值：按改的那一头存。整条记录带回来只改了分（比如数据管理的单条编辑）按分，
 *   只改了精确价按精确价；精确价写法不同、数值相同（1.5 和 1.5000）算没改；
 * - 新建时就对不上，或者两头都改了还对不上：拒收，提示只填一个或改成一致。
 * 这里只看到“这次给了什么”，分不出“精确价没给”和“精确价被清空”。改记录的入口（数据管理、助手）先用
 * shared/core/precision.ts 的 priceEdit 判断补丁的意思再交过来：精确价清空、分没动的产品存成没定价
 * （分给 0），订单明细拒收（单价必填）；精确价清空、分改了的按分存；分改了、精确价还是原来的去掉旧精确价。
 * 返回要采用的精确价；undefined 是按分存。what 是报错里的叫法（“参考单价”“某产品的单价”）。
 */
export function chosenExact(
  exact: string | undefined,
  cents: number,
  previousExact: string | undefined,
  previousCents: number | undefined,
  what: string,
) {
  if (exact === undefined || legacyCents(exact) === cents) return exact;
  const exactChanged = previousExact === undefined || !samePrice(exact, previousExact),
    centsChanged = cents !== previousCents;
  if (exactChanged && centsChanged)
    throw new InputError(
      what + '：“分”填的是 ' + cents + '，精确价填的是 ' + exact + ' 元，两个对不上。请只填一个，或改成一致的值。',
    );
  return centsChanged ? undefined : exact;
}
