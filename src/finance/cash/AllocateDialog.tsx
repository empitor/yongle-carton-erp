import { useMemo, useState } from 'react';
import { ManagementDialog, EditorFooter, FormMessage, FormSection, centsInput, toCents, yuan, notify, FormField, useAction, useLoad, loadingText } from '../../ui/index';
import { kindName } from './shared';
import { today } from '../../../shared/core/index';
import type { FinData } from '../fin-api';
import { allocateCashDocument, confirmCashDocument, readCashSuggestions } from './cash-api';
import type { CashDoc } from './CashPanel';

/** 建议核销的一笔往来 */
type Suggestion = FinData<'GET /finance/cash/documents/:id/suggestions'>['allocations'][number];
/** 窗口里的一行：建议的那笔，加勾没勾、输入框里的核销金额和优惠 */
type Line = Suggestion & { use: boolean; amountText: string; discountText: string };

/** 输入框里的金额转成分；没填或填错时算 0，只用来显示合计，提交时仍按原规则校验。 */
const safeCents = (text: string) => {
  try {
    return text.trim() ? toCents(text) : 0;
  } catch {
    return 0;
  }
};

/** 按约定的现结优惠一键填：优惠填约定的数，核销金额加上优惠（不超过未结） */
function OfferButton({ line, change }: { line: Line; change: (patch: Partial<Line>) => void }) {
  const offer = line.offer;
  if (!offer) return null;
  return (
    <button
      type="button"
      className="fin-link-button"
      disabled={!line.use}
      onClick={() =>
        change({
          discountText: centsInput(offer.amount),
          amountText: centsInput(Math.min(line.balance, line.amount + offer.amount)),
        })
      }
    >
      用 {offer.rate}%，省 {yuan(offer.amount)}
    </button>
  );
}

