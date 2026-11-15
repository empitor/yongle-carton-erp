import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { MoreMenu } from '../ui/index';
import type { AiProgress } from '../../shared/ai/index';

/**
 * 识别结果底栏，三种类型同一个写法：左边合计和疑点；右边从次到主
 * “让 AI 改” · “撤回修改” · “保存”（有没保存的修改时）· 主按钮（导入订单 / 核对入库 / 挂到产品下），
 * 少用的收进“更多”。
 */
export function DraftFooter({
  summary,
  more,
  moreLabel = '更多操作',
  children,
}: {
  summary: ReactNode;
  more?: ReactNode;
  moreLabel?: string;
  children?: ReactNode;
}) {
  return (
    <footer className="aii-footer">
      <div className="aii-footer-summary">{summary}</div>
      <div className="aii-footer-actions">
        {more && (
          <MoreMenu text="更多" label={moreLabel}>
            {more}
          </MoreMenu>
        )}
        {children}
      </div>
    </footer>
  );
}

/** 底部的一个合计数字：小字标签 + 数字。 */
export function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="aii-figure">
      <small>{label}</small>
      <strong>{children}</strong>
    </span>
  );
}

/** 还没有识别结果时的占位：一句话说明下一步。 */
export function DraftEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="aii-empty">
      <p>{title}</p>
      {children && <span>{children}</span>}
    </div>
  );
}

export function DraftText({
  label,
  field,
  locked,
  change,
}: {
  label: string;
  field: { value: string | null; note?: string };
  locked: boolean;
  change: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = 0;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 2 + 'px';
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [field.value]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      title={field.note || ''}
      rows={1}
      maxLength={2000}
      disabled={locked}
      value={field.value || ''}
      placeholder="待确认"
      onChange={(e) => change(e.target.value)}
    />
  );
}

/** 识别进行中：到了哪一步、已等几秒。 */
export function RecognizeProgress({ progress }: { progress?: AiProgress }) {
  return (
    <div className="aii-progress" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={14} />
      <span>
        {progress?.stage === 'validating'
          ? '正在检查识别结果'
          : progress?.stage === 'receiving'
            ? 'AI 正在填写'
            : '等 AI 读文件'}
        {' · 已等 '}
        {Math.floor((progress?.elapsedMs || 0) / 1000)} 秒
      </span>
      <small>识别完整后才会保存</small>
    </div>
  );
}

/** 识别结果区顶部的一句提示或错误。 */
export function DraftNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p
      className={'record-hint ' + (error ? 'tone-danger' : 'tone-warning')}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </p>
  );
}
