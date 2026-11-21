import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import { MoreMenu, PageHeading } from '../ui/index';
import { exportHref } from './fin-api';

/* 财务各页的骨架：月份框、页头、分节、导出链接（出错提示用 src/ui 的 FormMessage）。月份和页签记在哪见 page-state.ts。 */

export function PeriodInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="fin-period">
      <span>月份</span>
      <input type="month" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
/** 页签下面那一排：左边页内切换，右边固定位置放应收 / 应付这类全页共用的切换。 */
export function SubBar({ children, side }: { children?: ReactNode; side?: ReactNode }) {
  return (
    <div className="fin-subbar">
      {children}
      {side && <div className="fin-subbar-side">{side}</div>}
    </div>
  );
}
export type HeadAction = {
  label: ReactNode;
  onClick?: () => void;
  href?: string;
  /** 导出类链接：浏览器直接下载 */
  download?: boolean;
  disabled?: boolean;
  danger?: boolean;
  hidden?: boolean;
  title?: string;
};
const headButton = (a: HeadAction, className: string) =>
  a.href ? (
    <a
      className={'button ' + className}
      href={a.href}
      title={a.title}
      {...(a.download ? { download: '' } : {})}
    >
      {a.label}
    </a>
  ) : (
    <button
      type="button"
      className={className}
      disabled={a.disabled}
      title={a.title}
      onClick={a.onClick}
    >
      {a.label}
    </button>
  );
/**
 * 财务各页的页头：标题、月份这类条件，右边从左到右是“更多”、一个次要、一个主按钮（当前该做的下一步）。
 * 没有下一步就不放主按钮；导出、低频动作进“更多”，危险项在“更多”最下面、红色。
 */
export function FinHead({
  title,
  meta,
  children,
  primary,
  secondary,
  more = [],
}: {
  title: string;
  meta?: ReactNode;
  /** 月份、日期这类条件，放在按钮左边 */
  children?: ReactNode;
  primary?: HeadAction | null | false;
  secondary?: HeadAction | null | false;
  more?: (HeadAction | null | false | undefined)[];
}) {
  const items = more.filter((a): a is HeadAction => !!a && !a.hidden);
  const normal = items.filter((a) => !a.danger),
    danger = items.filter((a) => a.danger);
  const menuItem = (a: HeadAction, i: number) =>
    a.href ? (
      <a
        key={i}
        role="menuitem"
        className={a.danger ? 'danger-text' : ''}
        href={a.href}
        {...(a.download ? { download: '' } : {})}
      >
        {a.label}
      </a>
    ) : (
      <button
        key={i}
        type="button"
        role="menuitem"
        className={a.danger ? 'danger-text' : ''}
        disabled={a.disabled}
        title={a.title}
        onClick={a.onClick}
      >
        {a.label}
      </button>
    );
  const p = primary && !primary.hidden ? primary : null,
    s = secondary && !secondary.hidden ? secondary : null;
  return (
    <PageHeading
      title={title}
      meta={meta}
      actions={
        children || p || s || items.length ? (
          <>
            {children}
            {items.length > 0 && (
              <MoreMenu text="更多">
                {normal.map(menuItem)}
                {normal.length > 0 && danger.length > 0 && <hr className="more-menu-sep" />}
                {danger.map((a, i) => menuItem(a, i + normal.length))}
              </MoreMenu>
            )}
            {s && headButton(s, 'secondary')}
            {p && headButton(p, 'primary')}
          </>
        ) : undefined
      }
    />
  );
}
export type HeadProps = Omit<Parameters<typeof FinHead>[0], 'title'>;
/** 有页内切换的页面把页头交给当前页签来填：页签知道自己的主按钮是什么。 */
export type HeadFn = (props: HeadProps) => ReactNode;
/** 页面里的一节：白色卡片、小标题，右边可放一个这节自己的操作；collapsed 时默认收起。 */
export function FinSection({
  id,
  title,
  note,
  extra,
  collapsed,
  children,
}: {
  /** 这一节的名字：地址写 tab=<名字> 时滚到这一节 */
  id?: string;
  title: string;
  note?: ReactNode;
  extra?: ReactNode;
  /** 不常看的一节默认收起，点标题展开 */
  collapsed?: boolean;
  children: ReactNode;
}) {
  const head = (
    <>
      <h2>{title}</h2>
      {note && <span className="fin-section-note">{note}</span>}
    </>
  );
  if (collapsed !== undefined)
    return (
      <details className="panel fin-section fin-fold" id={id && 'fin-sec-' + id} open={!collapsed}>
        <summary className="fin-section-head">{head}</summary>
        {extra && <div className="fin-section-extra">{extra}</div>}
        {children}
      </details>
    );
  return (
    <section className="panel fin-section" id={id && 'fin-sec-' + id}>
      <header className="fin-section-head">
        {head}
        {extra && <div className="fin-section-extra">{extra}</div>}
      </header>
      {children}
    </section>
  );
}

export function ExportLink({
  path,
  query,
  label = '导出',
}: {
  path: string;
  query?: Record<string, unknown>;
  label?: string;
}) {
  return (
    <a className="button secondary fin-export" href={exportHref(path, query)} download>
      <Download size={14} aria-hidden="true" />
      {label}
    </a>
  );
}
