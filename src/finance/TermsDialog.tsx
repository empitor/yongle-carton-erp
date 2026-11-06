import { useEffect, useState } from 'react';
import ManagementDialog from '../ManagementDialog';
import { centsText, finGet, finSend, taxModes, toCents, useParties } from './kit';
import Combobox from '../ui/Combobox';

type Discount = { type: 'month' | 'days' | 'before_due'; days: number; rate: string };
type Installment = {
  rate: string;
  rule:
    | { type: 'days'; days: number }
    | { type: 'monthly'; months: number; paymentDay: number; cutoffDay?: number };
};
type Interest = {
  rate: string;
  unit: 'annual' | 'monthly';
  basis: 'overdue' | 'document';
  freeDays: number;
};
const discountNames = {
  month: '当月结清',
  days: '单据后若干天内付',
  before_due: '到期前提前若干天付',
};

/** 账期窗口：压货款、默认税率、现结优惠、分期、保证金、压款利息都在这里调。比例全部由人填。 */
export default function TermsDialog({
  kind,
  partyId: fixedParty,
  close,
}: {
  kind: 'customer' | 'supplier';
  partyId?: string;
  close: () => void;
}) {
  const parties = useParties(kind);
  const [partyId, setPartyId] = useState(fixedParty || '');
  const [loaded, setLoaded] = useState<any>(undefined);
  const [loadedFor, setLoadedFor] = useState('');
  const [termType, setTermType] = useState<'days' | 'monthly' | 'none'>('none');
  const [termDays, setTermDays] = useState('');
  const [termMonths, setTermMonths] = useState('');
  const [paymentDay, setPaymentDay] = useState('');
  const [cutoffDay, setCutoffDay] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [taxMode, setTaxMode] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [deposits, setDeposits] = useState(false);
  const [interest, setInterest] = useState<Interest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!partyId) return;
    let active = true;
    finGet('/party-terms/' + kind + '/' + partyId)
      .then((t) => {
        if (!active) return;
        setLoaded(t);
        setLoadedFor(partyId);
        setTermType(!t ? 'none' : t.term_type === 'monthly' ? 'monthly' : 'days');
        setTermDays(t ? String(t.term_days ?? '') : '');
        setTermMonths(t?.term_months != null ? String(t.term_months) : '');
        setPaymentDay(t?.payment_day != null ? String(t.payment_day) : '');
        setCutoffDay(t?.cutoff_day != null ? String(t.cutoff_day) : '');
        setTaxRate(t?.tax_rate ?? '');
        setTaxMode(t?.tax_mode ?? '');
        setCreditLimit(centsText(t?.credit_limit));
        setDiscounts(t?.options?.discounts ?? []);
        setInstallments(t?.options?.installments ?? []);
        setDeposits(!!t?.options?.deposits);
        setInterest(t?.options?.interest ?? null);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [kind, partyId]);
  const whose = kind === 'customer' ? '客户压我们' : '我们压供应商';
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!partyId) throw new Error('请选择往来单位。');
      if (termType === 'none' && !taxRate && !discounts.length && !installments.length && !interest)
        throw new Error('还没填写任何规则。');
      const body: Record<string, unknown> =
        termType === 'monthly'
          ? {
              termType,
              termMonths: Number(termMonths),
              paymentDay: Number(paymentDay),
              cutoffDay: cutoffDay ? Number(cutoffDay) : null,
            }
          : { termType: 'days', termDays: termType === 'none' ? 0 : Number(termDays) };
      await finSend('PUT', '/party-terms/' + kind + '/' + partyId, {
        ...body,
        taxRate: taxRate.trim() || null,
        taxMode: taxMode || null,
        creditLimit: creditLimit.trim() ? toCents(creditLimit) : null,
        options: { discounts, installments, deposits, interest },
        ...(loaded ? { version: loaded.version } : {}),
      });
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <ManagementDialog title="账期和优惠" busy={busy} close={close}>
      <form className="fin-form fin-wide" onSubmit={save}>
        <p className="form-intro">
          只影响之后的新单据。已有单据的到期日保持不变，要改请用“按新账期重算”。这里的比例都由你填，系统没有内置数字。
        </p>
        <div className="form-grid">
          <label className="field wide">
            <span>{kind === 'customer' ? '客户' : '供应商'} *</span>
            <Combobox
              ariaLabel="往来单位"
              required
              disabled={!!fixedParty}
              value={partyId}
              options={parties}
              onChange={setPartyId}
            />
          </label>
        </div>
        {/* 读到这个单位的现有规则之前不让填，免得读回来盖掉刚填的内容 */}
        <fieldset className="fin-plain" disabled={!partyId || loadedFor !== partyId}>
        <div className="form-grid">
          <label className="field">
            <span>压货款方式（{whose}）</span>
            <select
              value={termType}
              onChange={(e) => setTermType(e.target.value as typeof termType)}
            >
              <option value="none">没有约定（到期日留空）</option>
              <option value="monthly">压几个月，每月固定日付款</option>
              <option value="days">压若干天</option>
            </select>
          </label>
          {termType === 'days' && (
            <label className="field">
              <span>压多少天 *</span>
              <input
                type="number"
                min={0}
                required
                value={termDays}
                onChange={(e) => setTermDays(e.target.value)}
              />
            </label>
          )}
          {termType === 'monthly' && (
            <>
              <label className="field">
                <span>压几个月 *</span>
                <input
                  type="number"
                  min={0}
                  required
                  value={termMonths}
                  onChange={(e) => setTermMonths(e.target.value)}
                />
              </label>
              <label className="field">
                <span>每月几号付 *</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  required
                  value={paymentDay}
                  onChange={(e) => setPaymentDay(e.target.value)}
                />
              </label>
              <label className="field">
                <span>每月几号截止（选填）</span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={cutoffDay}
                  onChange={(e) => setCutoffDay(e.target.value)}
                />
                <small className="fin-hint">截止日之后的单子算到下个月。</small>
              </label>
            </>
          )}
          <label className="field">
            <span>默认税率 %（选填）</span>
            <input value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
          </label>
          <label className="field">
            <span>默认口径（选填）</span>
            <select value={taxMode} onChange={(e) => setTaxMode(e.target.value)}>
              <option value="">未选择</option>
              {taxModes.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>授信额度 / 元（选填）</span>
            <input value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
            <small className="fin-hint">超额只提醒，不拦业务。</small>
          </label>
        </div>

        <div className="fin-subform">
          <h3>现结优惠</h3>
          {discounts.map((d, i) => {
            const update = (patch: Partial<Discount>) =>
              setDiscounts((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div className="fin-subform-row" key={i}>
                <select
                  aria-label="优惠条件"
                  style={{ width: 180 }}
                  value={d.type}
                  onChange={(e) => update({ type: e.target.value as Discount['type'] })}
                >
                  {Object.entries(discountNames).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
                {d.type !== 'month' && (
                  <>
                    <input
                      type="number"
                      aria-label="天数"
                      min={0}
                      value={d.days}
                      onChange={(e) => update({ days: num(e.target.value) })}
                    />
                    天
                  </>
                )}
                优惠
                <input
                  aria-label="优惠比例"
                  required
                  value={d.rate}
                  onChange={(e) => update({ rate: e.target.value })}
                />
                %
                <button
                  type="button"
                  onClick={() => setDiscounts((all) => all.filter((_, j) => j !== i))}
                >
                  删除
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setDiscounts((all) => [...all, { type: 'month', days: 0, rate: '' }])}
          >
            加一档优惠
          </button>
        </div>

        <div className="fin-subform">
          <h3>分期（比例合计须为 100%，一般不用）</h3>
          {installments.map((p, i) => {
            const update = (patch: Partial<Installment>) =>
              setInstallments((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            const rule = p.rule as any;
            return (
              <div className="fin-subform-row" key={i}>
                第 {i + 1} 期
                <input
                  aria-label="分期比例"
                  required
                  value={p.rate}
                  onChange={(e) => update({ rate: e.target.value })}
                />
                %
                <select
                  aria-label="分期方式"
                  value={rule.type}
                  onChange={(e) =>
                    update({
                      rule:
                        e.target.value === 'days'
                          ? { type: 'days', days: 0 }
                          : { type: 'monthly', months: 0, paymentDay: 25 },
                    })
                  }
                >
                  <option value="days">单据后天数</option>
                  <option value="monthly">几个月后每月几号</option>
                </select>
                {rule.type === 'days' ? (
                  <>
                    <input
                      type="number"
                      aria-label="天数"
                      min={0}
                      value={rule.days}
                      onChange={(e) => update({ rule: { ...rule, days: num(e.target.value) } })}
                    />
                    天
                  </>
                ) : (
                  <>
                    <input
                      type="number"
                      aria-label="月数"
                      min={0}
                      value={rule.months}
                      onChange={(e) => update({ rule: { ...rule, months: num(e.target.value) } })}
                    />
                    个月后
                    <input
                      type="number"
                      aria-label="每月几号"
                      min={1}
                      max={31}
                      value={rule.paymentDay}
                      onChange={(e) =>
                        update({ rule: { ...rule, paymentDay: num(e.target.value) } })
                      }
                    />
                    号
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setInstallments((all) => all.filter((_, j) => j !== i))}
                >
                  删除
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() =>
              setInstallments((all) => [...all, { rate: '', rule: { type: 'days', days: 0 } }])
            }
          >
            加一期
          </button>
        </div>

        <div className="fin-subform">
          <h3>压款利息</h3>
          <label className="fin-subform-row fin-check">
            <input
              type="checkbox"
              checked={!!interest}
              onChange={(e) =>
                setInterest(
                  e.target.checked
                    ? { rate: '', unit: 'annual', basis: 'overdue', freeDays: 0 }
                    : null,
                )
              }
            />
            这个单位要算利息（系统只给建议，人确认后才入账）
          </label>
          {interest && (
            <div className="fin-subform-row">
              <select
                aria-label="利率单位"
                value={interest.unit}
                onChange={(e) =>
                  setInterest({ ...interest, unit: e.target.value as Interest['unit'] })
                }
              >
                <option value="annual">年利率</option>
                <option value="monthly">月利率</option>
              </select>
              <input
                aria-label="利率"
                required
                value={interest.rate}
                onChange={(e) => setInterest({ ...interest, rate: e.target.value })}
              />
              %，从
              <select
                aria-label="起算"
                style={{ width: 120 }}
                value={interest.basis}
                onChange={(e) =>
                  setInterest({ ...interest, basis: e.target.value as Interest['basis'] })
                }
              >
                <option value="overdue">到期日</option>
                <option value="document">单据日</option>
              </select>
              起算，免息
              <input
                type="number"
                aria-label="免息天数"
                min={0}
                value={interest.freeDays}
                onChange={(e) => setInterest({ ...interest, freeDays: num(e.target.value) })}
              />
              天
            </div>
          )}
        </div>

        <div className="fin-subform">
          <h3>保证金</h3>
          <label className="fin-subform-row fin-check">
            <input
              type="checkbox"
              checked={deposits}
              onChange={(e) => setDeposits(e.target.checked)}
            />
            这个单位有保证金往来（只作标记，金额在“保证金”页签录入）
          </label>
        </div>

        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '处理中…' : '保存'}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
