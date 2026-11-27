import { deliverySiteSnapshot } from '../../shared/business/index';
import { defaultCustomerSite, fieldLabel, type CustomerSite } from '../../shared/core/index';
import { FormField } from '../ui/index';

const shownKeys = ['contact', 'phone', 'address'] as const;
const shownLabel = (key: (typeof shownKeys)[number]) => fieldLabel(key, { record: 'delivery' });
/** 收货的三格只读：说清从哪来、去哪改；客户还没有厂区时说先去建 */
const siteHint = (hasSites: boolean) =>
  hasSites
    ? shownKeys.map(shownLabel).join('、') + '由所选厂区带出，要改请到客户档案里编辑厂区。'
    : '这个客户还没有厂区，先在客户档案里新增厂区。';

export default function DeliverySiteFields({ sites, siteId, change, disabled, title }: {
  sites: readonly CustomerSite[];
  siteId: number | null;
  change: (siteId: number) => void;
  disabled?: boolean;
  title?: string;
}) {
  const selected = siteId === null ? defaultCustomerSite(sites) : sites.find((s) => s.id === siteId);
  const info = deliverySiteSnapshot(selected);
  const aria = (label: string) => title ? title + ' ' + label : label;
  const label = fieldLabel('siteId');
  return (
    <>
      <FormField label={label} hint={siteHint(sites.length > 0)} span="full">
        <select aria-label={aria(label)} disabled={disabled || !sites.length} value={info.siteId ?? ''} onChange={(e) => change(Number(e.target.value))}>
          {!selected && <option value="">{sites.length ? '请选择收货厂区' : '尚未登记厂区'}</option>}
          {sites.map((site) => <option key={site.id} value={site.id}>{site.name}{site.isDefault ? '（默认）' : ''}</option>)}
        </select>
      </FormField>
      {shownKeys.map((key) => (
        <FormField key={key} label={shownLabel(key)} span={key === 'address' ? 'full' : undefined}>
          <input readOnly aria-label={aria(shownLabel(key))} value={info[key]} />
        </FormField>
      ))}
    </>
  );
}
