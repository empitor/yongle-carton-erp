import { PageHeading, Segmented } from '../../ui/index';
import BasicTab from './BasicTab';
import SubjectsTab from './SubjectsTab';
import { financePageTitles } from '../page-titles';
import { SubBar, type HeadProps } from '../layout';
import { useTab } from '../page-state';

/** 财务设置：基本设置、科目两个页签。会计期间并进了报表结账的“结账”页签。 */
const tabs = [
  ['basic', '基本设置'],
  ['accounts', '科目'],
] as const;

export default function SettingsPage() {
  const [picked, setTab] = useTab('basic');
  const tab = tabs.some(([k]) => k === picked) ? picked : 'basic';
  const head = (props: HeadProps) => (
    <>
      <PageHeading title={financePageTitles['finance-settings']} {...props} />
      <SubBar>
        <Segmented className="fin-segmented" label="财务设置分类" value={tab} onChange={setTab} options={tabs} />
      </SubBar>
    </>
  );
  return (
    <div className="fin-page">
      {tab === 'basic' && <BasicTab head={head} />}
      {tab === 'accounts' && <SubjectsTab head={head} />}
    </div>
  );
}
