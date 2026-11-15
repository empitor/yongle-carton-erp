import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Section, yuan, stepper } from '../../ui/index';
import TermsDialog from './TermsDialog';
import DepositsSection from './DepositsSection';
import InterestSection from './InterestSection';
import { describeTerm, partyKindOf, type Kind } from './shared';
import { FinList, col, type Col } from '../table';
import { FinSection, type HeadFn } from '../layout';
import { useFinPerms, type FinData } from '../fin-api';
import { listPartyTerms } from './parties-api';

/** 账期列表一行（约定 options 服务端已解析） */
type TermsRow = FinData<'GET /finance/party-terms'>['rows'][number];

const discountText = ({ options: o }: TermsRow) =>
  o.discounts.length ? o.discounts.map((d) => d.rate + '%').join('、') : '';
const interestText = ({ options: o }: TermsRow) =>
  o.interest ? o.interest.rate + '%' + (o.interest.unit === 'monthly' ? '/月' : '/年') : '';
/** 默认税率：比例加含税、未税口径 */
const taxText = (r: TermsRow) => (r.tax_rate ? r.tax_rate + '% ' + (r.tax_mode || '') : '未设');

const termsCols: Col<TermsRow>[] = [
  col('party_name', '往来单位', { wrap: true }),
  col('term', '账期', { render: describeTerm }),
  col('tax', '默认税率', { render: taxText }),
  // 账期文字长（“压 3 个月，每月 25 号付，20 号截止”），右侧详情打开时先收现结优惠和利息，详情里有
  col('discounts', '现结优惠', { render: (r) => discountText(r) || '—', priority: 'low' }),
  col('interest', '利息', { render: (r) => interestText(r) || '—', priority: 'low' }),
  col('credit_limit', '授信 / 元', {
    money: true,
    render: (r) => (r.credit_limit == null ? '—' : yuan(r.credit_limit)),
  }),
];

/**
 * 账期：每个单位多久付款、默认税率、现结优惠、利息和授信（点一行看详情，编辑在详情里），
 * 下面是保证金、压款利息两节。
 */
export default function TermsTab({ kind, head }: { kind: Kind; head: HeadFn }) {
  const perms = useFinPerms();
  const pk = partyKindOf(kind);
  const who = pk === 'customer' ? '客户' : '供应商';
  const [editing, setEditing] = useState<{ partyId?: string; partyName?: string } | null>(null);
  const [row, setRow] = useState<TermsRow | null>(null);
  const [rows, setRows] = useState<TermsRow[]>([]);
  return (
    <>
      {head({
        primary: perms.edit ? { label: '新建' + who + '账期', onClick: () => setEditing({}) } : null,
      })}
      <FinSection id="terms" title="账期" note="多久付款、默认税率、现结优惠、利息和授信都按单位设">
        <FinList
          list={listPartyTerms}
          label="账期"
          query={{ kind: pk }}
          rowKey={(r) => r.party_id}
          onRow={setRow}
          onData={(d) => setRows(d.rows)}
          selected={row?.party_id}
          empty={'还没有给' + who + '设账期。没设的单位，到期日留空，不影响业务。'}
          cols={termsCols}
        />
      </FinSection>
      <DepositsSection kind={kind} />
      <InterestSection kind={kind} />
      {row && (
        <DetailPanel
          kicker={who + '账期'}
          title={row.party_name}
          subtitle={describeTerm(row)}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.party_id, row.party_id, setRow)}
          actions={
            <ActionBar
              primary={[
                {
                  label: '编辑账期',
                  hidden: !perms.edit,
                  onClick: () => setEditing({ partyId: String(row.party_id), partyName: row.party_name }),
                },
              ]}
            />
          }
        >
          <Section title="约定">
            <Facts
              items={[
                { label: '账期', value: describeTerm(row) },
                {
                  label: '默认税率',
                  value: taxText(row),
                },
                { label: '现结优惠', value: discountText(row) },
                { label: '压款利息', value: interestText(row) },
                {
                  label: '授信额度',
                  value: row.credit_limit == null ? '' : yuan(row.credit_limit) + ' 元',
                },
                { label: '保证金往来', value: row.options.deposits ? '有' : '' },
              ]}
            />
          </Section>
        </DetailPanel>
      )}
      {editing && (
        <TermsDialog
          kind={pk}
          partyId={editing.partyId}
          partyName={editing.partyName}
          close={() => {
            setEditing(null);
            setRow(null);
          }}
        />
      )}
    </>
  );
}
