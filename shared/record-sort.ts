/** 列表排序规则：前端本地排序和服务端分页共用，保证翻页前后顺序一致。 */
export const recordSorts = ['recent', 'oldest', 'name', 'due'] as const;
export type RecordSort = (typeof recordSorts)[number];

type Sortable = {
  id: number;
  name?: string;
  number?: string;
  deliveryDate?: string;
  expectedDate?: string | null;
};

export function compareRecords(sort: RecordSort) {
  return (a: Sortable, b: Sortable) => {
    if (sort === 'name')
      return (
        String(a.name || a.number).localeCompare(String(b.name || b.number), 'zh-CN', {
          numeric: true,
        }) || b.id - a.id
      );
    if (sort === 'due')
      return (
        String(a.deliveryDate || a.expectedDate || '').localeCompare(
          String(b.deliveryDate || b.expectedDate || ''),
        ) || b.id - a.id
      );
    return sort === 'oldest' ? a.id - b.id : b.id - a.id;
  };
}
