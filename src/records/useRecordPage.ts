import { useEffect, useState } from 'react';
import { canEditBusiness, hashParams, useAuthState, useBusinessRevision, useLoad } from '../ui/index';
import { initialScope, recordRange, type Scope } from './page-state';

/**
 * 供应商、采购单、库存、流水页共用的骨架：登录状态、地址参数、搜索词、记录范围（待处理 / 全部 / 已归档）、
 * 超级管理员的“全部记录”、业务变了重读的版本号、办完的提示。各页只留自己的筛选和读法。
 * recycle 是归档页里的那一类（只看已归档的）；pendingByDefault 为真时没带条件进来默认看待处理。
 */
export function useRecordPage({
  recycle = false,
  pendingByDefault = false,
}: { recycle?: boolean; pendingByDefault?: boolean } = {}) {
  const auth = useAuthState(),
    superMode = !!auth?.actor?.superAdminMode,
    canEdit = canEditBusiness(auth);
  const params = hashParams();
  const [revision, bump] = useBusinessRevision();
  const [search, setSearch] = useState(params.get('q') || ''),
    [scope, setScope] = useState<Scope>(() => initialScope(params, recycle, pendingByDefault)),
    [all, setAll] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!superMode) setAll(false);
  }, [superMode]);
  const archived = scope === 'archived';
  return {
    auth,
    superMode,
    canEdit,
    params,
    revision,
    search,
    setSearch,
    scope,
    setScope,
    all,
    setAll,
    archived,
    /** 列表读哪些记录（'?archived=all'、'?archived=1' 或空） */
    range: recordRange(superMode, all, archived || recycle),
    notice,
    setNotice,
    /** 列表里办完一件事：有话就在列表上方说一句，再重读 */
    changed: (message?: string) => {
      if (message) setNotice(message);
      bump();
    },
  };
}

/**
 * 读这一页的列表：key 变了（筛选、范围、业务版本）就重读；读的时候留着上一份（统计数不闪），没读到前用 initial。
 * 重读时不显示上一次的出错原因。
 */
export function useRecordData<T>(key: string, load: () => Promise<T>, initial: T) {
  const { data, error, loading } = useLoad(key, load);
  return { data: data ?? initial, error: loading ? '' : error, busy: loading };
}
