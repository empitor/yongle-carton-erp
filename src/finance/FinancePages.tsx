import { useEffect, useRef } from 'react';
import { financePageIds, pageHref, pageTitle } from '../../shared/core/index';
import { ErrorBoundary } from '../ui/index';
import OverviewPage from './overview/OverviewPage';
import FlowLedgerPage from './flow/FlowLedgerPage';
import PartiesPage from './parties/PartiesPage';
import CashPage from './cash/CashPage';
import CostsPage from './costs/CostsPage';
import LedgerPage from './ledger/LedgerPage';
import ReportsPage from './reports/ReportsPage';
import SettingsPage from './settings/SettingsPage';


/** 财务页面之间的页签：电脑一行排开，手机横向滑动、不折行，当前页自动滑到看得见的位置。 */
function FinanceNav({ page }: { page: string }) {
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = track.current,
      current = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !current) return;
    // 只横向滚这一排，不带动整个页面上下滚
    const left = current.offsetLeft - (box.clientWidth - current.offsetWidth) / 2;
    box.scrollLeft = Math.max(0, left);
  }, [page]);
  return (
    <nav className="fin-nav" aria-label="财务页面">
      <div className="fin-nav-track" ref={track}>
        {financePageIds.map((key) => (
          <a
            key={key}
            href={pageHref(key)}
            className={page === key ? 'selected' : undefined}
            aria-current={page === key ? 'page' : undefined}
          >
            {pageTitle(key)}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** 财务页面单独打包，不用财务的账号不下载这部分代码。 */
export default function FinancePages({ page }: { page: string }) {
  return (
    <>
      <FinanceNav page={page} />
      <ErrorBoundary key={page}>{pageOf(page)}</ErrorBoundary>
    </>
  );
}
function pageOf(page: string) {
  switch (page) {
    case 'finance':
      return <OverviewPage />;
    case 'finance-flow':
      return <FlowLedgerPage />;
    case 'finance-ar':
      return <PartiesPage />;
    case 'finance-cash':
      return <CashPage />;
    case 'finance-costs':
      return <CostsPage />;
    case 'finance-ledger':
      return <LedgerPage />;
    case 'finance-reports':
      return <ReportsPage />;
    case 'finance-settings':
      return <SettingsPage />;
    default:
      return null;
  }
}
