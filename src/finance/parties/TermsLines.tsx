import { Plus } from 'lucide-react';
import { FormSection, RowDelete } from '../../ui/index';
import { UnitInput } from '../fields';
import { num, optionOf, type Discount, type Installment } from './terms-form';

/* 账期窗口里两节可增删的明细：现结优惠、分期。 */

/** 优惠条件：下拉按这个先后列 */
const discountTypes = ['month', 'days', 'before_due'] as const satisfies readonly Discount['type'][];
const discountNames: Record<Discount['type'], string> = {
  month: '当月结清',
  days: '单据后若干天内付',
  before_due: '到期前提前若干天付',
};
/** 分期的到期规则：单据后天数、几个月后每月几号 */
type Rule = Installment['rule'];
/** 换分期方式时的初值 */
const newRule = (type: string): Rule =>
  type === 'days' ? { type: 'days', days: 0 } : { type: 'monthly', months: 0, paymentDay: 25 };

export function DiscountsSection({
  discounts,
  onChange,
}: {
  discounts: Discount[];
  onChange: (fn: (all: Discount[]) => Discount[]) => void;
}) {
  const update = (i: number, patch: Partial<Discount>) =>
    onChange((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <FormSection
      title="现结优惠"
      columns={1}
      extra={
        <button
          type="button"
          className="secondary"
          onClick={() => onChange((all) => [...all, { type: 'month', days: 0, rate: '' }])}
        >
          <Plus size={14} aria-hidden="true" />
          加一档优惠
        </button>
      }
    >
      {discounts.length ? (
        <div className="line-table fin-term-lines">
          <table>
            <thead>
              <tr>
                <th>什么时候付</th>
                <th className="num">天数</th>
                <th className="num">优惠比例</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {discounts.map((d, i) => (
                <tr key={i}>
                  <td>
                    <select
                      aria-label="优惠条件"
                      value={d.type}
                      onChange={(e) => {
                        const type = optionOf(discountTypes, e.target.value);
                        if (type) update(i, { type });
                      }}
                    >
                      {discountTypes.map((k) => (
                        <option key={k} value={k}>
                          {discountNames[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    {d.type === 'month' ? (
                      <span className="fin-term-empty">—</span>
                    ) : (
                      <UnitInput
                        unit="天"
                        type="number"
                        aria-label="天数"
                        min={0}
                        value={d.days}
                        onChange={(e) => update(i, { days: num(e.target.value) })}
                      />
                    )}
                  </td>
                  <td className="num">
                    <UnitInput
                      unit="%"
                      aria-label="优惠比例"
                      inputMode="decimal"
                      required
                      value={d.rate}
                      onChange={(e) => update(i, { rate: e.target.value })}
                    />
                  </td>
                  <td>
                    <RowDelete
                      label={'删除第 ' + (i + 1) + ' 档优惠'}
                      onClick={() => onChange((all) => all.filter((_, j) => j !== i))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fin-term-empty">没有现结优惠。</p>
      )}
    </FormSection>
  );
}

/** 一期怎么算到期：单据后几天，或几个月后每月几号 */
function RuleInputs({ rule, change }: { rule: Rule; change: (rule: Rule) => void }) {
  if (rule.type === 'days')
    return (
      <span className="fin-term-rule">
        单据后
        <input
          type="number"
          aria-label="天数"
          min={0}
          value={rule.days}
          onChange={(e) => change({ ...rule, days: num(e.target.value) })}
        />
        天
      </span>
    );
  return (
    <span className="fin-term-rule">
      <input
        type="number"
        aria-label="月数"
        min={0}
        value={rule.months}
        onChange={(e) => change({ ...rule, months: num(e.target.value) })}
      />
      个月后
      <input
        type="number"
        aria-label="每月几号"
        min={1}
        max={31}
        value={rule.paymentDay}
        onChange={(e) => change({ ...rule, paymentDay: num(e.target.value) })}
      />
      号
    </span>
  );
}

export function InstallmentsSection({
  installments,
  onChange,
}: {
  installments: Installment[];
  onChange: (fn: (all: Installment[]) => Installment[]) => void;
}) {
  const update = (i: number, patch: Partial<Installment>) =>
    onChange((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <FormSection
      title="分期"
      hint="一般不用。比例合计须为 100%。"
      columns={1}
      extra={
        <button
          type="button"
          className="secondary"
          onClick={() => onChange((all) => [...all, { rate: '', rule: { type: 'days', days: 0 } }])}
        >
          <Plus size={14} aria-hidden="true" />
          加一期
        </button>
      }
    >
      {installments.length ? (
        <div className="line-table fin-term-lines">
          <table>
            <thead>
              <tr>
                <th>期</th>
                <th className="num">比例</th>
                <th>怎么算到期</th>
                <th>时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {installments.map((p, i) => (
                <tr key={i}>
                  <td className="fin-term-index">第 {i + 1} 期</td>
                  <td className="num">
                    <UnitInput
                      unit="%"
                      aria-label="分期比例"
                      inputMode="decimal"
                      required
                      value={p.rate}
                      onChange={(e) => update(i, { rate: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label="分期方式"
                      value={p.rule.type}
                      onChange={(e) => update(i, { rule: newRule(e.target.value) })}
                    >
                      <option value="days">单据后天数</option>
                      <option value="monthly">几个月后每月几号</option>
                    </select>
                  </td>
                  <td>
                    <RuleInputs rule={p.rule} change={(rule) => update(i, { rule })} />
                  </td>
                  <td>
                    <RowDelete
                      label={'删除第 ' + (i + 1) + ' 期'}
                      onClick={() => onChange((all) => all.filter((_, j) => j !== i))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fin-term-empty">不分期，整笔一个到期日。</p>
      )}
    </FormSection>
  );
}
