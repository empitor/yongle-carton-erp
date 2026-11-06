import { Component, type ReactNode } from 'react';
import OverviewPage from './OverviewPage';
import FlowLedgerPage from './FlowLedgerPage';
import PartiesPage from './PartiesPage';
import CashPage from './CashPage';
import CostsPage from './CostsPage';
import LedgerPage from './LedgerPage';
import ReportsPage from './ReportsPage';
import SettingsPage from './SettingsPage';

/** 单个页面出错时只影响这一页，不让整个系统白屏。 */
class PageBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="error" role="alert">
        这个页面出错了，请刷新后重试。{this.state.error}
      </div>
    ) : (
      this.props.children
    );
  }
}

/** 财务页面单独打包，不用财务的账号不下载这部分代码。 */
export default function FinancePages({ page }: { page: string }) {
  return <PageBoundary key={page}>{pageOf(page)}</PageBoundary>;
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
