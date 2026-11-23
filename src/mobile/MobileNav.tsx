import { useEffect } from 'react';
import {
  BookOpen,
  CalendarCheck,
  ClipboardList,
  Factory,
  HandCoins,
  Landmark,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { pageHref, pageShortTitle, productionViews, warehouseViews, type PageId } from '../../shared/core/index';
import { YlSpirits } from '../assistant/index';
import { useIsPhone } from '../ui/index';
import { emit } from '../ui/index';

/**
 * 手机上把表格变成卡片：给每个单元格写上列名，第一列当标题，空值和批量勾选不显示。
 * 表格很多，统一在这里处理，页面代码不用改。
 */
export function useMobileTables() {
  const phone = useIsPhone();
  useEffect(() => {
    if (!phone) return;
    const stamp = () => {
      for (const table of document.querySelectorAll<HTMLTableElement>(
        'main table:not(.fin-compare):not(.fin-lines), .detail-panel table:not(.fin-lines)',
      )) {
        table.classList.add('m-cards');
        const heads = [...table.querySelectorAll('thead th')];
        const labels = heads.map((th) => th.textContent?.trim() || '');
        const batch = heads.map((th) => !!th.querySelector('input[type="checkbox"]'));
        for (const row of table.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
          let titled = false;
          [...row.cells].forEach((cell, index) => {
            if (cell.colSpan > 1) {
              cell.classList.add('m-plain');
              return;
            }
            const text = cell.textContent?.trim() || '';
            const hasControl = !!cell.querySelector('button,a,input,select,summary');
            const hide = batch[index] || (!hasControl && (text === '' || text === '—'));
            cell.classList.toggle('m-hide', hide);
            if (hide) return;
            if (!titled && text) {
              titled = true;
              cell.classList.add('m-title');
            } else cell.classList.remove('m-title');
            if (labels[index]) cell.dataset.label = labels[index];
            else delete cell.dataset.label;
          });
        }
      }
    };
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        stamp();
      }, 60);
    };
    stamp();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      document.querySelectorAll('.m-cards').forEach((t) => t.classList.remove('m-cards'));
    };
  }, [phone]);
}

/** 底部导航：手机上最常用的五个入口，中间是 AI 助手。其他页面在左上角菜单里。 */
export function MobileTabBar({
  page,
  navigate,
  financeOnly = false,
}: {
  page: string;
  navigate: (target: string) => void;
  /** 出纳这类纯财务账号：底部换成财务入口。 */
  financeOnly?: boolean;
}) {
  const tab = (target: PageId, Icon: LucideIcon) => {
    const selected = target === page;
    return (
      <button
        type="button"
        className={'mobile-tab' + (selected ? ' selected' : '')}
        aria-current={selected ? 'page' : undefined}
        onClick={() => navigate(pageHref(target))}
      >
        <Icon size={20} aria-hidden="true" />
        {pageShortTitle(target)}
      </button>
    );
  };
  const assistant = (
    <button
      type="button"
      className="mobile-tab mobile-tab-ai"
      onClick={() => emit('erp-open-assistant')}
    >
      <span>
        <YlSpirits still />
      </span>
      助手
    </button>
  );
  if (financeOnly)
    return (
      <nav className="mobile-tabbar" aria-label="手机底部导航">
        {tab('finance', Landmark)}
        {tab('finance-ar', HandCoins)}
        {assistant}
        {tab('finance-cash', Wallet)}
        {tab('finance-ledger', BookOpen)}
      </nav>
    );
  return (
    <nav className="mobile-tabbar" aria-label="手机底部导航">
      {tab('dashboard', CalendarCheck)}
      {tab('orders', ClipboardList)}
      {assistant}
      {tab('production', Factory)}
      {tab('warehouse', Warehouse)}
    </nav>
  );
}

/** 仓库、生产在电脑上靠左侧导航切换，手机上放到页面顶部。 */
export function MobileSubNav({
  page,
  route,
  navigate,
}: {
  page: string;
  route: string;
  navigate: (target: string) => void;
}) {
  const views = page === 'warehouse' ? warehouseViews : page === 'production' ? productionViews : null;
  if (!views) return null;
  return (
    <nav className="mobile-subnav" aria-label="页面切换">
      {views.map((v) => (
        <button
          key={v.href}
          type="button"
          className={v.active(route) ? 'selected' : ''}
          onClick={() => navigate(v.href)}
        >
          {v.label}
        </button>
      ))}
    </nav>
  );
}
