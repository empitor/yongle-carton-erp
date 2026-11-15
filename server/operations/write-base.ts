import { z } from 'zod';
import type { Actor } from '../core/index.js';
import { AppError, isSuperMode, requirePermission, superModeDenied } from '../core/index.js';
import type { OperationsRepository } from './repository.js';
import type { PurchaseView, StockItemView, SupplierView } from '../../shared/business/index.js';

/*
 * 采购库存的写入共用的两件小事：写入要的权限、改记录前取原记录并核对版本（事务用基础的 inSavepoint）。
 * 供应商、库存品、采购单的保存（service.ts、stock-items.ts、purchase-save.ts）都用这里的，不各写一份。
 */

/** 写采购库存要业务编辑权限 */
export function businessActor(who: Actor | null | undefined) {
  return requirePermission(who, 'business:edit');
}

/** 三种档案各自读出来的样子 */
type Records = { suppliers: SupplierView; purchases: PurchaseView; stock_items: StockItemView };
/** 按种类读一条档案（include：连已归档的一起读） */
const readers: { [E in keyof Records]: (repo: OperationsRepository, include: boolean, id: number) => Records[E] | undefined } = {
  suppliers: (repo, include, id) => repo.suppliers(include, id)[0],
  purchases: (repo, include, id) => repo.purchases(include, id)[0],
  stock_items: (repo, include, id) => repo.items(include, id)[0],
};
const versionInput = z.object({ version: z.number().int().positive() });

/**
 * 改已有记录前取原记录（新建时返回 null）并核对版本号。
 * 读不到有两种：真没有，或者已归档而当前不在超级管理员模式（改已归档的记录要这个模式）。
 * 后一种按 permissions.ts 的分法说：进不了模式的直接说没有权限，没进模式的超级管理员提示去“系统维护”。
 */
export function priorRecord<E extends keyof Records>(
  repo: OperationsRepository,
  entity: E,
  id: number | undefined,
  raw: unknown,
  actor: Actor,
): Records[E] | null {
  if (!id) return null;
  const all = isSuperMode(actor),
    read = readers[entity],
    row = read(repo, all, id);
  if (!row) {
    const archived = !all && read(repo, true, id);
    if (archived) throw superModeDenied(actor, '修改已归档的记录');
    throw new AppError('记录不存在。', 404);
  }
  const { version } = versionInput.parse(raw);
  if (row.version !== version) throw new AppError('记录已被修改，请刷新后重试。', 409);
  return row;
}
