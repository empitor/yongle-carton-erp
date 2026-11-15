import { useEffect, useState } from 'react';
import { readCatalog } from './catalog-api';
import { nestByFamily, type FamilyProduct, type NestedRow, type RecordEntity } from '../../shared/business/index';
import { listen } from '../ui/index';

/**
 * 产品附属关系（谁挂在谁下面）：整个页面共用一份产品清单，读一次，业务数据变了再读。
 * 列表、产品详情、成品库存、订单明细都从这里取“附属于谁”“有哪些附属品”，显示一致。
 */
let cache: FamilyProduct[] | null = null,
  loading: Promise<FamilyProduct[]> | null = null;
const listeners = new Set<(rows: FamilyProduct[]) => void>();

function load() {
  loading ||= readCatalog(['products'])
    .then(({ products }) => products.map((p) => ({ id: p.id, name: p.name, parentProductId: p.parentProductId ?? null })))
    .then((rows) => {
      cache = rows;
      listeners.forEach((f) => f(rows));
      return rows;
    })
    .catch(() => cache || [])
    .finally(() => {
      loading = null;
    });
  return loading;
}

if (typeof window !== 'undefined')
  listen('erp-business-changed', () => {
    if (listeners.size) void load();
    else cache = null;
  });

/** enabled=false 时不读（客户、订单这类列表用不到附属关系）。 */
export function useProductFamily(enabled = true) {
  const [rows, setRows] = useState<FamilyProduct[]>(cache || []);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setRows);
    if (cache) setRows(cache);
    else void load();
    return () => {
      listeners.delete(setRows);
    };
  }, [enabled]);
  const byId = new Map(rows.map((p) => [p.id, p]));
  return {
    products: rows,
    parentOf: (id: number | null | undefined) => (id != null ? byId.get(id)?.parentProductId ?? null : null),
    nameOf: (id: number | null | undefined) => (id != null ? byId.get(id)?.name || '' : ''),
    childrenOf: (id: number) => rows.filter((p) => p.parentProductId === id),
  };
}

/** 列表里的一行：产品带它附属于谁，成品库存品带种类和对应的产品；别的记录只用编号 */
type FamilyRow = { id: number; parentProductId?: number | null; kind?: string; productId?: number | null };

/**
 * 产品、成品库存按附属关系排：附属品紧跟在它附属的产品下面，缩进一层（像主会话下面的子会话）。
 * 给列表排好的行、名称前面的连接线（familyMark）和“附属于 …”标记（familyTag）；别的记录照 sortedBase 原样排。
 */
export function useRecordFamily<T extends FamilyRow>(entity: RecordEntity, rows: readonly T[], sortedBase: readonly T[]) {
  const nestable = entity === 'products' || entity === 'stock_items',
    family = useProductFamily(nestable);
  const ownParent = new Map<number, number | null>(
    entity === 'products' ? rows.map((r) => [r.id, r.parentProductId ?? null]) : [],
  );
  const nested: NestedRow<T>[] = nestable
    ? nestByFamily(
        sortedBase,
        (r) => (entity === 'products' ? r.id : r.kind === 'finished' ? r.productId : null),
        (id) => (entity === 'products' ? ownParent.get(id) : undefined) ?? family.parentOf(id),
      )
    : sortedBase.map((row) => ({ row, depth: 0, last: false }));
  const sortedRows = nested.map((n) => n.row),
    nestOf = new Map(nested.map((n) => [n.row, n]));
  /** 名称前面的连接线：附属品往里缩一层，画“├”或“└”；附属的产品被筛掉时标出附属于谁 */
  const familyMark = (row: T) => {
    const n = nestOf.get(row);
    if (!n) return null;
    if (n.depth > 0)
      return (
        <span
          className={'record-tree-branch' + (n.last ? ' is-last' : '')}
          style={{ marginLeft: (n.depth - 1) * 18 }}
          aria-hidden="true"
        />
      );
    return null;
  };
  const familyTag = (row: T) => {
    const n = nestOf.get(row),
      productId = entity === 'products' ? row.id : row.productId,
      parent = n?.depth ? family.parentOf(productId) ?? row.parentProductId : n?.parentOutside;
    if (!parent) return null;
    return (
      <span className={n?.depth ? 'sr-only' : 'record-state record-parent'}>附属于 {family.nameOf(parent) || '其他产品'}</span>
    );
  };
  return { sortedRows, familyMark, familyTag };
}
