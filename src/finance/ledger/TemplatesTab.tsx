import { useState } from 'react';
import { FormMessage, DetailPanel, Facts, FormSection, ActionBar, Section, stepper, FormField } from '../../ui/index';
import {
  templateFieldTitles,
  templatePartyAccounts,
  templateTitles,
} from '../../../shared/finance/index';
import { AccountInput } from '../fields';
import { EditorShell, useAccountNames } from '../editor';
import { FinSection, type HeadFn } from '../layout';
import { FinTable, col } from '../table';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { saveTemplate } from './ledger-api';

type Template = FinData<'GET /finance/templates'>[number];

const titleOf = (t: Template) => templateTitles[t.name] ?? '其他模板';
const fieldTitle = (t: Template, key: string) => templateFieldTitles[t.name]?.[key] ?? '其他用途';

/** 记账模板：业务单据记账时用哪些科目。点一行看详情，编辑在详情里。 */
export default function TemplatesTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const { data, error } = useFinRead(['GET /finance/templates']);
  const accountName = useAccountNames();
  const [row, setRow] = useState<Template | null>(null);
  const [editing, setEditing] = useState(false);
  const rows = data || [];
  const summary = (t: Template) =>
    Object.entries(t.mapping)
      .map(([key, code]) => fieldTitle(t, key) + '：' + accountName(code))
      .join('；');
  return (
    <>
      {head({})}
      <FinSection title="记账模板" note="业务单据记账时用哪些科目，改之前先问懂账的人">
        <FormMessage>{error}</FormMessage>
        <FinTable
          label="记账模板"
          rows={rows}
          rowKey={(r) => r.name}
          onRow={setRow}
          selected={row?.name}
          cols={[
            col('name', '模板', { render: titleOf }),
            col('mapping', '用哪些科目', { wrap: true, render: summary }),
          ]}
        />
      </FinSection>
      {row && (
        <DetailPanel
          kicker="记账模板"
          title={titleOf(row)}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.name, row.name, setRow)}
          actions={
            <ActionBar
              primary={[{ label: '编辑模板', hidden: !perms.close, onClick: () => setEditing(true) }]}
            />
          }
        >
          <Section title="用哪些科目">
            <Facts
              items={Object.entries(row.mapping).map(([key, code]) => ({
                label: fieldTitle(row, key),
                value: accountName(code),
              }))}
            />
          </Section>
        </DetailPanel>
      )}
      {editing && row && (
        <TemplateDialog
          row={row}
          close={() => {
            setEditing(false);
            setRow(null);
          }}
        />
      )}
    </>
  );
}

/** 改记账模板：每个用途选一个末级科目；送货、到货的往来科目只能在应收、应付账款下选（和服务端校验同一份规则）。 */
function TemplateDialog({ row, close }: { row: Template; close: () => void }) {
  const [mapping, setMapping] = useState(row.mapping);
  const party = templatePartyAccounts[row.name];
  return (
    <EditorShell
      title="编辑记账模板"
      subtitle={titleOf(row)}
      size="md"
      submitLabel="保存模板"
      note="业务单据记账时用这些科目，改之前先问懂账的人。"
      close={close}
      submit={async () => {
        await saveTemplate({ name: row.name, mapping, version: row.version });
        return '记账模板“' + titleOf(row) + '”已保存。';
      }}
    >
      <FormSection columns={1}>
        {Object.keys(row.mapping).map((key) => {
          const under = key === 'party' ? party?.code : undefined;
          return (
            <FormField
              key={key}
              label={fieldTitle(row, key)}
              required
              hint={under ? '只能选' + party.name + '（' + party.code + '）或它的下级科目' : undefined}
            >
              <AccountInput
                label={fieldTitle(row, key)}
                required
                under={under}
                value={mapping[key]}
                onChange={(code) => setMapping((m) => ({ ...m, [key]: code }))}
              />
            </FormField>
          );
        })}
      </FormSection>
    </EditorShell>
  );
}
