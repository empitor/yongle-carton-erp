import { useEffect, useState } from 'react';
import { CalendarCheck, ClipboardList, Factory, Warehouse, type LucideIcon } from 'lucide-react';
import YlSpirits from '../YlSpirits';

const PHONE_QUERY = '(max-width: 700px)';

/** 非渲染场景（服务端渲染、测试）下按电脑处理。 */
export function isPhoneNow() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhoneNow);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

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
}: {
  page: string;
  navigate: (target: string) => void;
}) {
  const tab = (target: string, label: string, Icon: LucideIcon, pages: string[]) => {
    const selected = pages.includes(page);
    return (
      <button
        type="button"
        className={'mobile-tab' + (selected ? ' selected' : '')}
        aria-current={selected ? 'page' : undefined}
        onClick={() => navigate(target)}
      >
        <Icon size={20} aria-hidden="true" />
        {label}
      </button>
    );
  };
  return (
    <nav className="mobile-tabbar" aria-label="手机底部导航">
      {tab('dashboard', '今日', CalendarCheck, ['dashboard'])}
      {tab('orders', '订单', ClipboardList, ['orders'])}
      <button
        type="button"
        className="mobile-tab mobile-tab-ai"
        onClick={() => window.dispatchEvent(new Event('erp-open-assistant'))}
      >
        <span>
          <YlSpirits still />
        </span>
        助手
      </button>
      {tab('production', '生产', Factory, ['production'])}
      {tab('warehouse', '仓库', Warehouse, ['warehouse', 'arrivals'])}
    </nav>
  );
}

const warehouseViews = [
  ['warehouse', '库存', (p: URLSearchParams) => !['arrivals', 'deliveries', 'flow', 'arrivalPlans', 'deliveryPlans'].some((k) => p.get(k) === '1')],
  ['warehouse?arrivals=1', '到货', (p: URLSearchParams) => p.get('arrivals') === '1' || p.get('arrivalPlans') === '1'],
  ['warehouse?deliveries=1&kind=finished', '送货', (p: URLSearchParams) => p.get('deliveries') === '1' || p.get('deliveryPlans') === '1'],
  ['warehouse?flow=1', '流水', (p: URLSearchParams) => p.get('flow') === '1'],
] as const;
const productionViews = [
  ['production', '生产任务', (p: URLSearchParams) => p.get('view') !== 'production'],
  ['production?view=production', '完工记录', (p: URLSearchParams) => p.get('view') === 'production'],
] as const;

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
  const params = new URLSearchParams(route.split('?')[1] || '');
  return (
    <nav className="mobile-subnav" aria-label="页面切换">
      {views.map(([target, label, active]) => (
        <button
          key={target}
          type="button"
          className={active(params) ? 'selected' : ''}
          onClick={() => navigate(target)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
