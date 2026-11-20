import { lazy, Suspense, useEffect, useState } from 'react';
import { compareRecords, type RecordSort } from '../../shared/core/index';
import { type RecordEntity } from '../../shared/business/index';
import { canEditBusiness, useAuthState, LIST_PAGE_SIZE } from '../ui/index';
import { Hint, Pagination } from '../ui/index';
import RecordTable from './RecordTable';
import RecordSelectionBar from './RecordSelectionBar';
import RecordPanel from './RecordPanel';
import RecordContextDialog from '../recordkit/RecordContext';
import SortHead from './SortHead';
import { useRecordFamily } from '../recordkit/useProductFamily';
import { useRecordSelection, type RecordPaging, type RecordSelection } from './useRecordSelection';
import { readRecord } from '../recordkit/record-api';
import { recordLabel, type RecordRow, type RecordRowOf } from './record-rows';

// 删除窗、更正到货单窗口点了才用，按需加载
const DatabaseDeleteDialog = lazy(() => import('../recordkit/DatabaseDeleteDialog'));
const CorrectionDialog = lazy(() => import('../flow/CorrectionDialog'));

const nouns: Record<RecordEntity, { noun: string; unit: string }> = {
  customers: { noun: '客户', unit: '家' },
  products: { noun: '产品', unit: '款' },
  orders: { noun: '订单', unit: '张' },
  suppliers: { noun: '供应商', unit: '家' },
  purchases: { noun: '采购单', unit: '张' },
  stock_items: { noun: '库存品', unit: '种' },
};

/** 按一条重读：供应商没有单条读的地址，也不会从地址打开、不会跟着业务变化重读（useRecordSelection 只读订单、采购单、产品、库存品） */
const readers: { [E in RecordEntity]: (id: number | string) => Promise<RecordRowOf[E]> } = {
  orders: (id) => readRecord('orders', id),
  customers: (id) => readRecord('customers', id),
  products: (id) => readRecord('products', id),
  purchases: (id) => readRecord('purchases', id),
  stock_items: (id) => readRecord('stock_items', id),
  suppliers: () => Promise.reject(new Error('供应商没有按一条读的地址。')),
};

/** 删除（本机管理员、超级管理员）：提示由页面顶上统一显示一次（和归档一样），这里不再重复；删掉的记录详情一起关掉 */
function DeleteRecords<R extends RecordRow>(o: {
  entity: RecordEntity;
  rows: R[];
  s: RecordSelection<R>;
  close: () => void;
  changed: (m?: string) => void;
}) {
  const { s } = o;
  return (
    <DatabaseDeleteDialog
      module={o.entity}
      rows={o.rows}
      close={o.close}
      done={(message) => {
        const removed = new Set(o.rows.map((r) => r.id));
        s.setMessage('');
        o.close();
        s.setSelected([]);
        s.setView((v) => (v && removed.has(v.id) ? null : v));
        o.changed(message);
      }}
    />
  );
}

/** 采购单详情里到货记录的“更正”：更正到货单窗口 */
function CorrectArrival<R extends RecordRow>({ id, s, changed }: { id: number; s: RecordSelection<R>; changed: (m?: string) => void }) {
  return (
    <CorrectionDialog
      id={id}
      kind="arrival"
      close={() => s.setCorrection(null)}
      done={(result) => {
        s.setCorrection(null);
        changed(result.summary);
      }}
    />
  );
}

/** 右侧详情面板：编辑、归档恢复、修改历史、删除、到货更正、上一条下一条 */
function DetailPanel<E extends RecordEntity>(o: {
  entity: E;
  view: RecordRowOf[E];
  s: RecordSelection<RecordRowOf[E]>;
  archived: boolean;
  canEdit: boolean;
  onMove?: (row: RecordRowOf[E]) => void;
  edit: (row: RecordRowOf[E]) => void;
  history: (c: { id: number; label: string }) => void;
  remove: (rows: RecordRowOf[E][]) => void;
}) {
  const { s, view } = o;
  const actor = useAuthState()?.actor;
  return (
    <RecordPanel
      entity={o.entity}
      row={view}
      archived={o.archived}
      canEdit={o.canEdit}
      superMode={!!actor?.superAdminMode}
      localAdmin={!!actor?.localAdministrator}
      busy={s.busy}
      onMove={o.onMove}
      onEdit={() => {
        o.edit(view);
        s.setView(null);
      }}
      onLifecycle={() => s.executeLifecycle({ action: o.archived ? 'restore' : 'archive', rows: [view] })}
      onHistory={() => {
        o.history({ id: view.id, label: recordLabel(view) });
        s.setView(null);
      }}
      onDelete={() => o.remove([view])}
      correctReceipt={o.canEdit ? s.correct : undefined}
      close={() => s.setView(null)}
      previous={() => s.stepView(-1)}
      next={() => s.stepView(1)}
    />
  );
}

