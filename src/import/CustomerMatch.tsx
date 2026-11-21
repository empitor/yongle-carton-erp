import type { ImportMapping, ImportMatchData } from '../../shared/import/index';
import { FormField, type Tone, loadingText } from '../ui/index';
import { choiceValue, selectChoice, type Match } from './ImportMatch';

type CustomerChoice = ImportMapping['customer'];
type CustomerRecord = ImportMatchData['customers'][number];

/** 客户那一格下面的一句说明 */
function customerStatus(
  chosen: CustomerChoice,
  found: { selected?: CustomerRecord; unavailable: boolean; loaded: boolean; candidates: number },
): { tone: Tone; text: string } {
  const { selected, unavailable, loaded, candidates } = found;
  if (chosen.mode === 'existing') {
    if (unavailable) return { tone: 'danger', text: '原客户选择已失效，请重新选择' };
    if (!selected) return { tone: 'success', text: loaded ? '档案待核对' : loadingText('档案') };
    const contact = [selected.contact, selected.phone, selected.address].filter(Boolean);
    return { tone: 'success', text: '已匹配已有档案' + (contact.length ? ' · ' + contact.join(' · ') : '') };
  }
  if (chosen.mode === 'new') return { tone: 'neutral', text: '导入时新建客户，现在只保存计划' };
  if (candidates) return { tone: 'warning', text: '找到客户候选，请在下面确认' };
  return { tone: 'neutral', text: loaded ? '没有匹配档案，导入时新建客户' : loadingText('客户候选') };
}

/** 客户候选：选过的档案改过了要重新确认；没定时把候选逐个列出来 */
function CustomerCandidates({
  stale,
  candidates,
  locked,
  pick,
}: {
  stale: CustomerRecord | undefined;
  candidates: NonNullable<Match['customerResolution']>['candidates'];
  locked: boolean;
  pick: (customer: CustomerChoice) => void;
}) {
  if (!candidates.length && !stale) return null;
  return (
    <div className="aii-candidates aii-span-full" aria-label="客户匹配状态">
      {stale && (
        <div className="aii-candidate">
          <div>
            <strong>{stale.name}</strong>
            <small>档案已经改过，确认还是这个客户后再导入。</small>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={locked}
            onClick={() => pick({ mode: 'existing', id: stale.id, version: stale.version })}
          >
            重新确认此客户
          </button>
        </div>
      )}
      {candidates.map((c) => (
        <div className="aii-candidate" key={c.id}>
          <div>
            <strong>
              {c.name}
            </strong>
            <small>
              {[c.contact, c.phone, c.address].filter(Boolean).join(' · ') || '联系人资料未填写'}
            </small>
            <small>
              {c.reason}
              {c.archived ? ' · 已归档，请先恢复' : ''}
            </small>
          </div>
          <button
            type="button"
            className="secondary"
            aria-label={'选择客户候选 ' + c.name}
            disabled={locked || c.archived}
            onClick={() => pick({ mode: 'existing', id: c.id, version: c.version })}
          >
            选择此客户
          </button>
        </div>
      ))}
    </div>
  );
}

/** 客户档案：下拉选已有或新建，下面一句说明现在对应到了谁；有候选时逐个列出。 */
export function CustomerMatch({
  match,
  buyerName,
  locked,
}: {
  match: Match;
  buyerName: string | null;
  locked: boolean;
}) {
  const { matches, mapping, invalidated, customerResolution } = match;
  const chosen = mapping.customer;
  const pick = (customer: CustomerChoice) => match.select({ ...mapping, customer }, 'customer');
  const selected = chosen.mode === 'existing' ? matches?.customers.find((c) => c.id === chosen.id) : undefined;
  const unavailable = !!matches && chosen.mode === 'existing' && (!selected || selected.version !== chosen.version);
  const candidates = chosen.mode !== 'existing' ? customerResolution?.candidates || [] : [];
  const status = customerStatus(chosen, { selected, unavailable, loaded: !!matches, candidates: candidates.length });
  return (
    <>
      <FormField
        label="客户档案"
        span={2}
        error={invalidated.customer && chosen.mode === 'pending' ? invalidated.customer : undefined}
        hint={<span className={'aii-status tone-' + status.tone}>{status.text}</span>}
      >
        <select
          aria-label="客户匹配"
          disabled={locked || !matches}
          value={choiceValue(chosen)}
          onChange={(e) => pick(selectChoice(e.target.value, matches?.customers || []))}
        >
          <option value="">待确认，选择已有或新建</option>
          <option value="new">计划创建新客户：{buyerName || '请先填名称'}</option>
          {matches?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {chosen.mode === 'existing' && chosen.id === c.id
                ? '已选择 · '
                : customerResolution?.candidates.some((x) => x.id === c.id)
                  ? '候选 · '
                  : ''}
              {c.name}
              {c.contact ? ' · ' + c.contact : ''}
              {c.phone ? ' · ' + c.phone : ''}
            </option>
          ))}
        </select>
      </FormField>
      <CustomerCandidates stale={unavailable ? selected : undefined} candidates={candidates} locked={locked} pick={pick} />
    </>
  );
}
