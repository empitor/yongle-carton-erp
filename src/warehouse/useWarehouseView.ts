import { useEffect, useEffectEvent, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import { hashParams } from '../ui/index';
import { readFlow } from '../flow/flow-api';
import type { FlowDesk } from '../flow/useFlowDesk';
import type { WarehouseList } from './useWarehouseList';
import { docIdOf, isFlowDoc, needsWork, type WarehouseKind, type WarehouseRow } from './warehouse-list';

/**
 * 到货、送货页打开的那一条：点一行读它的单据（按钮按单据现在的状态算）、地址栏带着 doc 时打开那一张、
 * 业务数据变了重读打开着的单据。desk.view 是打开的单据，selected 是它在列表里的那一行。
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
  // 从链接打开某一张：不在待处理里就切到全部；是更早的单据就读全部再找。记录读到或变了时看一次，只打开一回
  const [focused, setFocused] = useState(false);
  const focusLinked = useEffectEvent(() => {
    const focus = Number(hashParams().get('doc')) || null;
    if (!focus || focused || !loaded) return;
    const found = records.find((r) => docIdOf(r) === focus);
    if (!found) {
      if (!list.full) list.setFull(true);
      return;
    }
    setFocused(true);
    open(found);
    if (list.scope === 'open' && !needsWork(kind, found)) list.setScope('all');
  });
  useEffect(() => {
    focusLinked();
  }, [records, loaded]);
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
  const selected = !archivedScope && view ? records.find((r) => docIdOf(r) === view.id) : undefined;
  return { open, openError, selected };
}
