import { FileText, RefreshCw, X } from 'lucide-react';
import { SelectionBar } from '../ui/index';
import type { UnreadableWorkspace } from '../../shared/import/index';
import type { FileItem } from './fileStatus';
import { fileFailed, fileMode, fileStatus, taskRunning } from './fileStatus';
import type { PageDialog } from './ImportPageDialogs';
import type { useChecked } from './useImportPage';

type UploadRow = { id: string; file: File; state: 'queued' | 'uploading' | 'failed'; error?: string };

/** 勾了文件时底部的批量操作条：批量导入（识别好的客户订单）、批量识别（还没识别的）、归档。 */
export function CheckedBar({
  sel,
  signedIn,
  unsaved,
  recognize,
  setDialog,
}: {
  sel: ReturnType<typeof useChecked>;
  signedIn: boolean;
  /** 当前文件有没保存的修改：先保存才能批量导入 */
  unsaved: boolean;
  recognize: (ids: string[]) => void;
  setDialog: (dialog: PageDialog) => void;
}) {
  const { checked, batchTargets, importTargets } = sel;
  if (!checked.length) return null;
  const recognizeChecked = {
    label: '批量识别（' + batchTargets.length + '）',
    onClick: () => recognize(batchTargets),
  };
  const importChecked = {
    label: '批量导入（' + importTargets.length + '）',
    disabled: !signedIn || unsaved,
    title: unsaved ? '先保存当前文件的修改' : undefined,
    onClick: () => setDialog({ kind: 'batch' }),
  };
  return (
    <SelectionBar
      count={checked.length}
      unit="份"
      note={!importTargets.length && !batchTargets.length ? '批量识别和导入只对客户订单' : undefined}
      primary={importTargets.length ? importChecked : batchTargets.length ? recognizeChecked : undefined}
      secondary={importTargets.length && batchTargets.length ? recognizeChecked : undefined}
      more={[{ label: '归档', onClick: () => setDialog({ kind: 'delete', ids: checked, permanent: false }) }]}
      onClear={() => sel.setChecked([])}
    />
  );
}

/**
 * 左栏文件列表：每行文件名 + 当前进度，勾选后可以批量操作。没有文件时整页显示一个拖入区，这里不再放上传按钮。
 * 内容读不出来的文件打不开，列表上只说有几份，点了打开“历史与归档”（在那里永久删除）。
 */
export default function FileList({
  files,
  uploads,
  selected,
  checked,
  setChecked,
  jobs,
  totalDone,
  choose,
  cancel,
  retryUpload,
  discardUpload,
  unreadable,
  openHistory,
}: {
  files: FileItem[];
  uploads: UploadRow[];
  selected: string;
  checked: string[];
  setChecked: (update: (c: string[]) => string[]) => void;
  jobs: Record<string, string>;
  totalDone: number;
  choose: (id: string) => void;
  cancel: (id: string) => void;
  retryUpload: (id: string) => void;
  discardUpload: (id: string) => void;
  unreadable: UnreadableWorkspace[];
  openHistory: () => void;
}) {
  return (
    <div className="oi-file-list">
      <header>
        <label>
          <input
            type="checkbox"
            aria-label="全选文件"
            checked={!!files.length && files.every((f) => checked.includes(f.id))}
            onChange={(e) => setChecked(() => (e.target.checked ? files.map((f) => f.id) : []))}
          />
          <strong>文件 {files.length + uploads.length}</strong>
        </label>
        <small>已识别 {totalDone}</small>
      </header>
      {uploads.map((f) => (
        <div className="oi-file-row pending" key={f.id}>
          <FileText size={16} />
          <div>
            <b title={f.file.name}>{f.file.name}</b>
            <small>
              {f.state === 'queued' ? '排队上传' : f.state === 'uploading' ? '正在上传' : f.error}
            </small>
          </div>
          {f.state === 'failed' && (
            <>
              <button onClick={() => retryUpload(f.id)} aria-label={'重试上传 ' + f.file.name}>
                <RefreshCw size={14} />
              </button>
              <button onClick={() => discardUpload(f.id)} aria-label={'移除失败上传 ' + f.file.name}>
                <X size={14} />
              </button>
            </>
          )}
        </div>
      ))}
      {unreadable.length > 0 && (
        <div className="oi-file-row pending">
          <FileText size={16} />
          <button className="oi-file-select" onClick={openHistory}>
            <b>{unreadable.length} 份文件读不出来</b>
            <small className="oi-bad">打不开；在“更多 → 历史与归档”里查看</small>
          </button>
        </div>
      )}
      {files.map((f) => (
        <div key={f.id} className={'oi-file-row ' + (selected === f.id ? 'active' : '')}>
          <input
            type="checkbox"
            aria-label={'选择文件 ' + f.fileName}
            checked={checked.includes(f.id)}
            onChange={(e) =>
              setChecked((c) => (e.target.checked ? [...c, f.id] : c.filter((x) => x !== f.id)))
            }
          />
          <button className="oi-file-select" onClick={() => choose(f.id)}>
            <b title={f.fileName}>{f.fileName}</b>
            <small data-mode={fileMode(f)} className={fileFailed(f) ? 'oi-bad' : ''}>
              {fileStatus(f, jobs[f.id])}
            </small>
          </button>
          {fileMode(f) === 'order' && (jobs[f.id] || taskRunning(f)) && (
            <button
              aria-label={'取消识别 ' + f.fileName}
              title="取消识别"
              onClick={() => cancel(f.id)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
