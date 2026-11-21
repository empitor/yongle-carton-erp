import type { ReactNode } from 'react';

/**
 * 详情面板和编辑窗共用的展示件。所有单据、档案的“点进去以后”的界面都用这一套，
 * 版式统一：顶部类型 + 编号 + 状态，一行操作（ActionBar，在 Actions.tsx），下面分节显示。
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

/** 状态标签：颜色只表达状态，不表达品牌。 */
export function StatusChip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={'status-chip tone-' + tone}>{children}</span>;
}

export type Fact = {
  label: string;
  value: ReactNode;
  /** 占满一行，例如备注、地址 */
  wide?: boolean;
  hidden?: boolean;
};

/** 基本信息：两列，标签在上、内容在下，标签不会被挤成两行。空值显示“—”。 */
export function Facts({ items }: { items: Fact[] }) {
  const shown = items.filter((f) => !f.hidden);
  if (!shown.length) return null;
  return (
    <dl className="record-facts">
      {shown.map((f) => (
        <div key={f.label} className={f.wide ? 'wide' : undefined}>
          <dt>{f.label}</dt>
          <dd>{f.value === null || f.value === undefined || f.value === '' ? '—' : f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 详情里的一节：小标题 + 内容，右侧可放一个次要操作。 */
export function Section({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="record-section">
      <header>
        <h3>{title}</h3>
        {extra}
      </header>
      {children}
    </section>
  );
}

/**
 * 完成进度：一条细进度条加数字，例如“完工 500 / 1000 只”。
 * text 给了就代替“done / total unit”那几个字，例如金额写成“1,000.00 / 1,500.00 元”。
 */
export function Progress({
  label,
  done,
  total,
  unit,
  text,
}: {
  label: string;
  done: string | number;
  total: string | number;
  unit?: string;
  text?: ReactNode;
}) {
  const d = Number(done) || 0,
    t = Number(total) || 0,
    pct = t > 0 ? Math.max(0, Math.min(100, Math.floor((d * 100) / t))) : 0;
  return (
    <div className="record-progress" role="group" aria-label={label}>
      <div className="record-progress-text">
        <span>{label}</span>
        <strong>
          {text ?? (
            <>
              {done} / {total} {unit}
            </>
          )}
        </strong>
      </div>
      <div className="record-progress-bar" aria-hidden="true">
        <span style={{ width: pct + '%' }} />
      </div>
    </div>
  );
}

/** 一句提示：说明为什么、下一步做什么。tone 决定颜色。 */
export function Hint({
  tone = 'info',
  role,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  /** 需要读屏立即读出时传 alert 或 status */
  role?: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <p className={'record-hint tone-' + tone} role={role}>
      {children}
    </p>
  );
}
