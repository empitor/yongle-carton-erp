import { MAX_TAX_PERCENT, TAX_PERCENT_STEP, fieldLabel, fieldTitle, orderTaxOriginal } from '../../shared/core/index';
import { FormField } from '../ui/index';

export default function OrderTaxRateField({ line, tax, change }: {
  line?: number;
  tax: { taxRate: string; taxText?: string };
  change: (value: string) => void;
}) {
  const place = line === undefined ? undefined : { record: 'orders', parent: 'lines' };
  const name = fieldTitle('taxRate', place);
  return (
    <FormField label={name} hint={orderTaxOriginal(tax.taxText, tax.taxRate)}>
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
