import type { ComponentProps, ReactNode } from 'react';
import { Download } from 'lucide-react';
import type { PageHeading } from '../ui/index';
import { exportHref } from './fin-api';

/* 财务各页的骨架：月份框、页签填页头的约定、分节、导出链接（出错提示用 src/ui 的 FormMessage）。月份和页签记在哪见 page-state.ts。 */

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
/** 页头就是 src/ui 的 PageHeading（标题、条件、“更多”、次要、主按钮），页签只填标题以外的部分。 */
export type HeadProps = Omit<ComponentProps<typeof PageHeading>, 'title'>;
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
