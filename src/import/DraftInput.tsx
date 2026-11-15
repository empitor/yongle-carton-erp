import { DimensionUnitSelect } from '../editors/index';
import { dimensionKeys, parseDimension, convertDimension, normalizeDimensionUnit } from '../../shared/core/index';
import { fieldLabels, type DraftField, type LineField, type OrderDraft, type headerFields } from '../../shared/import/index';
import { DraftText as WrappedText } from './DraftUI';

/** 识别结果里的一栏：单头的或明细的 */
export type DraftKey = (typeof headerFields)[number] | LineField;
type DraftLine = OrderDraft['lines'][number];
/** 改一栏：明细的带明细编号 */
export type ChangeField = (k: string, v: string, line?: string) => void;

/** 换尺寸单位：已经填的长宽高按新单位换算后一起改；尺寸不是有效正数时说清楚，不换 */
function DimensionInput({
  field,
  line,
  index,
  locked,
  change,
  setError,
}: {
  field: DraftField;
  line: DraftLine;
  index: number;
  locked: boolean;
  change: ChangeField;
  setError: (message: string) => void;
}) {
  return (
    <DimensionUnitSelect
      label={'明细' + (index + 1) + ' 尺寸单位'}
      unit={field.value}
      disabled={locked}
      hasValues={dimensionKeys.some((k) => !!line.fields[k].value)}
      onChange={(to) => {
        try {
          const from = normalizeDimensionUnit(field.value);
          const values =
            from && to
              ? dimensionKeys.map((k) => [k, convertDimension(parseDimension(line.fields[k].value), from, to)] as const)
              : [];
          for (const [k, v] of values) change(k, v === null ? '' : String(v), line.id);
          change('dimensionUnit', to || '', line.id);
          setError('');
        } catch {
          setError('当前尺寸不是有效正数，请修正或清空后再切换单位。');
        }
      }}
    />
  );
}

/**
 * 识别结果的一栏怎么改：明细的名称、规格、备注用会自己长高的多行框，尺寸单位用单位下拉（换单位时换算尺寸），
 * 别的用单行框。拿不准的、助手改过的标出来。
 */
export function DraftInput({
  k,
  field,
  line,
  locked,
  change,
  setDimensionError,
}: {
  k: DraftKey;
  field: DraftField;
  /** 明细的一栏：哪一行、第几行 */
  line?: { line: DraftLine; index: number };
  locked: boolean;
  change: ChangeField;
  setDimensionError: (message: string) => void;
}) {
  if (k === 'dimensionUnit' && line)
    return (
      <DimensionInput
        field={field}
        line={line.line}
        index={line.index}
        locked={locked}
        change={change}
        setError={setDimensionError}
      />
    );
  const lineId = line?.line.id;
  const label = (line ? '明细' + (line.index + 1) + ' ' : '') + fieldLabels[k];
  return (
    <span
      className={
        'aii-field' +
        (field.certainty === 'needs-review' ? ' is-uncertain' : '') +
        (field.editedBy === 'assistant' ? ' is-assistant-edit' : '')
      }
    >
      {line && ['productName', 'specification', 'notes'].includes(k) ? (
        <WrappedText label={label} field={field} locked={locked} change={(v) => change(k, v, lineId)} />
      ) : (
        <input
          aria-label={label}
          title={field.note || ''}
          disabled={locked}
          value={field.value || ''}
          placeholder="待确认"
          onChange={(e) => change(k, e.target.value, lineId)}
        />
      )}
    </span>
  );
}
