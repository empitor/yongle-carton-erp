import { useState, useEffect } from 'react';
import { Download, ZoomIn, ZoomOut, Maximize2, FileText } from 'lucide-react';
import type { ImportWorkspaceView as Workspace } from '../../shared/import/index';
import { KIB } from '../../shared/core/index';
import { workspaceFileUrl } from './workspace-api';
/** 原件预览：图片直接显示（可缩放），别的格式给下载。 */
export default function FilePreview({ workspace }: { workspace?: Workspace }) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => setZoom(1), [workspace?.id]);
  if (!workspace)
    return (
      <div className="oi-empty">
        <span>选中文件后，在这里看原件。</span>
      </div>
    );
  const image = ['jpg', 'png'].includes(workspace.parsed.format),
    url = workspaceFileUrl(workspace.id);
  return (
    <section className="oi-preview">
      <header>
        <strong>原始文件</strong>
        <a href={url} download title="下载原文件">
          <Download size={15} />
        </a>
      </header>
      <div className="oi-preview-tools">
        <span title={workspace.fileName}>{workspace.fileName}</span>
        {image && (
          <>
            <button aria-label="缩小原图" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
              <ZoomOut size={15} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button aria-label="放大原图" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
              <ZoomIn size={15} />
            </button>
            <button aria-label="完整显示原图" onClick={() => setZoom(1)}>
              <Maximize2 size={15} />
            </button>
          </>
        )}
      </div>
      <div className="oi-preview-content">
        {image ? (
          <div className="oi-image-canvas">
            <img
              alt={workspace.fileName + ' 原图'}
              src={url + '?view=image'}
              style={{
                width: zoom === 1 ? '100%' : zoom * 100 + '%',
                maxHeight: zoom === 1 ? '100%' : 'none',
                objectFit: 'contain',
              }}
            />
          </div>
        ) : (
          <div className="oi-empty">
            <FileText size={30} />
            <p>{workspace.parsed.format.toUpperCase()} 原件已保存</p>
            <span>
              {(workspace.size / KIB).toFixed(1)} KB · 这类文件不能在这里预览，下载后对照核对
            </span>
            <a href={url} download>
              下载原件
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
