import { useEffect, useEffectEvent, type ReactNode } from 'react';
import { EmptyState, Pagination, TableRegion, useResettingPage, yuan, LIST_PAGE_SIZE } from '../ui/index';
import { useFinLoad } from './fin-api';
import { ErrorLine } from './layout';

/* 财务各页的表格：列定义、表格和带翻页的列表。 */

/**
 * 表格的一行：没写 render 的列按列名取值。列没写行类型（`Col<行>[]`）时就是它，
 * 放进有类型的表格照样能用（行类型从 rows 或 FinList 的 list 推）。
 */
type FinRow = { readonly [key: string]: unknown };
/** 行的键：表格的 key 和选中的那一行都按它认 */
type RowKey = string | number;

const cellText = (v: unknown): ReactNode => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
};
export type Col<R = FinRow> = {
  key: string;
  label: ReactNode;
  /** 分转元，右对齐 */
  money?: boolean;
  num?: boolean;
  wrap?: boolean;
  /**
   * 列优先级（src/design.css“列表的列优先级”）：表格区域窄于 900px 时收起 low，窄于 660px 时再收起 mid。
   * 右侧详情打开时 1440 宽区域约 728px、1280 宽约 600px。关键列不标，一直显示；手机卡片不收列。
   */
  priority?: 'low' | 'mid';
  render?: (row: R) => ReactNode;
};
/** th、td 的 className：数字右对齐、文字列省略、列优先级合成一个字符串 */
const colClass = <R,>(c: Col<R>, cell: boolean) =>
  [
    c.money || c.num ? 'num' : cell && c.wrap ? 'cell-wrap' : '',
    c.priority ? 'col-' + c.priority : '',
  ]
    .filter(Boolean)
    .join(' ') || undefined;
export const col = <R = FinRow,>(key: string, label: ReactNode, extra: Partial<Col<R>> = {}): Col<R> => ({
  key,
  label,
  ...extra,
});
export const mon = <R = FinRow,>(key: string, label: string): Col<R> => ({ key, label, money: true });

/** 没给 rowKey 时按行的 id 认（id 是空的照样是空的）；没有 id 的行没有键 */
const rowId = (row: FinRow): RowKey | null | undefined =>
  typeof row.id === 'string' || typeof row.id === 'number' || row.id === null ? row.id : undefined;
/** 点在行里的链接、按钮、输入框上不算点这一行 */
const onControl = (target: EventTarget) =>
  target instanceof Element && target.closest('a,button,input,select,label') !== null;

/** 一个格子：写了 render 的照它画，金额列分转元，其余按列名取值 */
const cell = <R extends FinRow>(c: Col<R>, row: R) =>
  c.render ? c.render(row) : c.money ? yuan(row[c.key]) : cellText(row[c.key]);

export function FinTable<R extends FinRow>({
  cols,
  rows,
  rowKey,
  onRow,
  selected,
  empty,
  label = '财务记录表格',
}: {
  cols: readonly Col<R>[];
  rows: readonly R[];
  rowKey?: (row: R, index: number) => RowKey;
  onRow?: (row: R) => void;
  selected?: RowKey | null;
  empty?: string;
  label?: string;
}) {
  return (
    <TableRegion label={label}>
      <table className="fin-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={colClass(c, false)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const k = rowKey ? rowKey(row, i) : rowId(row);
            return (
              <tr
                key={k}
                className={(onRow ? 'record-row' : '') + (selected === k ? ' selected' : '')}
                aria-selected={onRow ? selected === k : undefined}
                tabIndex={onRow ? 0 : undefined}
                onClick={(e) => {
                  if (onRow && !onControl(e.target)) onRow(row);
                }}
                onKeyDown={(e) => {
                  if (onRow && e.key === 'Enter' && e.target === e.currentTarget) onRow(row);
                }}
              >
                {cols.map((c) => (
                  <td key={c.key} className={colClass(c, true)}>
                    {cell(c, row)}
                  </td>
                ))}
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={cols.length}>
                <EmptyState title={empty || '这里还没有记录'} description="" />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </TableRegion>
  );
}

/** 财务列表的一页（服务端 server/finance/query.ts 的 pageSql）：这页的行、第几页、每页几条、筛出来一共几条 */
type FinPage<R> = { rows: R[]; page: number; pageSize: number; filteredRecords: number };
/** FinList 往查询参数里补的翻页参数 */
type PageQuery = { page: number; pageSize: number };

/** 一页里的行 */
type RowOf<D extends FinPage<FinRow>> = D['rows'][number];

/** 列表从哪读、怎么画（D 是读回来的一页，有的列表还带合计这类别的项，原样交给 onData） */
type FinListProps<Q, D extends FinPage<FinRow>> = {
  /**
   * 读一页的函数：各页 *-api.ts 导出的（`(q) => finRead('GET /finance/…', { query: q })`），行类型从它推出来。
   * 换读法、换条件都要体现在 query 里（只按 query 和翻页认要不要重读）。
   */
  list: (query: Q & PageQuery) => Promise<D>;
  query: Q;
  /** 行类型从 list 推，不从列推（列不写类型时是 FinRow） */
  cols: readonly Col<NoInfer<RowOf<D>>>[];
  rowKey?: (row: NoInfer<RowOf<D>>, index: number) => RowKey;
  onRow?: (row: NoInfer<RowOf<D>>) => void;
  selected?: RowKey | null;
  empty?: string;
  label?: string;
  onData?: (data: NoInfer<D>) => void;
  pageSize?: number;
};

/** 带翻页的列表：组件自己取数，条件变了自动回第一页。 */
export function FinList<Q extends object, D extends FinPage<FinRow>>(props: FinListProps<Q, D>) {
  const { list, query, cols, rowKey, onRow, selected, empty, label, onData, pageSize = LIST_PAGE_SIZE } = props;
  const [page, setPage] = useResettingPage(JSON.stringify(query));
  const { data, error } = useFinLoad(JSON.stringify({ ...query, page, pageSize }), () =>
    list({ ...query, page, pageSize }),
  );
  // onData 只是回传（每次渲染可能是新函数），不作为重新取数、重新回传的依据：按这一页的数据回传一次
  const reportData = useEffectEvent((loaded: D) => onData?.(loaded));
  useEffect(() => {
    if (data) reportData(data);
  }, [data]);
  return (
    <section className="panel business-records">
      <ErrorLine text={error} />
      <FinTable
        cols={cols}
        rows={data?.rows || []}
        rowKey={rowKey}
        onRow={onRow}
        selected={selected}
        empty={data ? empty : '正在读取…'}
        label={label}
      />
      {data && data.filteredRecords > (data.pageSize || pageSize) && (
        <Pagination
          page={data.page || page}
          total={data.filteredRecords}
          pageSize={data.pageSize || pageSize}
          onChange={setPage}
        />
      )}
    </section>
  );
}