/** 建议核销的单子：勾选、改核销金额和优惠，按约定的现结优惠一键填。 */
function AllocateLines({ lines, change }: { lines: Line[]; change: (lines: Line[]) => void }) {
  const update = (i: number, patch: Partial<Line>) => change(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="line-table fin-alloc-table">
      <table>
        <thead>
          <tr>
            <th aria-label="选择" />
            <th>单据</th>
            <th>到期日</th>
            <th className="num">未结</th>
            <th className="num">核销 / 元</th>
            <th className="num">优惠 / 元</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.obligationId} className={l.use ? undefined : 'fin-line-off'}>
              <td className="fin-line-check">
                <input
                  type="checkbox"
                  aria-label={'核销 ' + (l.sourceNumber || l.description)}
                  checked={l.use}
                  onChange={(e) => update(i, { use: e.currentTarget.checked })}
                />
              </td>
              <td>
                {l.sourceNumber || l.description}
                <small>单据日 {l.date}</small>
              </td>
              <td>{l.dueDate || '没有账期'}</td>
              <td className="fin-line-amount">{yuan(l.balance)}</td>
              <td className="num">
                <input
                  aria-label="核销金额"
                  inputMode="decimal"
                  disabled={!l.use}
                  value={l.amountText}
                  onChange={(e) => update(i, { amountText: e.currentTarget.value })}
                />
              </td>
              <td className="num">
                <input
                  aria-label="优惠金额"
                  inputMode="decimal"
                  disabled={!l.use}
                  value={l.discountText}
                  onChange={(e) => update(i, { discountText: e.currentTarget.value })}
                />
                <OfferButton line={l} change={(patch) => update(i, patch)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 按账期约定的现结优惠（点了“用 x%”、核销金额也没改）不用写原因；自己填的优惠要写清楚为什么让。 */
function manualDiscount(l: Line) {
  const discount = safeCents(l.discountText);
  return discount > 0 && !(l.offer && discount === l.offer.amount && safeCents(l.amountText) === l.balance);
}

/** 要核销的几行转成正文：核销金额、优惠（分），有优惠又写了原因的带上原因 */
function allocationsOf(used: readonly Line[], reason: string) {
  return used.map((l) => {
    const discount = l.discountText.trim() ? toCents(l.discountText) : 0;
    return {
      obligationId: l.obligationId,
      version: l.version,
      amount: toCents(l.amountText),
      discount,
      ...(discount && reason.trim() ? { reason: reason.trim() } : {}),
    };
  });
}

/** 窗口底部那句：本次核销多少（只做显示），确认时可以先不核销 */
function footerNote(lines: Line[] | null, total: number, mode: 'confirm' | 'allocate') {
  if (lines?.length) return '本次核销 ' + yuan(total) + ' 元' + (mode === 'confirm' ? '；也可以先不核销，以后再做。' : '');
  return mode === 'confirm' ? '可以直接确认，以后有单子再核销。' : undefined;
}

/** 优惠原因：填了优惠才出现；不是约定的现结优惠时必填 */
function DiscountReason({ needed, reason, setReason }: { needed: boolean; reason: string; setReason: (v: string) => void }) {
  return (
    <FormSection title="优惠原因" columns={1}>
      <FormField
        label="为什么让这笔"
        required={needed}
        span="full"
        hint={needed ? '优惠不是账期里约定的现结优惠，要写清楚原因，比如质量扣款、对方抹零。' : '按账期约定的现结优惠，可以不写。'}
      >
        <input aria-label="优惠原因" maxLength={200} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
      </FormField>
    </FormSection>
  );
}

/** 核销窗口：系统按到期先后给建议，金额和优惠都可以改。确认收付款时也用它，可以先不核销。 */
export default function AllocateDialog({
  doc,
  mode,
  close,
}: {
  doc: CashDoc;
  mode: 'confirm' | 'allocate';
  close: () => void;
}) {
  // 打开窗口时取一次建议；改过的行记在 edited 里，没改之前就用建议
  const suggestions = useLoad(String(doc.id), () => readCashSuggestions(doc.id));
  const suggested = useMemo(
    (): Line[] | null =>
      suggestions.data
        ? suggestions.data.allocations.map((a) => ({
            ...a,
            use: true,
            amountText: centsInput(a.amount),
            discountText: '',
          }))
        : suggestions.error
          ? []
          : null,
    [suggestions.data, suggestions.error],
  );
  const [edited, setEdited] = useState<Line[] | null>(null);
  const lines = edited ?? suggested;
  const available = suggestions.data?.available ?? 0;
  const [reason, setReason] = useState('');
  const action = useAction();
  const used = (lines || []).filter((l) => l.use && l.amountText.trim());
  const total = used.reduce((n, l) => n + safeCents(l.amountText), 0);
  const needsReason = used.some(manualDiscount);
  const submit = () =>
    action.run(async () => {
      if (needsReason && !reason.trim()) throw new Error('填了约定以外的优惠，请写优惠原因。');
      const allocations = allocationsOf(used, reason);
      if (mode === 'confirm') await confirmCashDocument(doc, allocations);
      else {
        if (!allocations.length) throw new Error('请至少核销一笔。');
        await allocateCashDocument(doc, { date: today() < doc.date ? doc.date : today(), allocations });
      }
      close();
      const counted = allocations.length + ' 笔' + (doc.kind === 'payment' ? '应付' : '应收');
      notify(
        mode === 'confirm'
          ? kindName(doc.kind) + '已确认' + (allocations.length ? '，核销了 ' + counted + '。' : '。')
          : '已核销 ' + counted + '。',
      );
    });
  return (
    <ManagementDialog
      title={mode === 'confirm' ? '确认' + kindName(doc.kind) : '核销'}
      subtitle={[doc.party_name, yuan(doc.amount_cents) + ' 元', '可核销 ' + yuan(available) + ' 元']
        .filter(Boolean)
        .join(' · ')}
      size="lg"
      busy={action.busy}
      close={close}
      footer={
        <EditorFooter note={footerNote(lines, total, mode)}>
          <button type="button" className="secondary" onClick={close} disabled={action.busy}>
            取消
          </button>
          <button type="button" className="primary" disabled={action.busy || lines === null} onClick={() => void submit()}>
            {mode === 'confirm' ? '确认' : '核销'}
          </button>
        </EditorFooter>
      }
    >
      <div className="fin-ed">
        <FormMessage>{suggestions.error || action.error}</FormMessage>
        <FormSection
          title="核销哪几张单子"
          hint="核销金额含优惠：339 元的单子优惠 6.78 元，核销填 339，优惠填 6.78。"
          columns={1}
        >
          {lines === null ? (
            <p className="choice-list-empty" role="status">
              {loadingText()}
            </p>
          ) : lines.length === 0 ? (
            // 建议核销只取这笔钱日期及以前的单子（settlements.ts 的 suggest），提示照实说
            <p className="choice-list-empty">
              {(doc.kind === 'payment' ? '付款日 ' : '收款日 ') + doc.date + ' 及以前，这个单位没有未结清的单子。'}
            </p>
          ) : (
            <AllocateLines lines={lines} change={setEdited} />
          )}
        </FormSection>
        {used.some((l) => safeCents(l.discountText) > 0) && (
          <DiscountReason needed={needsReason} reason={reason} setReason={setReason} />
        )}
      </div>
    </ManagementDialog>
  );
}
