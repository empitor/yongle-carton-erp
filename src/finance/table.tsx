import { useEffect, useEffectEvent } from 'react';
import { DataTable, FormMessage, Pagination, useResettingPage, LIST_PAGE_SIZE, loadingText, type Col, type RowKey } from '../ui/index';
import { useFinLoad } from './fin-api';

/* 财务各页带翻页的列表：自己按页读，表格用 src/ui 的 DataTable。 */

/** 财务表格的类名：金额、数字列右对齐不换行（finance.css） */
export const FIN_TABLE = 'fin-table';

/** 财务列表的一页（服务端 server/finance/query.ts 的 pageSql）：这页的行、第几页、每页几条、筛出来一共几条 */
type FinPage<R> = { rows: R[]; page: number; pageSize: number; filteredRecords: number };
/** FinList 往查询参数里补的翻页参数 */
type PageQuery = { page: number; pageSize: number };

/** 一页里的行 */
type RowOf<D extends FinPage<object>> = D['rows'][number];

/** 列表从哪读、怎么画（D 是读回来的一页，有的列表还带合计这类别的项，原样交给 onData） */
type FinListProps<Q, D extends FinPage<object>> = {
  /**
   * 读一页的函数：各页 *-api.ts 导出的（`(q) => finRead('GET /finance/…', { query: q })`），行类型从它推出来。
   * 换读法、换条件都要体现在 query 里（只按 query 和翻页认要不要重读）。
   */
  list: (query: Q & PageQuery) => Promise<D>;
  query: Q;
  /** 行类型从 list 推，不从列推（列不写类型时按列名取值） */
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
export function FinList<Q extends object, D extends FinPage<object>>(props: FinListProps<Q, D>) {
  const { list, query, cols, rowKey, onRow, selected, empty, label = '财务记录表格', onData, pageSize = LIST_PAGE_SIZE } = props;
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
      <FormMessage>{error}</FormMessage>
      <DataTable
        className={FIN_TABLE}
        cols={cols}
        rows={data?.rows || []}
        rowKey={rowKey}
        onRow={onRow}
        selected={selected}
        empty={data ? empty : loadingText()}
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
