import { Segmented } from '../../ui/index';
import { NeedEnable, useEnable } from '../enable';
import ExpensesTab from './ExpensesTab';
import AssetsTab from './AssetsTab';
import PayrollTab from './PayrollTab';
import CostingTab from './CostingTab';
import { financePageTitles } from '../page-titles';
import { FinHead, SubBar, type HeadProps } from '../layout';
import { useFocusSection, useTab } from '../page-state';

/** 费用资产工资：四个页签。毛利并进“成本毛利”，员工借还款在“费用报销”页头的“更多”里。 */
const tabs = [
  ['expenses', '费用报销'],
  ['assets', '固定资产'],
  ['payroll', '工资'],
  ['costing', '成本毛利'],
] as const;
/** 页签里某一节的名字 → 它所在的页签：地址写 tab=<节名> 时打开那个页签并滚到那一节（站内链接、界面检查脚本都这样跳） */
const sectionTabs: Record<string, string> = { margin: 'costing' };

export default function CostsPage() {
  const [picked, setTab, requested] = useTab('expenses', sectionTabs);
  const tab = tabs.some(([k]) => k === picked) ? picked : 'expenses';
  const enable = useEnable();
  useFocusSection(requested, Object.keys(sectionTabs));
  const head = (props: HeadProps) => (
    <>
      <FinHead
        title={financePageTitles['finance-costs']}
        {...props}
        // 没启用时这几页都记不了账：主按钮只给“启用财务”（没权限的就不放）
        primary={enable.known && !enable.enabled ? enable.action : props.primary}
      />
      <SubBar>
        <Segmented className="fin-segmented" label="费用资产工资分类" value={tab} onChange={setTab} options={tabs} />
      </SubBar>
      {enable.known && !enable.enabled && (
        <NeedEnable what="报销、折旧、工资和成本记账" canEnable={enable.canEnable} />
      )}
    </>
  );
  return (
    <div className="fin-page">
      {tab === 'expenses' && <ExpensesTab head={head} />}
      {tab === 'assets' && <AssetsTab head={head} />}
      {tab === 'payroll' && <PayrollTab head={head} enabled={enable.enabled} />}
      {tab === 'costing' && <CostingTab head={head} />}
      {enable.dialog}
    </div>
  );
}
