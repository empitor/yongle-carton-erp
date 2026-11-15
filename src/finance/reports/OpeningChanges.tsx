import { useState } from 'react';
import { businessDocLink, useBusinessAccount } from '../SourceDetail';
import { FormDialog } from '../FormDialog';
import { eventSourceNames } from '../labels';
import { acknowledgeEvent } from '../ledger/ledger-api';
import type { FinData } from '../fin-api';

/** 结账检查里“启用前单据的变动”那一步列出的一张单据 */
type OpeningItem = Extract<FinData<'GET /finance/closing'>['steps'][number], { items: unknown }>['items'][number];

/**
 * 结账检查里“启用前单据的变动”：启用前的单据启用后被冲销、更正或改了单价，期初往来可能要调。
 * 不拦结账；打开原单核对后点“核对无误”清掉，以后再变会再提醒。
 */
export default function OpeningChanges({
  items,
  canAck,
}: {
  items: OpeningItem[];
  canAck: boolean;
}) {
  const business = useBusinessAccount();
  const [row, setRow] = useState<OpeningItem | null>(null);
  const name = (r: OpeningItem) =>
    (eventSourceNames[r.source_kind] || '单据') + ' ' + (r.number ? r.number + ' · ' : '') + r.date;
  return (
    <div className="fb-step-jobs">
      <small>不强制，没核对也能结账</small>
      {items.map((r) => {
        const link = business ? businessDocLink(r.source_kind, r.source_id) : null;
        return (
          <span key={r.id}>
            <small>
              {name(r)}：{r.problem}
            </small>
            {link && <a href={link.href}>{link.label}</a>}
            {canAck && (
              <button type="button" className="secondary" onClick={() => setRow(r)}>
                核对无误
              </button>
            )}
          </span>
        );
      })}
      {row && (
        <FormDialog
          title="核对期初往来"
          subtitle={name(row)}
          size="sm"
          columns={1}
          intro={row.problem}
          submitLabel="核对无误"
          fields={[{ name: 'reason', label: '说明', type: 'textarea', required: true }]}
          notice="已核对，这条不再提示。"
          close={() => setRow(null)}
          submit={(v) => acknowledgeEvent(row, v)}
        />
      )}
    </div>
  );
}
