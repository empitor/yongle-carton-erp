import { useEffect, useEffectEvent, useState } from 'react';
import { errorMessage, pageParams } from '../../shared/core/index';
import { readFlow } from '../flow/flow-api';
import type { FlowDesk } from '../flow/useFlowDesk';
import type { WarehouseList } from './useWarehouseList';
import { docIdOf, isFlowDoc, needsWork, type WarehouseKind, type WarehouseRow } from './warehouse-list';

/** 地址里要打开的那一张单据（doc=编号），没带或写坏的给 null */
export const linkedDocId = (hash: string) => pageParams('warehouse', hash).doc ?? null;

/** 链接里那张单据在眼前这份列表里的那一行（看已归档时在已归档的单据里找） */
export function linkedRow<R extends Parameters<typeof docIdOf>[0], A extends Parameters<typeof docIdOf>[0]>(
  focus: number,
  list: { records: readonly R[]; archivedScope: boolean; archivedRows: readonly A[] },
): R | A | undefined {
  return (list.archivedScope ? list.archivedRows : list.records).find((r) => docIdOf(r) === focus);
}

/**
 * 到货、送货页打开的那一条：点一行读它的单据（按钮按单据现在的状态算）、地址栏带着 doc 时打开那一张、
 * 业务数据变了重读打开着的单据。desk.view 是打开的单据。
 */
export function useWarehouseView(kind: WarehouseKind, list: WarehouseList, desk: FlowDesk) {
  const { records, archivedScope, loaded, revision } = list;
  const { setView, view } = desk;
  const [openError, setOpenError] = useState('');
  /** 打开一条记录；已归档的列表本身就是单据 */
  const open = (r: WarehouseRow) => {
    if (archivedScope && isFlowDoc(r)) {
      setView(r);
      return;
    }
    readFlow(docIdOf(r))
      .then((doc) => {
        setOpenError('');
        setView(doc);
      })
      .catch((e: unknown) => setOpenError(errorMessage(e)));
  };
  // 从链接打开某一张：不在待处理里就切到全部；是更早的单据就读全部再找；已归档的（archived=1）等已归档的单据读到再找。
  // 记录读到或变了时看一次，只打开一回
  const [focused, setFocused] = useState(false);
  const focusLinked = useEffectEvent(() => {
    const focus = linkedDocId(location.hash);
    if (!focus || focused || !loaded || (archivedScope && list.archivedLoading)) return;
    const found = linkedRow<WarehouseRow, WarehouseRow>(focus, list);
    if (!found) {
      if (!archivedScope && !list.full) list.setFull(true);
      return;
    }
    setFocused(true);
    open(found);
    if (list.scope === 'open' && !needsWork(kind, found)) list.setScope('all');
  });
  useEffect(() => {
    focusLinked();
  }, [records, loaded, list.archivedLoading]);
  // 业务数据变了（办完一件事、别处改了）：打开着的单据重读；已经删掉的关掉详情。只看变的那一刻打开着哪一张
  const viewId = view?.id;
  const openedId = useEffectEvent(() => (archivedScope ? null : viewId));
  useEffect(() => {
    const id = openedId();
    if (!id) return;
    let active = true;
    readFlow(id)
      .then((doc) => active && setView((v) => (v?.id === id ? doc : v)))
      .catch(() => active && setView((v) => (v?.id === id ? null : v)));
    return () => {
      active = false;
    };
  }, [revision, setView]);
  return { open, openError };
}
