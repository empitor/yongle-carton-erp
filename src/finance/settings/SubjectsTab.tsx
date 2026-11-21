import { useState } from 'react';
import { FormMessage, DetailPanel, ActionBar, Facts, Section, stepper } from '../../ui/index';
import { FinSection, type HeadFn } from '../layout';
import { FinTable, col, type Col } from '../table';
import { useFinPerms, useFinRead } from '../fin-api';
import { saveSubject } from './settings-api';
import { auxiliaries, cashKinds, categories, directions, subjectBody, type AccountRow } from './settings-forms';
import { FormDialog } from '../FormDialog';

const categoryName = (v: unknown) => categories.find(([k]) => k === v)?.[1] ?? '—';
const auxiliaryName = (v: unknown) =>
  v ? (auxiliaries.find(([k]) => k === v)?.[1] ?? '其他') : '—';
const cashKindName = (v: unknown) => (v === 'cash' ? '现金' : v === 'bank' ? '银行' : '—');

/** 科目表的列 */
const subjectColumns: Col<AccountRow>[] = [
  col('code', '编码'),
  col('name', '名称'),
  col('category', '类别', { render: (a) => categoryName(a.category) }),
  col('direction', '方向', { render: (a) => (a.direction === 'debit' ? '借' : '贷') }),
  col('cash_kind', '资金', { render: (a) => cashKindName(a.cash_kind) }),
  col('auxiliary', '辅助核算', { render: (a) => auxiliaryName(a.auxiliary) }),
  col('enabled', '启用', { render: (a) => (a.enabled ? '是' : '否') }),
];

/** 新建（account 是 null）或编辑科目 */
function SubjectDialog({ account, close }: { account: AccountRow | null; close: () => void }) {
  return (
    <FormDialog
      title={account ? '编辑科目' : '新建科目'}
      subtitle={account ? account.code + ' ' + account.name : undefined}
      size="md"
      sections={[
        { title: '科目', columns: 2 },
        { title: '性质', columns: 2, hint: '已使用的科目不能改类别和方向。' },
        { title: '核算', columns: 2 },
      ]}
      fields={[
        {
          name: 'code',
          label: '编码',
          required: true,
          section: '科目',
          hint: '4 位起，每级加 2 位',
        },
        { name: 'name', label: '名称', required: true, section: '科目' },
        {
          name: 'category',
          label: '类别',
          type: 'select',
          required: true,
          section: '性质',
          options: categories,
        },
        {
          name: 'direction',
          label: '方向',
          type: 'select',
          required: true,
          section: '性质',
          options: directions,
        },
        {
          name: 'cashKind',
          label: '资金类型',
          type: 'select',
          section: '核算',
          hint: '现金、银行科目记账时要选现金流量项目',
          options: cashKinds,
        },
        {
          name: 'auxiliary',
          label: '辅助核算',
          type: 'select',
          section: '核算',
          hint: '选了以后，记账时每行要填对应的单位或名称',
          options: auxiliaries,
        },
        { name: 'enabled', label: '启用', type: 'check', section: '核算' },
      ]}
      initial={
        account
          ? {
              code: account.code,
              name: account.name,
              category: account.category,
              direction: account.direction,
              cashKind: account.cash_kind,
              auxiliary: account.auxiliary,
              enabled: !!account.enabled,
            }
          : { category: 'profit', direction: 'debit', enabled: true }
      }
      submitLabel="保存科目"
      notice="科目已保存。"
      close={close}
      submit={(v) => saveSubject(subjectBody(account, v))}
    />
  );
}

/** 科目：点一行看详情，编辑在详情里；已使用的科目不能改类别和方向。 */
export default function SubjectsTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const { data, error } = useFinRead(['GET /finance/accounts']);
  const [q, setQ] = useState('');
  const [row, setRow] = useState<AccountRow | null>(null);
  /** 开着的编辑窗：新建、编辑哪个科目，没开是 null */
  const [editing, setEditing] = useState<{ account: AccountRow | null } | null>(null);
  const rows = (data ?? []).filter(
    (a) => !q.trim() || a.code.startsWith(q.trim()) || a.name.includes(q.trim()),
  );
  return (
    <>
      {head({
        secondary: perms.close ? { label: '新建科目', onClick: () => setEditing({ account: null }) } : null,
      })}
      <div className="fin-toolbar">
        <input
          type="text"
          aria-label="搜索科目"
          placeholder="搜索编码或名称"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <FormMessage>{error}</FormMessage>
      <FinSection title="科目表" note="已使用的科目不能改类别和方向">
        <FinTable
          label="科目表"
          rows={rows}
          rowKey={(a) => a.code}
          onRow={setRow}
          selected={row?.code}
          cols={subjectColumns}
        />
      </FinSection>
      {row && (
        <DetailPanel
          kicker="科目"
          title={row.code + ' ' + row.name}
          subtitle={
            categoryName(row.category) + ' · ' + (row.direction === 'debit' ? '借方' : '贷方')
          }
          close={() => setRow(null)}
          {...stepper(rows, (a) => a.code, row.code, setRow)}
          actions={
            <ActionBar
              primary={[
                { label: '编辑科目', hidden: !perms.close, onClick: () => setEditing({ account: row }) },
              ]}
            />
          }
        >
          <Section title="基本信息">
            <Facts
              items={[
                { label: '编码', value: row.code },
                { label: '名称', value: row.name },
                { label: '类别', value: categoryName(row.category) },
                { label: '方向', value: row.direction === 'debit' ? '借' : '贷' },
                { label: '资金类型', value: cashKindName(row.cash_kind) },
                { label: '辅助核算', value: auxiliaryName(row.auxiliary) },
                { label: '末级科目', value: row.leaf ? '是' : '否' },
                { label: '启用', value: row.enabled ? '是' : '否' },
              ]}
            />
          </Section>
        </DetailPanel>
      )}
      {editing && (
        <SubjectDialog
          account={editing.account}
          close={() => {
            setEditing(null);
            setRow(null);
          }}
        />
      )}
    </>
  );
}
