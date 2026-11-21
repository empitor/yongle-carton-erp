import { useState } from 'react';
import { ManagementDialog } from '../ui/index';
import { EditorFooter } from '../ui/index';
import { MenuItem, MoreMenu } from '../ui/index';
import type { ArchivedWorkspace, UnreadableWorkspace } from '../../shared/import/index';
import { FailureList } from './ImportFailures';

export type HistoryTab = 'archives' | 'failures';

/** 内容和程序要求的样子对不上、读不出来的文件：打不开、不能恢复；本机管理员可以永久删除 */
function UnreadableList({
  files,
  localAdmin,
  remove,
}: {
  files: UnreadableWorkspace[];
  localAdmin: boolean;
  remove: (id: string) => void;
}) {
  if (!files.length) return null;
  return (
    <>
      <p className="choice-list-empty">
        读不出来的文件 {files.length}：打不开、不能恢复{localAdmin ? '，可以永久删除。' : '，请本机管理员永久删除。'}
      </p>
      <ul className="aii-rows">
        {files.map((f) => (
          <li key={f.id}>
            <span title={f.problem}>{f.problem}</span>
            {localAdmin && (
              <MoreMenu text="更多" label="更多操作 读不出来的文件">
                <MenuItem danger onClick={() => remove(f.id)}>
                  永久删除
                </MenuItem>
              </MoreMenu>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * “历史与归档”：AI 导入页“更多”里唯一的一项。
 * 已归档的文件（打开看、恢复；本机管理员可以永久删除）、读不出来的文件和识别失败的记录放在一个窗口里；
 * 本机管理员另有“管理原件和任务”，打开数据管理里的工作区模块。
 */
export default function HistoryDialog({
  archives,
  unreadable,
  selectedId,
  initialTab = 'archives',
  localAdmin,
  close,
  open,
  restore,
  remove,
  manage,
}: {
  archives: ArchivedWorkspace[];
  unreadable: UnreadableWorkspace[];
  selectedId: string;
  initialTab?: HistoryTab;
  localAdmin: boolean;
  close: () => void;
  open: (id: string) => void;
  restore: (id: string) => void;
  remove: (id: string) => void;
  manage: () => void;
}) {
  const [tab, setTab] = useState<HistoryTab>(initialTab);
  return (
    <ManagementDialog
      title="历史与归档"
      subtitle="归档的文件仍保留原件和识别结果；识别失败的每次都留一条记录"
      size="lg"
      close={close}
      footer={
        <EditorFooter note={tab === 'archives' ? '恢复后回到文件列表。' : '下载诊断可以发给维护人员排查。'}>
          {localAdmin && (
            <button type="button" className="secondary" onClick={manage}>
              管理原件和任务
            </button>
          )}
          <button type="button" className="secondary" onClick={close}>
            关闭
          </button>
        </EditorFooter>
      }
    >
      <div className="record-view-tabs aii-history-tabs" role="tablist" aria-label="历史与归档">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'archives'}
          className={tab === 'archives' ? 'selected' : ''}
          onClick={() => setTab('archives')}
        >
          已归档 {archives.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'failures'}
          className={tab === 'failures' ? 'selected' : ''}
          onClick={() => setTab('failures')}
        >
          识别失败
        </button>
      </div>
      {tab === 'archives' && <UnreadableList files={unreadable} localAdmin={localAdmin} remove={remove} />}
      {tab === 'archives' ? (
        archives.length || unreadable.length ? (
          <ul className="aii-rows">
            {archives.map((f) => (
              <li key={f.id}>
                <span title={f.fileName ?? undefined}>{f.fileName}</span>
                <button type="button" className="secondary" onClick={() => restore(f.id)}>
                  恢复
                </button>
                <MoreMenu text="更多" label={'更多操作 ' + f.fileName}>
                  <MenuItem onClick={() => open(f.id)}>
                    打开查看
                  </MenuItem>
                  {localAdmin && (
                    <>
                      <hr className="more-menu-sep" />
                      <MenuItem danger onClick={() => remove(f.id)}>
                        永久删除
                      </MenuItem>
                    </>
                  )}
                </MoreMenu>
              </li>
            ))}
          </ul>
        ) : (
          <p className="choice-list-empty">没有归档的文件。</p>
        )
      ) : (
        <FailureList selectedId={selectedId} />
      )}
    </ManagementDialog>
  );
}
