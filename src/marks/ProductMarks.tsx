import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { managementRequest, useAuthState } from '../session';
import ManagementDialog from '../ManagementDialog';
import MarkPreview from './MarkPreview';

const fileUrl = (mark: any) => '/api/marks/' + mark.id + '/file';
const basisName: Record<string, string> = { inner: '内径', outer: '外箱' };
export function markSummary(mark: any) {
  const f = mark.fields || {};
  const size = [f.cartonLength, f.cartonWidth, f.cartonHeight].filter(Boolean);
  return [
    size.length === 3
      ? (basisName[f.dimensionBasis] ? basisName[f.dimensionBasis] + ' ' : '') +
        size.join('×') +
        (f.dimensionUnit ? ' ' + f.dimensionUnit : '')
      : '',
    f.quantityPerCarton,
    f.requirements,
  ]
    .filter(Boolean)
    .join(' · ');
}
export const markTitle = (mark: any) =>
  mark.title || mark.fields?.itemCode || mark.fields?.productName || mark.fileName || '唛头';

/** 唛头卡片：产品档案里可管理，订单和生产任务里只看。 */
export function MarkCards({
  marks,
  remove,
}: {
  marks: any[];
  remove?: (mark: any) => void;
}) {
  const [open, setOpen] = useState<any>(null);
  return (
    <>
      <div className="mark-grid">
        {marks.map((mark) => (
          <article className="mark-card" key={mark.id}>
            <button
              className="mark-thumb"
              aria-label={'查看唛头 ' + markTitle(mark)}
              onClick={() => setOpen(mark)}
            >
              <MarkPreview url={fileUrl(mark)} page={mark.page} alt={markTitle(mark)} />
            </button>
            <button
              className="text-link mark-file-link"
              title={mark.fileName || markTitle(mark)}
              onClick={() => setOpen(mark)}
            >
              {mark.fileName || markTitle(mark)}
            </button>
            {remove && (
              <button className="text-link danger-text" onClick={() => remove(mark)}>
                移除
              </button>
            )}
          </article>
        ))}
      </div>
      {open && (
        <ManagementDialog title={open.fileName || markTitle(open)} close={() => setOpen(null)}>
          <MarkPreview url={fileUrl(open)} page={open.page} alt={markTitle(open)} pager />
          <div className="mark-dialog-actions">
            <a className="button" href={fileUrl(open)} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
            <a className="button" href={fileUrl(open)} download>
              下载原件
            </a>
            <button onClick={() => setOpen(null)}>关闭</button>
          </div>
        </ManagementDialog>
      )}
    </>
  );
}

/** 产品档案里的唛头区：唛头只是资料，不产生订单、生产或库存。 */
export default function ProductMarks({
  productId,
  readOnly = false,
}: {
  productId: number;
  readOnly?: boolean;
}) {
  const auth = useAuthState(),
    canEdit =
      !readOnly &&
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const [marks, setMarks] = useState<any[] | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    managementRequest<any[]>('/products/' + productId + '/marks')
      .then((rows) => live && setMarks(rows))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [productId, revision]);
  const upload = async (files: File[]) => {
    setError('');
    try {
      const { csrf } = await fetch('/api/auth/state').then((r) => r.json());
      for (const file of files) {
        const r = await fetch(
          '/api/products/' + productId + '/marks/upload?name=' + encodeURIComponent(file.name),
          {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-ERP-Auth-Token': csrf,
            },
            body: file,
          },
        );
        if (!r.ok) throw new Error((await r.json()).message || file.name + ' 上传失败');
      }
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (mark: any) => {
    if (!window.confirm('从这个产品移除唛头“' + markTitle(mark) + '”？')) return;
    try {
      await managementRequest('/marks/' + mark.id, { expectedVersion: mark.version }, 'DELETE');
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (readOnly && !marks?.length) return null;
  return (
    <section className="product-marks" aria-label="产品唛头">
      <header>
        <h3>唛头 {marks ? marks.length : ''}</h3>
        {canEdit && (
          <>
            <button onClick={() => input.current?.click()}>
              <Upload size={14} />
              上传
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              aria-label="上传唛头文件"
              onChange={(e) => {
                void upload(Array.from(e.target.files || []));
                e.target.value = '';
              }}
            />
          </>
        )}
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {marks && !marks.length && (
        <p className="help-text">还没有唛头。可以上传，也可以把整份文件拖进“AI 导入”批量对应。</p>
      )}
      {!!marks?.length && <MarkCards marks={marks} remove={canEdit ? remove : undefined} />}
    </section>
  );
}
