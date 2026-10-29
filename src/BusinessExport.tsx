import { useEffect, useRef, useState } from 'react';
import { managementRequest, useAuthState } from './session';
import ManagementDialog from './ManagementDialog';
import BusinessFormPreview from './BusinessFormPreview';
const businessLabel = (status: string) =>
  ({ confirmed: '已确认送货', draft: '计划待送货', cancelled: '已取消', reversed: '已冲销' })[
    status as 'confirmed'
  ] || status;
export async function deliverBusinessFile(file: any) {
  if (!/^\/api\/documents\/[a-f0-9-]+\/file$/.test(file.url)) throw new Error('下载地址无效。');
  const response = await fetch(file.url, { cache: 'no-store' });
  if (!response.ok) throw new Error((await response.json()).message || '文件下载失败。');
  const bytes = await response.arrayBuffer(),
    hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  if (hash !== file.sha256) throw new Error('文件校验失败，未修改业务状态。');
  const url = URL.createObjectURL(
      new Blob([bytes], { type: response.headers.get('Content-Type') || '' }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const result = await managementRequest<any>('/documents/' + file.exportId + '/complete', {
    sha256: hash,
  });
  window.dispatchEvent(new Event('erp-business-changed'));
  return result;
}
export function ExportFileCard({ file }: { file: any }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  return (
    <div className="export-file-card">
      <strong>{file.filename}</strong>
      <span>{file.markOrdered ? '完整下载后标记已订货' : '重复下载不改变库存及实物状态'}</span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await deliverBusinessFile(file);
            setMessage('文件已交付 · ' + businessLabel(r.businessStatus));
          } catch (e) {
            setMessage((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '正在交付…' : '下载文件'}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
export type BusinessExportProps = {
  kind: 'purchase' | 'delivery';
  id: number;
  version: number;
  status?: string;
};
export function BusinessDocumentButton(props: BusinessExportProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>
        {props.kind === 'purchase' ? '订货单 / 导出' : '送货单 / 导出'}
      </button>
      {open && (
        <ManagementDialog
          title={(props.kind === 'purchase' ? '采购订货单' : '送货单') + ' · 预览与导出'}
          close={() => setOpen(false)}
        >
          <BusinessExport {...props} />
        </ManagementDialog>
      )}
    </>
  );
}
export function WordFilePreview({ file }: { file: any }) {
  const target = useRef<HTMLDivElement>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const element = target.current!;
    (async () => {
      try {
        let bytes: ArrayBuffer = file.bytes;
        if (!bytes) {
          const response = await fetch(file.url, { cache: 'no-store' });
          if (!response.ok) throw new Error('无法读取Word预览文件。');
          bytes = await response.arrayBuffer();
        }
        const { renderAsync } = await import('docx-preview');
        if (active)
          await renderAsync(bytes, element, undefined, {
            className: 'erp-word',
            inWrapper: true,
            renderAltChunks: false,
            ignoreLastRenderedPageBreak: false,
          });
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [file.exportId]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <p className="help-text">
        这是服务端生成的Word文件排版。浏览器不模拟Word自动分页，最终打印分页以办公软件为准。
      </p>
      <div className="word-file-preview" ref={target} />
    </>
  );
}
export default function BusinessExport({ kind, id, version, status }: BusinessExportProps) {
  const auth = useAuthState(),
    [format, setFormat] = useState<'docx' | 'xlsx'>('docx'),
    [form, setForm] = useState<any>(null),
    [templates, setTemplates] = useState<any[]>([]),
    [templateId, setTemplateId] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [file, setFile] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const canEdit =
    !!auth?.actor &&
    (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  useEffect(() => {
    if (!auth?.actor) return;
    let active = true;
    Promise.all([
      managementRequest<any>(
        '/documents/preview/' +
          kind +
          '/' +
          id +
          (templateId ? '?templateId=' + encodeURIComponent(templateId) : ''),
      ),
      managementRequest<any>('/documents/templates'),
    ])
      .then(([f, settings]) => {
        if (active) {
          setForm(f);
          setFormat(f.defaultFormat || 'docx');
          setTemplates(settings.templates.filter((t: any) => t.kind === kind));
          const params = new URLSearchParams(location.hash.split('?')[1] || '');
          if (kind === 'purchase' && params.get('previewDocument') === '1') {
            setPreview({ form: f, format: 'xlsx' });
            params.delete('previewDocument');
            history.replaceState(null, '', '#purchases?' + params);
          }
        }
      })
      .catch((e) => active && setMessage(e.message));
    return () => {
      active = false;
    };
  }, [kind, id, version, auth?.actor?.id, templateId]);
  const work = async (job: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await job();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const generate = (f: 'docx' | 'xlsx', markOrdered = false) =>
    managementRequest<any>('/documents', {
      kind,
      id,
      format: f,
      markOrdered,
      templateId: form?.templateId,
      expectedVersion: version,
      requestId: crypto.randomUUID(),
    });
  const download = (f: 'docx' | 'xlsx', mark = false) =>
    void work(async () => {
      const generated = await generate(f, mark);
      setFile(generated);
      const r = await deliverBusinessFile(generated);
      setMessage('文件已交付 · ' + businessLabel(r.businessStatus));
    });
  const inactive = kind === 'delivery' && ['cancelled', 'reversed'].includes(status || '');
  return (
    <section
      className="business-document-workbench"
      aria-label={kind === 'purchase' ? '采购订货单操作' : '送货单操作'}
    >
      <div className="document-workbench-heading">
        <div>
          <h3>{kind === 'purchase' ? '采购订货单' : '送货单'}</h3>
          <p>
            {kind === 'purchase'
              ? '普通导出只生成文件；正式订货使用下方独立操作。'
              : status === 'confirmed'
                ? '按照本批实际送货数量导出，重复下载不再次发货。'
                : '当前为计划单，导出显著标注非正式，不作为实际出库凭证。'}
          </p>
        </div>
        <a href="#ai-settings?tab=templates">单据模板设置</a>
      </div>
      {templates.length > 0 && (
        <label className="document-template-select">
          使用模板
          <select
            aria-label="单据导出模板"
            disabled={busy}
            value={templateId || form?.templateId || ''}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setForm(null);
            }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="business-export-actions">
        <button
          disabled={busy || !canEdit}
          onClick={() =>
            void work(async () => {
              const current = await managementRequest<any>(
                '/documents/preview/' +
                  kind +
                  '/' +
                  id +
                  (templateId ? '?templateId=' + encodeURIComponent(templateId) : ''),
              );
              setForm(current);
              setPreview({ form: current, format: 'xlsx' });
            })
          }
        >
          {kind === 'purchase' ? '预览采购订货单' : '预览送货单'}
        </button>
        <button disabled={busy || !canEdit || !form || inactive} onClick={() => download('docx')}>
          导出Word
        </button>
        <button disabled={busy || !canEdit || !form || inactive} onClick={() => download('xlsx')}>
          导出Excel
        </button>
        <button
          disabled={busy || !canEdit || !form || inactive}
          onClick={() =>
            void work(async () =>
              setPreview({ form, file: await generate('docx'), format: 'docx' }),
            )
          }
        >
          预览Word排版
        </button>
      </div>
      {kind === 'purchase' && (
        <div className="formal-order-export">
          <label>
            正式订货文件格式
            <select
              aria-label="正式订货文件格式"
              value={format}
              onChange={(e) => setFormat(e.target.value as any)}
            >
              <option value="docx">Word (.docx)</option>
              <option value="xlsx">Excel (.xlsx)</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={busy || !canEdit || !form || inactive || status === '已取消'}
            onClick={() => download(format, true)}
          >
            导出并标记已订货
          </button>
          <span>文件完整交付后更新状态，预览和普通导出不改变状态。</span>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {file && <ExportFileCard file={file} />}
      {preview && (
        <ManagementDialog
          title={
            (preview.form?.title || '单据') + '预览' + (preview.form?.draft ? ' · 计划非正式' : '')
          }
          busy={busy}
          close={() => setPreview(null)}
        >
          {preview.file ? (
            <WordFilePreview file={preview.file} />
          ) : (
            <BusinessFormPreview form={preview.form} />
          )}
        </ManagementDialog>
      )}
    </section>
  );
}
