import type { ReactNode } from 'react';
import MoreMenu from './MoreMenu';

/**
 * 详情面板和编辑窗共用的展示件。所有单据、档案的“点进去以后”的界面都用这一套，
 * 版式统一：顶部类型 + 编号 + 状态，一行操作（最多两个主操作，其余进“更多”），下面分节显示。
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

/** 状态标签：颜色只表达状态，不表达品牌。 */
export function StatusChip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={'status-chip tone-' + tone}>{children}</span>;
}

export type RecordAction = {
  label: ReactNode;
  onClick?: () => void;
  href?: string;
  /** 新窗口打开，例如打印 */
  external?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  icon?: ReactNode;
  hidden?: boolean;
  /** 和主按钮并列、同样高亮。只用于产品的“新建订单”（和“安排生产”并列，界面规范里登记的唯一例外） */
  emphasis?: boolean;
};

function ActionButton({ a, primary }: { a: RecordAction; primary?: boolean }) {
  const className = primary || a.emphasis ? 'primary' : a.danger ? 'danger-text' : 'secondary';
  if (a.href)
    return (
      <a
        className={'button-link ' + className}
        href={a.href}
        title={a.title}
        {...(a.external ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {a.icon}
        {a.label}
      </a>
    );
  return (
    <button type="button" className={className} disabled={a.disabled} title={a.title} onClick={a.onClick}>
      {a.icon}
      {a.label}
    </button>
  );
}

const devWarn = (message: string) => {
  if (import.meta.env?.DEV) console.warn('[ActionBar] ' + message);
};

/**
 * 一行操作，全站一套规则（docs/界面规范.md）：
 * - 主操作只有一个，就是当前状态的下一步，放最左；多传的主操作降为次要。
 * - 次要最多两个，多出来的进“更多”。
 * - 危险操作（取消、撤销、删除）只在“更多”最下面，分隔线隔开、红色；传到主、次里的也会被挪进去。
 */
export function ActionBar({
  primary = [],
  secondary = [],
  more = [],
  extra,
}: {
  primary?: RecordAction[];
  secondary?: RecordAction[];
  more?: RecordAction[];
  /** 自带下拉的现成组件（例如导出）放在次要操作后面 */
  extra?: ReactNode;
}) {
  const shown = (list: RecordAction[]) => list.filter((a) => !a.hidden);
  const lead = shown(primary),
    side = shown(secondary);
  const misplacedDanger = [...lead, ...side].filter((a) => a.danger);
  if (misplacedDanger.length) devWarn('危险操作只能放“更多”，已挪过去');
  const safeLead = lead.filter((a) => !a.danger),
    safeSide = side.filter((a) => !a.danger);
  if (safeLead.length > 1) devWarn('一个区域只能有一个主操作，其余降为次要');
  // 和主操作同样高亮的（emphasis）紧挨着主操作，不被“编辑”隔开，也不会被挤进“更多”
  const p = safeLead.slice(0, 1),
    s = [...safeLead.slice(1), ...safeSide].sort((a, b) => Number(!!b.emphasis) - Number(!!a.emphasis));
  const overflow = s.slice(2);
  if (overflow.length) devWarn('次要操作最多两个，其余收进“更多”');
  const visibleSide = s.slice(0, 2);
  const m = [...overflow, ...shown(more)];
  const normal = m.filter((a) => !a.danger),
    danger = [...m.filter((a) => a.danger), ...misplacedDanger];
  if (!p.length && !visibleSide.length && !normal.length && !danger.length && !extra) return null;
  const menuItem = (a: RecordAction, i: number, key: string) =>
    a.href ? (
      <a
        key={key + i}
        role="menuitem"
        className={a.danger ? 'danger-text' : ''}
        href={a.href}
        {...(a.external ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {a.icon}
        {a.label}
      </a>
    ) : (
      <button
        key={key + i}
        type="button"
        role="menuitem"
        className={a.danger ? 'danger-text' : ''}
        disabled={a.disabled}
        title={a.title}
        onClick={a.onClick}
      >
        {a.icon}
        {a.label}
      </button>
    );
  return (
    <div className="record-actions">
      {p.map((a, i) => (
        <ActionButton key={'p' + i} a={a} primary />
      ))}
      {visibleSide.map((a, i) => (
        <ActionButton key={'s' + i} a={a} />
      ))}
      {extra}
      {(normal.length > 0 || danger.length > 0) && (
        <MoreMenu text="更多">
          {normal.map((a, i) => menuItem(a, i, 'm'))}
          {normal.length > 0 && danger.length > 0 && <hr className="more-menu-sep" />}
          {danger.map((a, i) => menuItem({ ...a, danger: true }, i, 'd'))}
        </MoreMenu>
      )}
    </div>
  );
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
