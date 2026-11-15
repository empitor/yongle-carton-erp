import { Segmented } from '../../ui/index';
import { NeedEnable, useEnable } from '../enable';
import EventsTab from './EventsTab';
import VouchersTab from './VouchersTab';
import BooksTab from './BooksTab';
import TemplatesTab from './TemplatesTab';
import AuditTab from './AuditTab';
import { financePageTitles } from '../page-titles';
import { FinHead, SubBar, type HeadProps } from '../layout';
import { useFinPerms } from '../fin-api';
import { useTab } from '../page-state';

/** 凭证、业务单据、账簿三个页签；记账模板、修改记录不常用，在页头“更多”里打开。 */
const tabs = [
  ['vouchers', '凭证'],
  ['events', '业务单据'],
  ['books', '账簿'],
] as const;
const extraTabs: Record<string, string> = { templates: '记账模板', audit: '修改记录' };

export default function LedgerPage() {
  const [picked, setTab] = useTab('vouchers');
  const perms = useFinPerms();
  const enable = useEnable();
  // 修改记录只给财务负责人，别人打开回到凭证
  const tab =
    tabs.some(([k]) => k === picked) ||
    picked === 'templates' ||
    (picked === 'audit' && perms.close)
      ? picked
      : 'vouchers';
  const options = extraTabs[tab] ? [...tabs, [tab, extraTabs[tab]] as const] : tabs;
  const head = (props: HeadProps) => (
    <>
      <FinHead
        title={financePageTitles['finance-ledger']}
        {...props}
        more={[
          ...(props.more || []),
          tab !== 'templates' && { label: '记账模板', onClick: () => setTab('templates') },
          tab !== 'audit' && perms.close && { label: '修改记录', onClick: () => setTab('audit') },
        ]}
      />
      <SubBar>
        <Segmented className="fin-segmented" label="凭证账簿分类" value={tab} onChange={setTab} options={options} />
      </SubBar>
    </>
  );
  if (enable.known && !enable.enabled)
    return (
      <div className="fin-page">
        <FinHead title={financePageTitles['finance-ledger']} primary={enable.action} />
        <NeedEnable what="做凭证、看账簿" canEnable={enable.canEnable} />
        {enable.dialog}
      </div>
    );
  return (
    <div className="fin-page">
      {tab === 'vouchers' && <VouchersTab head={head} />}
      {tab === 'events' && <EventsTab head={head} />}
      {tab === 'books' && <BooksTab head={head} />}
      {tab === 'templates' && <TemplatesTab head={head} />}
      {tab === 'audit' && <AuditTab head={head} />}
    </div>
  );
}
