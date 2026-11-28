import { useState } from 'react';
import { Hint, Section, notify, useAction, FormField } from '../../ui/index';
import { useFinPerms } from '../fin-api';
import { resolveEventTax, type ResolveLine } from './tax-api';
import { taxModeOptions } from '../fields';
import { definiteTaxModes, financeTaxRateReady, legacyTaxMode, UNSPECIFIED_TAX_MODE } from '../../../shared/finance/index';
import { plainPrice, snapshotModeOriginal } from '../../../shared/core/index';
import { readSourceDetail, type SourceLine, type SourceRow } from '../source-detail-view';
import { unreadRateText } from '../SourceDetail';

/** 已经填过的口径：旧写法“不含税”按“未税”算，认不出的（包括“未明确”）空着让人选 */
function modeOf(mode: string) {
  if (mode === legacyTaxMode.written) return legacyTaxMode.means;
  return definiteTaxModes.find((m) => m === mode) ?? '';
}
/** 补税率表一行的预填：交给服务端的（line）、金额框里显示的、税率和口径格子下面的一句 */
type ResolveStart = { line: ResolveLine; amount: string; rateHint: string; modeHint: string };
/**
 * 补税率表里的一行：先填上补过的（financialLines）或单据明细上已有的。
 * - 金额：交给服务端的照原来的精确金额（line.exact，七位小数）；框里显示去掉末尾多余的 0、至少两位小数（amount）。
 *   人没改金额就照精确金额提交，补完一分不变。
 * - 税率：照补扫的认法、按从哪来（source）判断（financeTaxRateReady：往来单位默认的照往来条款，0.5 就是 0.5%；
 *   单据抄来的照订单认法、只认半角）：认得出的照填（去掉末尾 %，框的单位是 %）；认不出的框里空着，rateHint 写在格子下面
 *   （和单据明细的税率格同一个说法），让人对照原件填，不然人不改就点保存，“0.13”会照 0.13% 记下去。
 * - 口径：认得出的照填（旧写法“不含税”按“未税”）；认不出的（“口径：含税价”这类原话、升级前的别的写法）空着让人选，
 *   modeHint 写出原来写的是什么（不带“口径：”前缀，snapshotModeOriginal）；没写和“未明确”本来就是没定，空着不写。
 */
export function resolveLine(l: SourceLine, source: string | null | undefined): ResolveStart {
  const exact = l.exact ?? '',
    raw = (l.rate ?? l.taxRate ?? '').trim(),
    ready = financeTaxRateReady(raw, source),
    rawMode = (l.mode ?? l.taxMode ?? '').trim(),
    mode = modeOf(rawMode);
  return {
    line: { exact, rate: ready ? raw.replace(/%$/, '') : '', mode },
    amount: exact ? plainPrice(exact, 2) : '',
    rateHint: ready || !raw ? '' : unreadRateText(raw),
    modeHint: mode || !rawMode || rawMode === UNSPECIFIED_TAX_MODE ? '' : unreadRateText(snapshotModeOriginal(rawMode)),
  };
}

/** 单张补税率：逐行填税率和口径。缺价格或数量时也在这里补金额。放在台账详情的最后一节。 */
export default function ResolveTax({ row, done }: { row: SourceRow; done: () => void }) {
  const perms = useFinPerms();
  const detail = readSourceDetail(row.detail);
  // 补过的财务行带着每行税率从哪来（taxSource）；没有财务行（缺价格、数量）时取单据明细，税率就是单据抄来的
  const [start] = useState(() =>
    detail.financialLines
      ? detail.financialLines.map((l, i) => resolveLine(l, detail.taxSource?.[i]?.rate))
      : (detail.doc?.lines ?? []).map((l) => resolveLine(l, 'line')),
  );
  const [lines, setLines] = useState(() => start.map((s) => s.line));
  // 金额框里显示的字：没改时是精确金额去掉末尾 0 的样子，改了就是人填的（同时作为提交的金额）
  const [amounts, setAmounts] = useState(() => start.map((s) => s.amount));
  const [evidence, setEvidence] = useState('');
  const action = useAction();
  const eventId = row.id;
  if (eventId === null || !perms.edit) return null;
  // 财务行和单据明细一一对应时，行号后面带上品名，方便对照
  const docLines = detail.doc?.lines ?? [];
  const names =
    docLines.length === lines.length
      ? docLines.map((l) => l.productName || l.item?.name || l.name)
      : [];
  const save = () =>
    action.run(async () => {
      await resolveEventTax(eventId, {
        ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
        lines,
      });
      done();
      notify('已补好 ' + (row.number || '这张单据') + ' 的税率。');
    });
  return (
    <Section title="补税率">
      <p className="fb-section-hint">只改财务记录，不动送货单、到货单原件，也不影响理论盈亏。</p>
      <div className="line-table fb-no-tail">
        <table>
          <thead>
            <tr>
              <th>行</th>
              <th className="num">金额（元）</th>
              <th className="num">税率（%）</th>
              <th>口径</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const update = (patch: Partial<ResolveLine>) =>
                setLines((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <tr key={i}>
                  <td className="fb-cell-text">
                    第 {i + 1} 行{names[i] && <small>{names[i]}</small>}
                  </td>
                  <td className="num">
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行金额'}
                      inputMode="decimal"
                      value={amounts[i] ?? ''}
                      onChange={(e) => {
                        const typed = e.target.value;
                        setAmounts((all) => all.map((x, j) => (j === i ? typed : x)));
                        update({ exact: typed });
                      }}
                    />
                  </td>
                  <td className="num fb-rate">
                    <input
                      aria-label={'第 ' + (i + 1) + ' 行税率'}
                      inputMode="decimal"
                      value={l.rate}
                      onChange={(e) => update({ rate: e.target.value })}
                    />
                    {start[i]?.rateHint && <small>{start[i].rateHint}</small>}
                  </td>
                  <td className="fb-mode">
                    <select
                      aria-label={'第 ' + (i + 1) + ' 行口径'}
                      value={l.mode}
                      onChange={(e) => update({ mode: e.target.value })}
                    >
                      <option value="">请选择</option>
                      {taxModeOptions.map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {start[i]?.modeHint && <small>{start[i].modeHint}</small>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="fb-resolve-evidence">
        <FormField label="依据" hint="选填，例如合同约定或对方开的票">
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </FormField>
      </div>
      {action.error && <Hint tone="danger">{action.error}</Hint>}
      <div className="fb-section-actions">
        <button
          type="button"
          className="secondary"
          disabled={action.busy}
          onClick={() => setLines((all) => all.map((x) => ({ ...x, rate: '0', mode: '未税' })))}
        >
          填成无税 / 不开票
        </button>
        <button
          type="button"
          className="primary"
          disabled={action.busy || lines.some((l) => !l.exact || !l.mode || l.rate === '')}
          onClick={save}
        >
          {action.busy ? '处理中…' : '保存税率'}
        </button>
      </div>
    </Section>
  );
}
