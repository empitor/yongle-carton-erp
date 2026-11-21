import { PageHeading, Segmented } from '../../ui/index';
import AccountsTab from './AccountsTab';
import DocumentsTab from './DocumentsTab';
import InvoicesTab from './InvoicesTab';
import NotesTab from './NotesTab';
import { financePageTitles } from '../page-titles';
import { SubBar, type HeadProps } from '../layout';
import { useFocusSection, useTab } from '../page-state';

/**
 * 资金发票：四个页签。银行流水并进“账户和流水”，开票对比、税务底稿并进“发票”。
 * 各页签的列表、详情和窗口在 ./cash/ 下。
 */
const tabs = [
  ['documents', '收付款'],
  ['accounts', '账户和流水'],
  ['notes', '票据'],
  ['invoices', '发票'],
] as const;
/** 页签里某一节的名字 → 它所在的页签：地址写 tab=<节名> 时打开那个页签并滚到那一节（站内链接、界面检查脚本都这样跳） */
const sectionTabs: Record<string, string> = { bank: 'accounts', matching: 'invoices', tax: 'invoices' };

export default function CashPage() {
  const [picked, setTab, requested] = useTab('documents', sectionTabs);
  const tab = tabs.some(([k]) => k === picked) ? picked : 'documents';
  useFocusSection(requested, Object.keys(sectionTabs));
  const head = (props: HeadProps) => (
    <>
      <PageHeading title={financePageTitles['finance-cash']} {...props} />
      <SubBar>
        <Segmented className="fin-segmented" label="资金发票分类" value={tab} onChange={setTab} options={tabs} />
      </SubBar>
    </>
  );
  return (
    <div className="fin-page">
      {tab === 'documents' && <DocumentsTab head={head} />}
      {tab === 'accounts' && <AccountsTab head={head} />}
      {tab === 'notes' && <NotesTab head={head} />}
      {tab === 'invoices' && <InvoicesTab head={head} />}
    </div>
  );
}
