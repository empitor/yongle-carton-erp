import { MAX_TAX_PERCENT, TAX_PERCENT_STEP, fieldLabel, fieldTitle, orderTaxRateHint } from '../../shared/core/index';
import { FormField } from '../ui/index';

export default function OrderTaxRateField({ line, tax, change }: {
  line?: number;
  /** 这一层（整单或明细）现在填的税率和原件写法：下面那句只说税率（口径那句在含税口径格下面） */
  tax: { taxRate: string; taxText?: string };
  change: (value: string) => void;
}) {
  const place = line === undefined ? undefined : { record: 'orders', parent: 'lines' };
  const name = fieldTitle('taxRate', place);
  return (
    <FormField label={name} hint={orderTaxRateHint(tax.taxText, tax.taxRate)}>
      <input
        aria-label={line === undefined ? name : '第 ' + line + ' 行' + name}
        data-field={fieldLabel('taxRate', place)}
        type="number"
        min={0}
        max={MAX_TAX_PERCENT}
        step={TAX_PERCENT_STEP}
        placeholder={line === undefined ? '例如 13' : '不填按整单'}
        value={tax.taxRate}
        onChange={(e) => change(e.target.value)}
      />
    </FormField>
  );
}
