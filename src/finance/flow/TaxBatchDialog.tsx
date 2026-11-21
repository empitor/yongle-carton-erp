import { useState } from 'react';
import { FormGroup, FormMessage, FormSection, FormField } from '../../ui/index';
import { EditorShell } from '../editor';
import { completeTaxForEvents, completeTaxForParty } from './tax-api';
import { taxModeOptions, PartyField } from '../fields';

type How = 'rate' | 'noTax' | 'party';
const hows: [How, string][] = [
  ['rate', '填写税率'],
  ['noTax', '无税、不开票'],
  ['party', '用往来单位默认税率'],
];

/** 一组单选按钮，选项一眼看全。 */
function Choices<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="fb-choices">
      {options.map(([k, label]) => (
        <label key={k} className="fb-choice">
          <input type="radio" name={name} checked={value === k} onChange={() => onChange(k)} />
          {label}
        </label>
      ))}
    </div>
  );
}

/**
 * 批量补税率：补台账里勾选的几张，或者补某个单位当月全部待补的单据。
 * 只改财务记录，单据原件和理论盈亏不变。
 */
export default function TaxBatchDialog({
  picked,
  period,
  close,
  done,
}: {
  /** 勾选的事件编号；不传就是按单位整月补 */
  picked?: number[];
  period: string;
  close: () => void;
  /** 补完以后（台账会自己重读） */
  done?: () => void;
}) {
  const byParty = !picked;
  const [how, setHow] = useState<How>('rate');
  const [rate, setRate] = useState('');
  const [mode, setMode] = useState('');
  const [evidence, setEvidence] = useState('');
  const [kind, setKind] = useState<'customer' | 'supplier'>('customer');
  const [partyId, setPartyId] = useState('');
  const body = () => ({
    ...(how === 'rate' ? { rate: rate.trim(), mode } : {}),
    ...(how === 'noTax' ? { noTax: true } : {}),
    ...(how === 'party' ? { usePartyDefault: true } : {}),
    ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
  });
  return (
    <EditorShell
      title={byParty ? '按单位补 ' + period + ' 的税率' : '补选中 ' + picked.length + ' 张单据的税率'}
      size="md"
      submitLabel="保存税率"
      note="只改财务记录，单据原件和理论盈亏不变。"
      close={close}
      submit={async () => {
        if (byParty) {
          if (!partyId) throw new Error('请选择单位。');
          await completeTaxForParty({ kind, partyId: String(Number(partyId)), period }, body());
          done?.();
          return '已补好这个单位 ' + period + ' 待补的税率。';
        }
        await completeTaxForEvents(picked, body());
        done?.();
        return '已补 ' + picked.length + ' 张单据的税率。';
      }}
    >
      {byParty && (
        <FormMessage tone="info">一次补这个单位当月所有待补单据，每批最多 200 张。</FormMessage>
      )}
      {byParty && (
        <FormSection title="补哪个单位" columns={1}>
          <FormGroup label="单位类型">
            <Choices
              name="tax-batch-kind"
              value={kind}
              options={[
                ['customer', '客户（送货单）'],
                ['supplier', '供应商（到货单）'],
              ]}
              onChange={(v) => {
                setKind(v);
                setPartyId('');
              }}
            />
          </FormGroup>
          <FormField label="单位" required>
            <PartyField
              key={kind}
              kind={kind}
              label="单位"
              required
              value={partyId}
              onChange={setPartyId}
            />
          </FormField>
        </FormSection>
      )}
      <FormSection title="怎么补" columns={2}>
        <FormGroup label="补法">
          <Choices name="tax-batch-how" value={how} options={hows} onChange={setHow} />
        </FormGroup>
        {how === 'rate' && (
          <>
            <FormField label="税率 %" required>
              <input
                inputMode="decimal"
                required
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </FormField>
            <FormField label="口径" required>
              <select required value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">请选择</option>
                {taxModeOptions.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
          </>
        )}
        <FormField label="依据" span="full" hint="选填，例如合同约定或对方开的票">
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </FormField>
      </FormSection>
    </EditorShell>
  );
}
