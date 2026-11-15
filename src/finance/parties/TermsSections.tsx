import { FormSection, FormField } from '../../ui/index';
import { FinCheck, UnitInput, taxModes } from '../fields';
import { num, optionOf, termTypes, type Interest, type TermsForm } from './terms-form';

/* 账期窗口里的几节：账期方式、税率和授信、压款利息。现结优惠和分期在 TermsLines.tsx。 */

type Props = { form: TermsForm; set: (patch: Partial<TermsForm>) => void };
/** 利率是年利率还是月利率；从到期日还是单据日起算 */
const interestUnits = ['annual', 'monthly'] as const satisfies readonly Interest['unit'][];
const interestBases = ['overdue', 'document'] as const satisfies readonly Interest['basis'][];

/** whose：谁付给谁（“客户多久付给我们”） */
export function TermSection({ form, set, whose }: Props & { whose: string }) {
  const { termType, termDays, termMonths, paymentDay, cutoffDay } = form;
  return (
    <FormSection title={'账期（' + whose + '）'} columns={termType === 'monthly' ? 4 : 2}>
      <FormField label="账期方式">
        <select
          value={termType}
          onChange={(e) => {
            const next = optionOf(termTypes, e.target.value);
            if (next) set({ termType: next });
          }}
        >
          <option value="none">没有账期（到期日留空）</option>
          <option value="monthly">压几个月，每月固定日付款</option>
          <option value="days">压若干天</option>
        </select>
      </FormField>
      {termType === 'none' && (
        <p className="fin-term-empty fin-term-none">到期日留空，不算逾期，也不进收付计划。</p>
      )}
      {termType === 'days' && (
        <FormField
          label="压多少天"
          required
          hint="填 0 是当天到期；不约定到期日请选“没有账期”。"
        >
          <UnitInput
            unit="天"
            type="number"
            min={0}
            required
            value={termDays}
            onChange={(e) => set({ termDays: e.target.value })}
          />
        </FormField>
      )}
      {termType === 'monthly' && (
        <>
          <FormField label="压几个月" required>
            <UnitInput
              unit="个月"
              type="number"
              min={0}
              required
              value={termMonths}
              onChange={(e) => set({ termMonths: e.target.value })}
            />
          </FormField>
          <FormField label="每月几号付" required>
            <UnitInput
              unit="号"
              type="number"
              min={1}
              max={31}
              required
              value={paymentDay}
              onChange={(e) => set({ paymentDay: e.target.value })}
            />
          </FormField>
          <FormField label="每月几号截止" hint="选填，截止日之后的单子算到下个月">
            <UnitInput
              unit="号"
              type="number"
              min={1}
              max={31}
              value={cutoffDay}
              onChange={(e) => set({ cutoffDay: e.target.value })}
            />
          </FormField>
        </>
      )}
    </FormSection>
  );
}

export function TaxCreditSection({ form, set }: Props) {
  const { taxRate, taxMode, creditLimit } = form;
  return (
    <FormSection title="税率和授信" hint="都可以不填。授信超额只提醒，不拦业务。" columns={3}>
      <FormField label="默认税率">
        <UnitInput
          unit="%"
          inputMode="decimal"
          value={taxRate}
          onChange={(e) => set({ taxRate: e.target.value })}
        />
      </FormField>
      <FormField label="默认口径">
        <select value={taxMode} onChange={(e) => set({ taxMode: e.target.value })}>
          <option value="">未选择</option>
          {taxModes.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="授信额度">
        <UnitInput
          unit="元"
          inputMode="decimal"
          value={creditLimit}
          onChange={(e) => set({ creditLimit: e.target.value })}
        />
      </FormField>
    </FormSection>
  );
}

export function InterestTerms({ form, set }: Props) {
  const { interest } = form;
  return (
    <FormSection title="压款利息" columns={4}>
      <FinCheck
        label="这个单位要算利息"
        hint="系统只给建议，人确认后才入账。"
        checked={!!interest}
        onChange={(on) =>
          set({
            interest: on ? { rate: '', unit: 'annual', basis: 'overdue', freeDays: 0 } : null,
          })
        }
      />
      {interest && (
        <>
          <FormField label="利率单位">
            <select
              aria-label="利率单位"
              value={interest.unit}
              onChange={(e) => {
                const unit = optionOf(interestUnits, e.target.value);
                if (unit) set({ interest: { ...interest, unit } });
              }}
            >
              <option value="annual">年利率</option>
              <option value="monthly">月利率</option>
            </select>
          </FormField>
          <FormField label="利率" required>
            <UnitInput
              unit="%"
              aria-label="利率"
              inputMode="decimal"
              required
              value={interest.rate}
              onChange={(e) => set({ interest: { ...interest, rate: e.target.value } })}
            />
          </FormField>
          <FormField label="从哪天起算">
            <select
              aria-label="起算"
              value={interest.basis}
              onChange={(e) => {
                const basis = optionOf(interestBases, e.target.value);
                if (basis) set({ interest: { ...interest, basis } });
              }}
            >
              <option value="overdue">到期日</option>
              <option value="document">单据日</option>
            </select>
          </FormField>
          <FormField label="免息天数">
            <UnitInput
              unit="天"
              type="number"
              aria-label="免息天数"
              min={0}
              value={interest.freeDays}
              onChange={(e) =>
                set({ interest: { ...interest, freeDays: num(e.target.value) } })
              }
            />
          </FormField>
        </>
      )}
    </FormSection>
  );
}
