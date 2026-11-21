import { AppError } from './errors.js';
import type { ModuleName } from './module-names.js';

/*
 * 归档标记（record_lifecycle）和永久删除的墓碑（permanent_record_deletions）记的是哪种记录（entity 列）。
 * 两张表归基础、各模块共用，建表只要求种类不为空，不写死上层模块的种类：哪些种类能记由记录的主人模块加载时登记，
 * Store.markArchived 和删除时写墓碑（audit.ts 的 rememberDeletedRecord）先核对，没登记的报错，不会悄悄写进一个谁都不认的种类。
 * 基础自己的客户、产品、订单在这里直接登记（Store 只引这个文件也认得）。
 */
const owners = new Map<string, ModuleName>([
  ['customers', '基础'],
  ['products', '基础'],
  ['orders', '基础'],
]);

/** 登记一个模块能归档、删了要留墓碑的记录种类；同一种类只能由一个模块登记 */
export function registerRecordKinds(module: ModuleName, kinds: readonly string[]) {
  for (const kind of kinds) {
    const owner = owners.get(kind);
    if (owner && owner !== module) throw new AppError('记录种类“' + kind + '”已由' + owner + '登记。', 500);
    owners.set(kind, module);
  }
}

/** 写归档标记、墓碑之前核对：种类没登记就报错 */
export function assertRecordKind(kind: string) {
  if (!owners.has(kind))
    throw new AppError('“' + kind + '”不是登记过的记录种类：归档标记和永久删除记录只收各模块登记的种类，可能是它所属的模块没有加载。', 500);
}
