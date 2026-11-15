import { useState } from 'react';
import { Facts, Hint, Section } from '../../ui/index';
import { bpText } from '../percent';
import { useEnable } from '../enable';
import { ErrorLine, FinSection, type HeadFn } from '../layout';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { saveSettings } from './settings-api';
import { costOptions, rateFields, revenueOptions, settingsBody, settingsInitial } from './settings-forms';
import { FormDialog } from '../FormDialog';
import type { Field } from '../form-values';

type Settings = FinData<'GET /finance/settings'>;

const taxpayerName = (v: Settings['taxpayer']) =>
  v === 'small' ? '小规模纳税人' : v === 'general' ? '一般纳税人' : '';

/** 当前设置：记账规则和税率 */
function CurrentSettings({ data }: { data: Settings }) {
  return (
    <FinSection title="当前设置">
      <Section title="记账规则">
        <Facts
          items={[
            { label: '启用月份', value: data.startPeriod || '未启用' },
            { label: '纳税人', value: taxpayerName(data.taxpayer) },
            { label: '制单和审核分开', value: data.requireSeparateApprover ? '是' : '否' },
            {
              label: '收入确认',
              value: data.revenueRecognition === 'invoice' ? '开票时' : '送货时',
            },
            {
              label: '成本分摊',
              value: data.costAllocation === 'material' ? '按材料' : '按产量',
            },
            {
              label: '账龄分段',
              value: data.agingDays.map((d) => d + ' 天').join('、'),
            },
          ]}
        />
      </Section>
      <Section title="税率">
        <Facts
          items={rateFields.map(([k, label]) => {
            const bp = data.taxRates[k];
            return { label: label.replace(/ %$/, ''), value: bp === null ? '' : bpText(bp) + '%' };
          })}
        />
      </Section>
    </FinSection>
  );
}

/** 编辑窗的字段：记账规则、税率；制单审核分开只有超级管理员能改 */
const settingsFields = (isSuper: boolean): Field[] => [
  {
    name: 'revenueRecognition',
    label: '收入确认',
    type: 'select',
    required: true,
    section: '记账规则',
    options: revenueOptions,
  },
  {
    name: 'costAllocation',
    label: '成本分摊',
    type: 'select',
    required: true,
    section: '记账规则',
    options: costOptions,
  },
  {
    name: 'agingDays',
    label: '账龄分段',
    section: '记账规则',
    span: 'full',
    hint: '5 个递增的天数，用顿号分开，例如 30、60、90、180、365',
  },
  ...(isSuper
    ? [
        {
          name: 'requireSeparateApprover',
          label: '制单和审核必须不同人',
          type: 'check' as const,
          section: '记账规则',
          hint: '只有一个人记账时要关掉，否则自己做的凭证没法审核。',
        },
      ]
    : []),
  ...rateFields.map(([name, label]) => ({ name, label, section: '税率' })),
];

export default function BasicTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const enable = useEnable();
  const { data, error } = useFinRead(['GET /finance/settings']);
  const [editing, setEditing] = useState(false);
  return (
    <>
      {head({
        primary: enable.action,
        secondary:
          data && perms.close ? { label: '编辑设置', onClick: () => setEditing(true) } : null,
      })}
      <ErrorLine text={error} />
      {data && !data.startPeriod && (
        <FinSection title="启用财务">
          <p className="fin-note">
            选一个开始记账的月份，填上期初余额。启用后期初和纳税人身份锁定。启用月之前的单据不进账，也不进台账。
            期初可以先空着；只想看理论和实际盈亏时不用启用。
          </p>
          {enable.canEnable ? (
            <Hint>点页面上方的“启用财务”开始。</Hint>
          ) : (
            <Hint>启用财务需要财务负责人来做。</Hint>
          )}
        </FinSection>
      )}
      {data && <CurrentSettings data={data} />}
      {editing && data && (
        <FormDialog
          title="编辑财务设置"
          size="md"
          sections={[
            { title: '记账规则', columns: 2 },
            {
              title: '税率',
              columns: 3,
              hint: '都由你填，系统没有默认值。结账计提税费时缺哪个会提示。',
            },
          ]}
          fields={settingsFields(perms.isSuper)}
          initial={settingsInitial(data)}
          submitLabel="保存设置"
          notice="财务设置已保存。"
          close={() => setEditing(false)}
          submit={(v) => saveSettings(settingsBody(data, v, perms.isSuper))}
        />
      )}
      {enable.dialog}
    </>
  );
}
