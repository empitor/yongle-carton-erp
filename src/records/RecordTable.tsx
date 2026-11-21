import type { ReactNode } from 'react';
import type { RecordEntity } from '../../shared/business/index';
import { DataRow, EmptyState, SelectAll, SelectRow, TableRegion } from '../ui/index';
import { RecordCells, RecordHead, type RecordCellContext } from './record-columns';
import { recordLabel, type RecordRowOf } from './record-rows';

/**
 * 记录列表的表格：表头（全选、可排序的列）、这一页的行（勾选框、点行开详情、回车也开）、空列表的一句话。
 * 表头和格子按记录种类写在 record-columns.tsx（带排序的表头、按行标逾期），所以不套 DataTable 的列定义，
 * 行和勾选框用它同一套件（src/ui/DataTable.tsx）。行里不放按钮；选中、排序、翻页的状态由 BusinessRecords 管。
 */
export default function RecordTable<E extends RecordEntity>({
  entity,
  noun,
  rows,
  pageRows,
  pageOnly,
  selected,
  setSelected,
  viewId,
  open,
  sortHead,
  cell,
  empty,
}: {
  entity: E;
  noun: string;
  /** 列表里的全部行（服务端分页时是这一页）：全选按它 */
  rows: RecordRowOf[E][];
  /** 这一页要画的行 */
  pageRows: RecordRowOf[E][];
  /** 服务端分页：全选只是这一页 */
  pageOnly: boolean;
  selected: number[];
  setSelected: (update: number[]) => void;
  viewId?: number;
  open: (row: RecordRowOf[E]) => void;
  sortHead: (text: string, column: 'first' | 'due', className?: string) => ReactNode;
  cell: RecordCellContext<RecordRowOf[E]>;
  empty?: { title: string; description: string };
}) {
  return (
    <TableRegion label={noun + '列表'}>
      <table>
        <thead>
          <tr>
            <th>
              <SelectAll
                keys={rows.map((r) => r.id)}
                selected={selected}
                set={setSelected}
                label={(pageOnly ? '全选这一页（' : '全选（') + rows.length + ' 条）'}
              />
            </th>
            <RecordHead entity={entity} sortHead={sortHead} />
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row) => (
            <DataRow key={row.id} open={() => open(row)} opened={viewId === row.id}>
              <td>
                <SelectRow value={row.id} selected={selected} set={setSelected} label={'选择 ' + recordLabel(row)} />
              </td>
              <RecordCells entity={entity} row={row} cell={cell} />
            </DataRow>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={10}>
                <EmptyState
                  title={empty?.title || '没有符合条件的' + noun}
                  description={empty?.description || '换一个范围或清除筛选再看。'}
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </TableRegion>
  );
}
