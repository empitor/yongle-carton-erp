import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataManagementApi } from '../../shared/admin/index';
import { errorMessage } from '../../shared/core/index';
import { readRecords, readWorkspaces } from './data-api';
import { buildRefs, refModules, type RecordRefs } from './record-refs';
import { managedModule, type ListedRecord } from './record-types';

type ManagedList = DataManagementApi['GET /management/records']['response'];
type WorkspaceLists = DataManagementApi['GET /management/workspaces']['response'];
/** 读到的列表：一个业务模块的（带新建模板），或 AI 识别工作区的（在用的、归档的） */
type RecordData = ManagedList | WorkspaceLists;
type WorkspaceRow = WorkspaceLists['active'][number];

/** 读一个模块的列表：识别工作区走它自己的地址 */
const readList = (module: string): Promise<RecordData> =>
  module === 'workspaces' ? readWorkspaces() : readRecords(managedModule(module));
/** 识别文件整理成和业务记录一样的样子：版本号是 revision，名称是文件名 */
const workspaceRecord = (r: WorkspaceRow, archived: boolean): ListedRecord => ({
  record: { ...r, id: r.id, version: r.revision, archived, name: r.fileName },
});
/** 列表上的记录（换模块时上一个模块的数据还没清掉，形状对不上的当没有） */
function listedRecords(module: string, data: RecordData | null): ListedRecord[] {
  if (!data) return [];
  if (module === 'workspaces')
    return 'active' in data
      ? [...data.active.map((r) => workspaceRecord(r, false)), ...data.archived.map((r) => workspaceRecord(r, true))]
      : [];
  return 'records' in data ? data.records : [];
}

/**
 * 数据管理一个模块的列表：换模块就重读（慢的旧请求回来不覆盖新的）；AI 识别工作区把进行中的和回收站的拼成一张表。
 * 编辑窗打开时读关联的候选（客户、产品、订单……），关窗就丢掉，下次打开重读，免得拿到旧名字。
 * onError 每次渲染可能是新的函数：记在 ref 里取最新的，不因为它换了就重读列表。
 */
export function useRecordList(module: string, dialogOpen: boolean, onError: (message: string) => void) {
  const [data, setData] = useState<RecordData | null>(null),
    [refs, setRefs] = useState<RecordRefs | null>(null);
  const generation = useRef(0),
    report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });
  // 每读一次编号加一：只认最后一次读的回答（换了模块、又点了刷新，早发出去的慢回答不覆盖新的）
  const load = useCallback(async () => {
    const g = ++generation.current;
    try {
      const next = await readList(module);
      if (g === generation.current) setData(next);
    } catch (e) {
      if (g === generation.current) report.current(errorMessage(e));
    }
  }, [module]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  const records = listedRecords(module, data);
  useEffect(() => {
    setRefs(null);
    if (!dialogOpen || module === 'workspaces' || !data || !('records' in data)) return;
    let live = true;
    const own = data.records.map((x) => x.record);
    void Promise.all(
      (refModules[module] || []).map((m) => readRecords(m).then((r) => [m, r.records.map((x) => x.record)] as const)),
    )
      .then((pairs) => {
        if (live) setRefs(buildRefs({ ...Object.fromEntries(pairs), [module]: own }));
      })
      .catch((e: unknown) => {
        if (live) report.current('关联的客户、产品等候选没读出来：' + errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [dialogOpen, module, data]);
  return {
    loaded: !!data,
    template: data && 'template' in data ? data.template : null,
    records,
    refs,
    load,
  };
}
