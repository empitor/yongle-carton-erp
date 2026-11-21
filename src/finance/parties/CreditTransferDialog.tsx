import { useId, useState } from 'react';
import {
  ManagementDialog,
  EditorFooter,
  FormGroup,
  FormMessage,
  FormSection,
  Loading,
  centsInput,
  toCents,
  yuan,
  notify,
  FormField,
  useAction,
} from '../../ui/index';
import { obligationSource, type Kind } from './shared';
import { today } from '../../../shared/core/index';
import { UnitInput } from '../fields';
import { useFinRead } from '../fin-api';
import { partyObligations, transferCredit, type ObligationRow } from './parties-api';

/** 多付分在几张收付款单上时，提示里写明每张转出多少 */
const partsText = (parts: { amount: number }[]) =>
  parts.length > 1
    ? '，分 ' + parts.length + ' 张收付款单转出：' + parts.map((x) => yuan(x.amount)).join('、') + ' 元'
    : '';

/**
 * 多付转抵：把这笔多付的部分转去抵同一单位还没结清的另一笔，不用先撤销核销。
 * 多付分在几张收付款单上时服务端按张拆开，每张一张往来对冲凭证，撤销时在收付款单的核销记录里逐张撤。
 */
export default function CreditTransferDialog({
  kind,
  from,
  close,
  done,
}: {
  kind: Kind;
  from: ObligationRow;
  close: () => void;
  done: () => void;
}) {
  const { data, error: loadError } = useFinRead(partyObligations(kind, from.party_id));
  // 红字冲销的两笔不能被抵（余额已经按两笔合起来算成 0，这里再按冲销关系排除一次）；
  // 凭证还没记账的也抵不了（服务端会拒），不列出来
  const targets = (data?.rows || []).filter(
    (r) =>
      r.id !== from.id &&
      !r.reversal_state &&
      Number(r.balance) > 0 &&
      (!r.voucher_id || r.voucher_status === 'posted'),
  );
  const credit = -Number(from.balance);
  const formId = useId();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const action = useAction();
  const busy = action.busy;
  // 默认抵第一笔，金额取多付和那笔未结里较小的
  const target = targets.find((r) => String(r.id) === to) ?? targets[0];
  const amountText = amount ?? centsInput(Math.min(credit, Number(targets[0]?.balance ?? credit)));
  const submit = () => {
    if (!target) return close();
    void action.run(async () => {
      const result = await transferCredit({
        date,
        amount: toCents(amountText),
        from: { id: from.id, version: from.version },
        to: { id: target.id, version: target.version },
      });
      done();
      notify('已转抵 ' + yuan(result.amount) + ' 元到 ' + obligationSource(target, '手工记的一笔') + partsText(result.parts) + '。');
    });
  };
  const empty = data && !targets.length;
  return (
    <ManagementDialog
      title="多付转抵"
      subtitle={[
        obligationSource(from, '手工记的一笔'),
        from.party_name,
        '多付 ' + yuan(credit) + ' 元',
      ].join(' · ')}
      size="md"
      busy={busy}
      close={close}
      footer={
        <EditorFooter
          note={
            target
              ? '多付在几张收付款单上时按张拆开，每张一张往来对冲凭证，总账余额不变。'
              : undefined
          }
        >
          {empty ? (
            <button type="button" className="primary" onClick={close}>
              知道了
            </button>
          ) : (
            <>
              <button type="button" className="secondary" onClick={close} disabled={busy}>
                取消
              </button>
              <button type="submit" form={formId} className="primary" disabled={busy || !data}>
                {busy ? '处理中…' : '确认转抵'}
              </button>
            </>
          )}
        </EditorFooter>
      }
    >
      <form
        id={formId}
        className="fin-form fin-ed"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <FormMessage>{loadError || action.error}</FormMessage>
        {!data ? (
          <Loading what="这个单位的往来" />
        ) : empty ? (
          <FormMessage tone="info">
            这个单位没有还没结清的往来可以抵。可以等下次
            {kind === 'payable' ? '进货' : '送货'}后再转抵，或者让对方退款。
          </FormMessage>
        ) : (
          <>
            <FormSection title="抵到哪一笔" columns={1}>
              <FormGroup>
                <div className="choice-list fin-choices" role="radiogroup" aria-label="抵到哪一笔">
                  {targets.map((r) => (
                    <label key={r.id} className={target?.id === r.id ? 'selected' : undefined}>
                      <input
                        type="radio"
                        name={formId + '-to'}
                        checked={target?.id === r.id}
                        onChange={() => setTo(String(r.id))}
                      />
                      <span>
                        {obligationSource(r, '手工记的一笔')} · {r.date}
                      </span>
                      <small>未结 {yuan(r.balance)} 元</small>
                    </label>
                  ))}
                </div>
              </FormGroup>
            </FormSection>
            <FormSection title="转抵多少">
              <FormField
                label="转抵金额"
                required
                hint={'最多 ' + yuan(Math.min(credit, Number(target?.balance ?? credit))) + ' 元'}
              >
                <UnitInput
                  unit="元"
                  inputMode="decimal"
                  required
                  value={amountText}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </FormField>
              <FormField label="日期" required>
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </FormField>
            </FormSection>
          </>
        )}
      </form>
    </ManagementDialog>
  );
}
