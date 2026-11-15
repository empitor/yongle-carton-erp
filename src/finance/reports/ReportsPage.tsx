import { Segmented } from '../../ui/index';
import { NeedEnable, useEnable } from '../enable';
import { ReportsTab } from './FormalReports';
import ClosingPage from './ClosingPage';
import BudgetTab from './BudgetTab';
import { financePageTitles } from '../page-titles';
import { FinHead, SubBar, type HeadProps } from '../layout';
import { useFocusSection, usePeriod, useTab } from '../page-state';

/**
 * 报表结账：正式报表（三张表切换）、结账（试算平衡、会计期间并在这里）两个页签，预算不常用，在“更多”里打开。
 * 管理看板并进了财务概览的“记账口径”。
 */
const tabs = [
  ['reports', '正式报表'],
  ['closing', '结账'],
] as const;

/** 页签里某一节的名字 → 它所在的页签：地址写 tab=<节名> 时打开那个页签并滚到那一节（站内链接、界面检查脚本都这样跳） */
const sectionTabs: Record<string, string> = {
  balance: 'reports',
  profit: 'reports',
  cashflow: 'reports',
  trial: 'closing',
  periods: 'closing',
};

export default function ReportsPage() {
  const [picked, setTab, requested] = useTab('reports', sectionTabs);
  const [period, setPeriod] = usePeriod();
  const enable = useEnable();
  const tab = tabs.some(([k]) => k === picked) || picked === 'budget' ? picked : 'reports';
  useFocusSection(requested, ['trial', 'periods']);
  const options = tab === 'budget' ? [...tabs, ['budget', '预算'] as const] : tabs;
  const head = (props: HeadProps) => (
    <>
      <FinHead
        title={financePageTitles['finance-reports']}
        {...props}
        more={[
          ...(props.more || []),
          tab !== 'budget' && { label: '预算', onClick: () => setTab('budget') },
        ]}
      />
      <SubBar>
        <Segmented className="fin-segmented" label="报表结账分类" value={tab} onChange={setTab} options={options} />
      </SubBar>
    </>
  );
  if (enable.known && !enable.enabled)
    return (
      <div className="fin-page">
        <FinHead title={financePageTitles['finance-reports']} primary={enable.action} />
        <NeedEnable what="出正式报表和结账" canEnable={enable.canEnable} />
        {enable.dialog}
      </div>
    );
  const props = { head, period, setPeriod };
  return (
    <div className="fin-page">
      {tab === 'reports' && <ReportsTab {...props} initial={requested} />}
      {tab === 'closing' && <ClosingPage {...props} />}
      {tab === 'budget' && <BudgetTab {...props} />}
    </div>
  );
}
