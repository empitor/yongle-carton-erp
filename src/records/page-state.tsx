/** 供应商、采购单、库存、流水页共用的小件：进页面时的记录范围、读哪些记录、“全部记录”勾选框。 */

export type Scope = 'pending' | 'all' | 'archived';

/**
 * 进页面时看哪些记录：归档页、带 archived=1 或 scope=archived 的看已归档；带 pending=1 或 scope=pending 的看待处理；
 * pendingByDefault 为真（采购单没带条件进来）时默认待处理，其余看全部。
 */
export function initialScope(
  route: { archived?: boolean; scope?: string; pending?: boolean },
  recycle: boolean,
  pendingByDefault = false,
): Scope {
  return recycle || route.archived || route.scope === 'archived'
    ? 'archived'
    : route.pending || route.scope === 'pending' || pendingByDefault
      ? 'pending'
      : 'all';
}

/** 列表读哪些记录：超级管理员勾了“全部记录”连同已归档的；已归档范围或归档页只读已归档的 */
export const recordRange = (superMode: boolean, all: boolean, archived: boolean) =>
  superMode && all ? '?archived=all' : archived ? '?archived=1' : '';

/** 超级管理员的“连同已归档的一起看（全部记录）”勾选框，放在“筛选”弹层里 */
export function AllRecordsCheck({ all, setAll }: { all: boolean; setAll: (v: boolean) => void }) {
  return (
    <label className="list-toolbar-check">
      <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
      连同已归档的一起看（全部记录）
    </label>
  );
}
