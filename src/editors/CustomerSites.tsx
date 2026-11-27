import { useId } from 'react';
import { blankCustomerSite, fieldLabel, type CustomerSiteInput } from '../../shared/core/index';
import { FormField, FormSection, RowDelete } from '../ui/index';

const contactKeys = ['contact', 'phone', 'address', 'notes'] as const;

export default function CustomerSites({ sites, change }: {
  sites: readonly CustomerSiteInput[];
  change: (sites: CustomerSiteInput[]) => void;
}) {
  const radioGroup = useId();
  const update = (index: number, patch: Partial<CustomerSiteInput>) =>
    change(sites.map((site, i) => i === index ? { ...site, ...patch } : site));
  const remove = (index: number) => {
    const remaining = sites.filter((_, i) => i !== index);
    change(remaining.length === 1 ? [{ ...remaining[0], isDefault: true }] : remaining);
  };
  return (
    <FormSection title={fieldLabel('sites')} columns={1}>
      {sites.map((site, index) => {
        const label = '厂区 ' + (index + 1);
        return (
          <div className="line-card" key={site.id ?? 'new-' + index}>
            <header>
              <label className="sales-site-default">
                <input
                  type="radio"
                  name={radioGroup}
                  aria-label={label + ' 设为默认'}
                  checked={site.isDefault}
                  onChange={() => change(sites.map((s, i) => ({ ...s, isDefault: i === index })))}
                />
                默认
              </label>
              <RowDelete label={'删除' + label} onClick={() => remove(index)} />
            </header>
            <div className="ed-grid cols-2">
              <FormField label={fieldLabel('name', { parent: 'sites' })} required span="full">
                <input aria-label={label + ' 名称'} required value={site.name} onChange={(e) => update(index, { name: e.target.value })} />
              </FormField>
              {contactKeys.map((key) => (
                <FormField key={key} label={fieldLabel(key)} span={key === 'address' || key === 'notes' ? 'full' : undefined}>
                  <input aria-label={label + ' ' + fieldLabel(key)} value={site[key]} onChange={(e) => update(index, { [key]: e.target.value })} />
                </FormField>
              ))}
            </div>
          </div>
        );
      })}
      <div>
        <button
          type="button" className="secondary"
          onClick={() => change([...sites, { ...blankCustomerSite(), isDefault: sites.length === 0 }])}
        >
          新增厂区
        </button>
      </div>
    </FormSection>
  );
}
