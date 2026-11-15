import { useAdmin } from '../ui/index';
import { errorMessage } from '../../shared/core/index';
import type { useOrderWorkspace } from './useOrderWorkspace';

type Api = ReturnType<typeof useOrderWorkspace>;

/**
 * 右侧头部“更多”里的项目：重新识别；本机管理员另有“复制成新文件”；最下面“归档”（能恢复，永久删除在“历史与归档”里）。
 */
export default function FileMenu({
  api,
  fileName,
  busy,
  localAdmin,
  reanalyze,
  remove,
}: {
  api: Api;
  fileName: string;
  busy: boolean;
  localAdmin: boolean;
  /** 给了才显示“重新识别” */
  reanalyze?: () => void;
  /** 归档（先弹确认窗） */
  remove: () => void;
}) {
  // 复制识别文件走数据管理提供的接口（src/ui/slots.tsx），不直接请求它的后端
  const admin = useAdmin();
  const id = api.selected;
  async function fork() {
    try {
      const r = await admin.forkWorkspace(id);
      if (!r.results[0]?.success) throw Error(r.results[0]?.message || '复制失败');
      await api.refresh();
      void api.choose(r.results[0].result.id);
      api.setNotice('已复制成一份新文件，可以改识别结果或重新识别。');
    } catch (e) {
      api.setNotice(errorMessage(e));
    }
  }
  return (
    <>
      {reanalyze && (
        <button type="button" role="menuitem" aria-label={'重新识别 ' + fileName} onClick={reanalyze}>
          重新识别
        </button>
      )}
      {localAdmin && (
        <button type="button" role="menuitem" disabled={busy} onClick={() => void fork()}>
          复制成新文件
        </button>
      )}
      <hr className="more-menu-sep" />
      <button type="button" role="menuitem" aria-label={'归档文件 ' + fileName} onClick={remove}>
        归档
      </button>
    </>
  );
}
