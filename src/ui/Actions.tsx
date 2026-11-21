import type { ReactNode } from 'react';
import MoreMenu from './MoreMenu';

/**
 * 全站一套“主 / 次 / 更多”的动作模型（docs/界面规范.md“按钮和入口”）：
 * 详情头部用 ActionBar（主、次在最左，然后“更多”），页头用 PageHeading 的 primary、secondary、more（在最右），
 * 勾选后的操作条用 SelectionBar。“更多”里的一项只用 MenuItem 写。
 */

export type RecordAction = {
  label: ReactNode;
  onClick?: () => void;
  href?: string;
  /** 新窗口打开，例如打印 */
  external?: boolean;
  /** 导出类链接：浏览器直接下载 */
  download?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  icon?: ReactNode;
  hidden?: boolean;
  /** 和主按钮并列、同样高亮。只用于产品的“新建订单”（和“安排生产”并列，界面规范里登记的唯一例外） */
  emphasis?: boolean;
};

/** 没有这一项时可以直接写 null、false */
export type MaybeAction = RecordAction | null | false | undefined;

const linkProps = (a: { external?: boolean; download?: boolean }) =>
  a.external ? { target: '_blank', rel: 'noreferrer' } : a.download ? { download: '' } : {};

/** “更多”菜单里的一项：给了 href 是链接，否则是按钮；danger 红色。label 是读屏名（和显示的字不同时才给）。 */
export function MenuItem({
  onClick,
  href,
  external,
  download,
  disabled,
  danger,
  title,
  label,
  children,
}: {
  onClick?: () => void;
  href?: string;
  external?: boolean;
  download?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  label?: string;
  children: ReactNode;
}) {
  const className = danger ? 'danger-text' : undefined;
  if (href)
    return (
      <a role="menuitem" className={className} href={href} title={title} aria-label={label} {...linkProps({ external, download })}>
        {children}
      </a>
    );
  return (
    <button type="button" role="menuitem" className={className} disabled={disabled} title={title} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** “更多”：普通项在上，危险项在分隔线下面、红色；没有可显示的项就不出 */
export function ActionMenu({ items, label }: { items: RecordAction[]; label?: string }) {
  const normal = items.filter((a) => !a.danger),
    danger = items.filter((a) => a.danger);
  if (!items.length) return null;
  const item = (a: RecordAction, key: string) => (
    <MenuItem
      key={key}
      onClick={a.onClick}
      href={a.href}
      external={a.external}
      download={a.download}
      disabled={a.disabled}
      danger={a.danger}
      title={a.title}
    >
      {a.icon}
      {a.label}
    </MenuItem>
  );
  return (
    <MoreMenu text="更多" label={label}>
      {normal.map((a, i) => item(a, 'n' + i))}
      {normal.length > 0 && danger.length > 0 && <hr className="more-menu-sep" />}
      {danger.map((a, i) => item(a, 'd' + i))}
    </MoreMenu>
  );
}

/** 一个按钮：主（或 emphasis）实心，危险红字，其余次要。链接的底样式详情用 button-link、页头（head）用 button。 */
export function ActionButton({ a, primary, head }: { a: RecordAction; primary?: boolean; head?: boolean }) {
  const className = primary || a.emphasis ? 'primary' : a.danger ? 'danger-text' : 'secondary';
  if (a.href)
    return (
      <a className={(head ? 'button ' : 'button-link ') + className} href={a.href} title={a.title} {...linkProps(a)}>
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
  if (import.meta.env?.DEV) console.warn('[动作] ' + message);
};
const present = (a: MaybeAction): a is RecordAction => !!a && !a.hidden;

/**
 * 全站一套规则：主操作只有一个（多传的降为次要）；次要最多 sideMax 个（多的进“更多”）；
 * 危险操作（取消、撤销、删除）只在“更多”最下面，传到主、次里的也挪过去。
 */
function arrange(primary: MaybeAction[], secondary: MaybeAction[], more: MaybeAction[], sideMax: number) {
  const lead = primary.filter(present),
    side = secondary.filter(present);
  const misplacedDanger = [...lead, ...side].filter((a) => a.danger);
  if (misplacedDanger.length) devWarn('危险操作只能放“更多”，已挪过去');
  const safeLead = lead.filter((a) => !a.danger);
  if (safeLead.length > 1) devWarn('一个区域只能有一个主操作，其余降为次要');
  // 和主操作同样高亮的（emphasis）紧挨着主操作，不被“编辑”隔开，也不会被挤进“更多”
  const s = [...safeLead.slice(1), ...side.filter((a) => !a.danger)].sort(
    (a, b) => Number(!!b.emphasis) - Number(!!a.emphasis),
  );
  if (s.length > sideMax) devWarn('次要操作最多 ' + sideMax + ' 个，其余收进“更多”');
  return {
    lead: safeLead.slice(0, 1),
    side: s.slice(0, sideMax),
    more: [...s.slice(sideMax), ...more.filter(present), ...misplacedDanger],
  };
}

/** 详情头部的一行操作：主、次在最左（次要最多两个），“更多”在最右。extra 是自带下拉的现成组件（例如导出），放在次要后面。 */
export function ActionBar({
  primary = [],
  secondary = [],
  more = [],
  extra,
}: {
  primary?: RecordAction[];
  secondary?: RecordAction[];
  more?: RecordAction[];
  extra?: ReactNode;
}) {
  const g = arrange(primary, secondary, more, 2);
  if (!g.lead.length && !g.side.length && !g.more.length && !extra) return null;
  return (
    <div className="record-actions">
      {g.lead.map((a, i) => (
        <ActionButton key={'p' + i} a={a} primary />
      ))}
      {g.side.map((a, i) => (
        <ActionButton key={'s' + i} a={a} />
      ))}
      {extra}
      <ActionMenu items={g.more} />
    </div>
  );
}

export type PageActionProps = {
  /** 当前该做的下一步；没有就不放 */
  primary?: MaybeAction;
  secondary?: MaybeAction;
  more?: MaybeAction[];
  /** “更多”按钮的读屏名，默认“更多操作” */
  moreLabel?: string;
};

/** 页头右边的按钮：从左到右“更多”、一个次要、一个主按钮。都没有时是 null。 */
export function pageActions({ primary, secondary, more = [], moreLabel }: PageActionProps): ReactNode {
  const g = arrange([primary], [secondary], more, 1);
  if (!g.lead.length && !g.side.length && !g.more.length) return null;
  return (
    <>
      <ActionMenu items={g.more} label={moreLabel} />
      {g.side.map((a, i) => (
        <ActionButton key={'s' + i} a={a} head />
      ))}
      {g.lead.map((a, i) => (
        <ActionButton key={'p' + i} a={a} primary head />
      ))}
    </>
  );
}
