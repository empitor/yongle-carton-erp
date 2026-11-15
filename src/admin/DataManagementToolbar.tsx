import { Plus, RefreshCw } from 'lucide-react';
import { dataManagementModules, dataManagementNames, dataManagementNoCreate } from '../../shared/business/index';

/** 不能新建的模块和原因，按模块名查（识别工作区查不到） */
const noCreate: Partial<Record<string, string>> = dataManagementNoCreate;

/** 数据管理顶上一排：选模块、搜索、条数、刷新、新建（识别文件和不让新建的模块没有“新建”）。 */
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
    <div className="adm-data-toolbar">
      <select aria-label="数据管理业务模块" value={module} disabled={busy} onChange={(e) => setModule(e.target.value)}>
        {[...dataManagementModules, 'workspaces'].map((m) => (
          <option key={m} value={m}>
            {dataManagementNames[m]}
          </option>
        ))}
      </select>
      <input
        type="search"
        aria-label="数据管理搜索"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索名称、单号、客户或供应商"
      />
      <span className="adm-data-count">
        {count ? (q ? count.shown + ' / ' : '') + count.total + ' 条' : '正在读取…'}
      </span>
      <button className="secondary" disabled={busy} onClick={reload} title="重新读取">
        <RefreshCw size={14} aria-hidden="true" />
        刷新
      </button>
      {module !== 'workspaces' && !noCreate[module] && (
        <button className="primary" disabled={busy || !create} onClick={() => create?.()}>
          <Plus size={14} aria-hidden="true" />
          新建
        </button>
      )}
    </div>
  );
}
