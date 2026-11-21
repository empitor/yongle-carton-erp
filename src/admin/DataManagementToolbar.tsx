import { Plus, RefreshCw } from 'lucide-react';
import { dataManagementModules, dataManagementNames, dataManagementNoCreate } from '../../shared/business/index';
import { ListSearch, ListToolbarFrame, ListToolbarKey, loadingText } from '../ui/index';

/** 不能新建的模块和原因，按模块名查（识别工作区查不到） */
const noCreate: Partial<Record<string, string>> = dataManagementNoCreate;

/**
 * 数据管理顶上一排：选模块、搜索、条数、刷新、新建（识别文件和不让新建的模块没有“新建”）。
 * 外框、搜索框、模块下拉的位置和列表工具栏共用（ListToolbarFrame）；条数、刷新、新建只有这里有，自己放。
 */
export default function DataManagementToolbar({
  module,
  setModule,
  q,
  setQ,
  count,
  busy,
  reload,
  create,
}: {
  module: string;
  setModule: (module: string) => void;
  q: string;
  setQ: (q: string) => void;
  /** 列表还没读到时为 null；shown 是按搜索筛过的条数 */
  count: { shown: number; total: number } | null;
  busy: boolean;
  reload: () => void;
  /** 新建一条：列表还没读到时为 null */
  create: (() => void) | null;
}) {
  return (
    <ListToolbarFrame label="数据管理筛选">
      <ListToolbarKey>
        <select aria-label="数据管理业务模块" value={module} disabled={busy} onChange={(e) => setModule(e.target.value)}>
          {[...dataManagementModules, 'workspaces'].map((m) => (
            <option key={m} value={m}>
              {dataManagementNames[m]}
            </option>
          ))}
        </select>
      </ListToolbarKey>
      <ListSearch value={q} onChange={setQ} label="数据管理搜索" placeholder="搜索名称、单号、客户或供应商" />
      <span className="adm-data-count">
        {count ? (q ? count.shown + ' / ' : '') + count.total + ' 条' : loadingText()}
      </span>
      <button className="secondary adm-data-tool" disabled={busy} onClick={reload} title="重新读取">
        <RefreshCw size={14} aria-hidden="true" />
        刷新
      </button>
      {module !== 'workspaces' && !noCreate[module] && (
        <button className="primary adm-data-tool" disabled={busy || !create} onClick={() => create?.()}>
          <Plus size={14} aria-hidden="true" />
          新建
        </button>
      )}
    </ListToolbarFrame>
  );
}