/**
 * 档案、订单、采购单、库存品的列表：表格行不放按钮，点行开右侧详情；点表头排序；
 * 勾选后底部出现选择条（一个正向批量主操作，归档、删除在“更多”）。统计数只在页头出现。
 * 选中、翻页、上一条下一条、批量归档恢复在 useRecordSelection.ts。
 */
export default function BusinessRecords<E extends RecordEntity>({
  entity,
  rows,
  archived,
  edit,
  changed,
  allRecords = false,
  recycle = false,
  onMove,
  filterKey = '',
  paging,
  empty,
}: {
  entity: E;
  rows: RecordRowOf[E][];
  archived: boolean;
  edit: (v: RecordRowOf[E]) => void;
  changed: (message?: string) => void;
  allRecords?: boolean;
  recycle?: boolean;
  /** 库存品“出入库 / 盘点” */
  onMove?: (row: RecordRowOf[E]) => void;
  filterKey?: string;
  paging?: RecordPaging;
  /** 列表空时的一句话和一个动作 */
  empty?: { title: string; description: string };
}) {
  const session = useAuthState(),
    superMode = !!session?.actor?.superAdminMode;
  const canEdit = canEditBusiness(session);
  const [context, setContext] = useState<{ id: number; label: string } | null>(null),
    [permanent, setPermanent] = useState<RecordRowOf[E][] | null>(null);
  const [localSort, setLocalSort] = useState<RecordSort>('recent');
  const sort = paging?.sort ?? localSort;
  const { sortedRows, familyMark, familyTag } = useRecordFamily(entity, rows, paging ? rows : [...rows].sort(compareRecords(sort)));
  const noun = nouns[entity];
  const resetKey = [archived, allRecords, filterKey].join('|');
  const s = useRecordSelection({ entity, noun, rows, sortedRows, resetKey, paging, changed, read: readers[entity] });
  const { view, setView, selected, setSelected, page, busy } = s;
  useEffect(() => setPermanent(null), [entity, resetKey]);
  const rowKey = (row: RecordRowOf[E], text: string) => (
    <button className="row-key" aria-label={'查看 ' + text} onClick={() => setView(row)}>
      {text}
    </button>
  );
  const isArchived = (row: RecordRowOf[E]) => row.archived ?? archived;
  const pageRows = paging ? rows : sortedRows.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);
  const setSort = (next: RecordSort) => {
    if (paging) paging.onSort(next);
    else setLocalSort(next);
    s.setPage(1);
  };
  const sortHead = (text: string, column: 'first' | 'due', className?: string) => (
    <SortHead text={text} column={column} className={className} sort={sort} onSort={setSort} />
  );
  const cell = { rowKey, familyMark, familyTag, isArchived };
  return (
    <section className="panel business-records" data-entity={entity}>
      <h2 className="sr-only">{noun.noun}列表</h2>
      {s.message && (
        <Hint tone={s.message.tone} role="alert">
          {s.message.text}
        </Hint>
      )}
      <RecordTable
        entity={entity}
        noun={noun.noun}
        rows={rows}
        pageRows={pageRows}
        pageOnly={!!paging}
        selected={selected}
        setSelected={setSelected}
        viewId={view?.id}
        open={setView}
        sortHead={sortHead}
        cell={cell}
        empty={empty}
      />
      <RecordSelectionBar
        entity={entity}
        unit={noun.unit}
        picked={rows.filter((r) => selected.includes(r.id))}
        canEdit={canEdit}
        superMode={superMode}
        archivedView={archived || recycle}
        busy={busy}
        isArchived={isArchived}
        lifecycle={s.executeLifecycle}
        remove={setPermanent}
        clear={() => setSelected([])}
      />
      {s.filteredTotal > LIST_PAGE_SIZE && (
        <Pagination page={page} total={s.filteredTotal} pageSize={LIST_PAGE_SIZE} onChange={paging ? paging.onPage : s.setPage} />
      )}
      {context && (
        <RecordContextDialog module={entity} id={context.id} label={context.label} close={() => setContext(null)} />
      )}
      {view && (
        <DetailPanel
          entity={entity}
          view={view}
          s={s}
          archived={isArchived(view)}
          canEdit={canEdit}
          onMove={onMove}
          edit={edit}
          history={setContext}
          remove={setPermanent}
        />
      )}
      <Suspense fallback={<p role="status">正在打开…</p>}>
        {permanent && (
          <DeleteRecords entity={entity} rows={permanent} s={s} close={() => setPermanent(null)} changed={changed} />
        )}
        {s.correction && <CorrectArrival id={s.correction.id} s={s} changed={changed} />}
      </Suspense>
    </section>
  );
}
