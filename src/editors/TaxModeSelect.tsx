import { orderTaxModes } from '../../shared/core/index';

/**
 * 含税口径下拉：固定含税、未税、未明确三项（shared/core/domain.ts 的 orderTaxModes）。
 * blank 是空着那一项的叫法（明细写“同整单”、识别结果写“待确认”）；不给就没有空着这一项。
 * 原来写的是别的说法（库里旧的、识别出来的“不含税”这类）不猜着归并：照原样列一项“原来写的……（请改选）”，
 * 保存时由录入校验拦下要人改选。
 */
export default function TaxModeSelect({
  value,
  onChange,
  label,
  blank,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  blank?: string;
  disabled?: boolean;
}) {
  const now = value.trim();
  const other = now && !orderTaxModes.some((m) => m === now);
  return (
    <select aria-label={label} value={now} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(blank !== undefined || !now) && <option value="">{blank ?? '请选择'}</option>}
      {orderTaxModes.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {other && <option value={now}>{'原来写的“' + now + '”（请改选）'}</option>}
    </select>
  );
}
