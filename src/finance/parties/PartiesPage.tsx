import { Segmented } from '../../ui/index';
import { useState } from 'react';
import { DueTab } from './DueTab';
import ObligationsTab from './ObligationsTab';
import StatementTab from './StatementTab';
import TermsTab from './TermsTab';
import type { Kind } from './shared';
import { financePageTitles } from '../page-titles';
import { FinHead, SubBar, type HeadProps } from '../layout';
import { useFocusSection, useTab } from '../page-state';

/**
 * 应收应付：四个页签，各页签里分节（压货款、账龄、收付计划、现结优惠、保证金、压款利息）。
 * 应收 / 应付切换固定在页签这一排的右边，四个页签都在。
 */
const tabs = [
  ['items', '欠款明细'],
  ['soon', '到期和计划'],
  ['statement', '对账单'],
  ['terms', '账期'],
] as const;
/** 页签里某一节的名字 → 它所在的页签：地址写 tab=<节名> 时打开那个页签并滚到那一节（站内链接、界面检查脚本都这样跳） */
const sectionTabs: Record<string, string> = {
  held: 'items',
  aging: 'items',
  plan: 'soon',
  discount: 'soon',
  deposits: 'terms',
  interest: 'terms',
};

export default function PartiesPage() {
  const [picked, setTab, requested] = useTab('items', sectionTabs);
  const tab = tabs.some(([k]) => k === picked) ? picked : 'items';
  const [kind, setKind] = useState<Kind>('receivable');
  useFocusSection(requested, Object.keys(sectionTabs));
  const head = (props: HeadProps) => (
    <>
      <FinHead title={financePageTitles['finance-ar']} {...props} />
      <SubBar
        side={
          <Segmented className="fin-segmented"
            label="应收或应付"
            value={kind}
            onChange={(v) => {
              if (v === 'receivable' || v === 'payable') setKind(v);
            }}
            options={[
              ['receivable', '应收（客户）'],
              ['payable', '应付（供应商）'],
            ]}
          />
        }
      >
        <Segmented className="fin-segmented" label="应收应付分类" value={tab} onChange={setTab} options={tabs} />
      </SubBar>
    </>
  );
  return (
    <div className="fin-page">
      {tab === 'items' && <ObligationsTab kind={kind} head={head} />}
      {tab === 'soon' && <DueTab kind={kind} head={head} />}
      {tab === 'statement' && <StatementTab kind={kind} head={head} />}
      {tab === 'terms' && <TermsTab kind={kind} head={head} />}
    </div>
  );
}
