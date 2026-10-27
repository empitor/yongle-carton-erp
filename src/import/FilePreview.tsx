import { useState, useEffect } from 'react';
import { Download, ZoomIn, ZoomOut, Maximize2, FileText } from 'lucide-react';
import type { ImportWorkspaceView as Workspace } from '../../shared/order-draft';
export default function FilePreview({
  workspace,
  compatible = false,
}: {
  workspace?: Workspace;
  compatible?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => setZoom(1), [workspace?.id]);
  if (!workspace)
    return (
      <div className="oi-empty">
        <p>上传原始订单文件</p>
        <span>
          支持Excel、Word、PDF及图片
          <br />
          上传先保留原件，识别方式以当前服务能力与外发确认说明为准
        </span>
      </div>
    );
  const image = ['jpg', 'png'].includes(workspace.parsed.format),
    url = '/api/ai/imports/' + workspace.id + '/file';
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
            <p>{workspace.parsed.format.toUpperCase()}原件已保存</p>
            <span>
              {(workspace.size / 1024).toFixed(1)} KB · 字节保持不变
              <br />
              {compatible
                ? 'DeepSeek：提取文字，扫描PDF转图后发送'
                : '不做本地文字提取、解压或解析预览'}
              <br />
              {compatible
                ? '原件保留；内嵌图片和复杂排版需人工核对'
                : '识别时通过Responses直接发送原件'}
            </span>
            <a href={url} download>
              下载原件核对
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
