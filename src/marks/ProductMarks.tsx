import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { canEditBusiness, useAuthState, useLoad } from '../ui/index';
import { listMarks, markFileUrl as fileUrl, removeMark, renameMark, uploadMarks, type ProductMark } from './mark-api';
import { errorMessage } from '../../shared/core/index';
import { ManagementDialog, EditorFooter, useConfirm } from '../ui/index';
import MarkPreview from './MarkPreview';

/**
 * 产品的唛头：像产品的备注一样，打开产品就看得到唛头的样子。
 * 只做三件事：看（图片和 PDF 第一页的缩略图，点开看原件）、传（可以给每份写一句说明）、删。
 * 唛头不识别，不产生订单、生产或库存。
 */
const markTitle = (mark: ProductMark) => mark.title || mark.fileName || '唛头';

/** 一份唛头的卡片：缩略图、说明；能改的可以编辑说明、删掉 */
function MarkCard({
  mark,
  open,
  rename,
  remove,
}: {
  mark: ProductMark;
  open: () => void;
  rename?: (title: string) => Promise<boolean>;
  remove?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <article className="mark-card">
      <button className="mark-thumb" aria-label={'查看唛头 ' + markTitle(mark)} onClick={open}>
        <MarkPreview url={fileUrl(mark)} page={mark.page || 1} alt={markTitle(mark)} />
      </button>
      {editing !== null ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (rename && (await rename(editing.trim()))) setEditing(null);
          }}
        >
          <input
            aria-label={'唛头说明 ' + (mark.fileName || '')}
            value={editing}
            maxLength={200}
            autoFocus
            placeholder="写一句说明，比如“外箱正唛”"
            onChange={(e) => setEditing(e.target.value)}
          />
          <button type="submit" className="text-link">
            保存
          </button>
          <button type="button" className="text-link" onClick={() => setEditing(null)}>
            取消
          </button>
        </form>
      ) : (
        <>
          <strong title={markTitle(mark)}>{markTitle(mark)}</strong>
          {mark.title && <small title={mark.fileName}>{mark.fileName}</small>}
        </>
      )}
      {editing === null && (rename || remove) && (
        <span>
          {rename && (
            <button className="text-link" onClick={() => setEditing(mark.title || '')}>
              {mark.title ? '编辑说明' : '写说明'}
            </button>
          )}
          {remove && (
            <button className="text-link danger-text" onClick={remove}>
              删除
            </button>
          )}
        </span>
      )}
    </article>
  );
}

/** 唛头卡片：产品档案里可以编辑说明、删除，订单和生产任务里只看。点缩略图放大看原件。 */
export function MarkCards({
  marks,
  rename,
  remove,
}: {
  marks: ProductMark[];
  rename?: (mark: ProductMark, title: string) => Promise<boolean>;
  remove?: (mark: ProductMark) => void;
}) {
  const [open, setOpen] = useState<ProductMark | null>(null);
  return (
    <>
      <div className="mark-grid">
        {marks.map((mark) => (
          <MarkCard
            key={mark.id}
            mark={mark}
            open={() => setOpen(mark)}
            rename={rename && ((title) => rename(mark, title))}
            remove={remove && (() => remove(mark))}
          />
        ))}
      </div>
      {open && (
        <ManagementDialog
          title={markTitle(open)}
          subtitle={open.title ? open.fileName : undefined}
          size="lg"
          close={() => setOpen(null)}
          footer={
            <EditorFooter>
              <a className="button-link secondary sales-footer-link" href={fileUrl(open)} target="_blank" rel="noreferrer">
                新窗口打开
              </a>
              <a className="button-link secondary sales-footer-link" href={fileUrl(open)} download>
                下载原件
              </a>
              <button type="button" className="secondary" onClick={() => setOpen(null)}>
                关闭
              </button>
            </EditorFooter>
          }
        >
          <MarkPreview url={fileUrl(open)} page={open.page || 1} alt={markTitle(open)} pager />
        </ManagementDialog>
      )}
    </>
  );
}

/** 换了一个产品：上一个产品的唛头不再显示 */
const shownMarks = (list: { loading: boolean; data: ProductMark[] | null }) => (list.loading ? null : list.data);

/** 唛头的上传、编辑说明、删除：办成了重读列表，没办成的原因放在 error 里 */
function useMarkActions(productId: number, list: { error: string; reload: () => void }) {
  const [error, setError] = useState('');
  const [confirmDialog, confirm] = useConfirm();
  const attempt = async (job: () => Promise<unknown>) => {
    setError('');
    try {
      await job();
      list.reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const remove = async (mark: ProductMark) => {
    const ok = await confirm({
      title: '删除唛头',
      message: '从这个产品删掉唛头“' + markTitle(mark) + '”。不影响订单、生产和库存。',
      confirmLabel: '删除唛头',
      danger: true,
    });
    if (ok) await attempt(() => removeMark(mark));
  };
  return {
    error: error || list.error,
    confirmDialog,
    upload: (files: File[]) => attempt(() => uploadMarks(productId, files)),
    rename: (mark: ProductMark, title: string) => attempt(() => renameMark(mark, title)),
    remove,
  };
}

/** 产品详情里的唛头区。readOnly（订单、生产任务里）只看，没有唛头就不显示。 */
export default function ProductMarks({ productId, readOnly = false }: { productId: number; readOnly?: boolean }) {
  const auth = useAuthState(),
    canEdit = !readOnly && canEditBusiness(auth);
  const list = useLoad(String(productId), () => listMarks(productId)),
    marks = shownMarks(list),
    input = useRef<HTMLInputElement>(null);
  const { upload, rename, remove, confirmDialog, error } = useMarkActions(productId, list);
  if (readOnly && !marks?.length) return null;
  const pick = () => input.current?.click();
  return (
    <section className="product-marks" aria-label="产品唛头">
      <header>
        <h3>唛头{marks?.length ? ' ' + marks.length : ''}</h3>
        {canEdit && !!marks?.length && (
          <button type="button" className="secondary" onClick={pick}>
            <Upload size={14} aria-hidden="true" />
            上传唛头
          </button>
        )}
        {canEdit && (
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
        )}
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {marks && !marks.length && (
        <p className="sales-muted">
          还没有唛头。
          {canEdit && (
            <button type="button" className="text-link" onClick={pick}>
              上传唛头
            </button>
          )}
        </p>
      )}
      {!!marks?.length && (
        <MarkCards marks={marks} rename={canEdit ? rename : undefined} remove={canEdit ? remove : undefined} />
      )}
      {confirmDialog}
    </section>
  );
}
