import { useId } from 'react';
import { blankCustomerSite, fieldLabel, type CustomerSiteInput } from '../../shared/core/index';
import { FormField, FormMessage, FormSection, RowDelete } from '../ui/index';

const contactKeys = ['contact', 'phone', 'address', 'notes'] as const;
/** 厂区那节只有一句说明：客户自己的联系方式和厂区各改各的（新客户没加厂区时服务端按联系方式建一个，以后不再同步） */
const SITES_APART = '客户的联系方式和厂区各改各的';
/** 有存过的厂区时接着说：改了它的资料，用着它的待送货单跟着更新（服务端 server/flow/rules/site-edits.ts），别的状态不变。改客户名称那句在客户名称格 */
const SITE_SYNC = '改了已存厂区的资料，用着它的待送货单会跟着更新，已出库、已取消、已撤销的不变';

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
  // 有两个以上厂区就要恰好一个默认：删掉了默认的那个时提醒人重新指定，不替人选（服务端同一条校验：customer-sites.ts）
  const needDefault = sites.length > 1 && !sites.some((s) => s.isDefault);
  // 新建的厂区还没有送货单，不说跟着更新；没有默认的提醒单独一块，不和说明连成两句
  const hint = sites.some((s) => s.id !== undefined) ? SITES_APART + '；' + SITE_SYNC + '。' : SITES_APART + '。';
  return (
    <FormSection title={fieldLabel('sites')} columns={1} hint={hint}>
      {needDefault && <FormMessage tone="warning">还没有默认厂区，请选一个设为默认。</FormMessage>}
      {sites.map((site, index) => {
        const label = '厂区 ' + (index + 1);
        return (
          <div className="line-card" key={site.id ?? 'new-' + index}>
            <header className="sales-site-head">
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
