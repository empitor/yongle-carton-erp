import type { ReactNode } from 'react';
import { MoreMenu } from '../ui/index';
import { StatusChip } from '../ui/index';
import type { FileItem } from './fileStatus';
import { recognitionModes } from '../../shared/import/index';
import { fileChip, modeLabels, type FileMode } from './fileStatus';

/**
 * 右侧草稿的头部：识别类型、文件名、状态，右边一个主操作、“原件”开关和“更多”。
 * 两种识别类型（客户订单、到货单）都用这一个头部。
 */
export default function DocHead({
  file,
  fileName,
  mode,
  job,
  modeLocked,
  switchMode,
  primary,
  showPreview,
  togglePreview,
  revision,
  children,
}: {
  file: FileItem;
  fileName: string;
  mode: FileMode;
  job?: string;
  modeLocked: boolean;
  switchMode: (mode: FileMode) => void;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  showPreview: boolean;
  togglePreview: () => void;
  revision?: number;
  /** “更多”菜单里的项目：低频动作在上，删除这类红色危险项放最下面、前面加分隔线 */
  children?: ReactNode;
}) {
  const chip = fileChip(file, job);
  return (
    <div className="aii-head">
      <div className="aii-kind" role="group" aria-label="单据类型">
        {recognitionModes.map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? 'is-on' : ''}
            aria-pressed={mode === m}
            aria-label={'识别类型 ' + modeLabels[m] + ' ' + fileName}
            disabled={modeLocked}
            onClick={() => switchMode(m)}
          >
            {modeLabels[m]}
          </button>
        ))}
      </div>
      <div className="aii-head-title">
        <strong title={fileName}>{fileName}</strong>
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
      </div>
      <div className="aii-head-actions">
        {primary && (
          <button type="button" className="primary" disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </button>
        )}
        <button
          type="button"
          className={'secondary' + (showPreview ? ' is-on' : '')}
          aria-pressed={showPreview}
          title={showPreview ? '收起原件预览' : '显示原件预览'}
          onClick={togglePreview}
        >
          原件
        </button>
        <MoreMenu text="更多" label="当前文件更多操作">
          {revision !== undefined && <small className="aii-menu-note">第 {revision} 次修改</small>}
          {children}
        </MoreMenu>
      </div>
    </div>
  );
}
