import { useEffect, useState } from 'react';
import type { NextSteps, RecordEntity } from '../../shared/business/index';
import { errorMessage } from '../../shared/core/index';
import { useBusinessRevision } from '../ui/index';
import { readRelated } from '../recordkit/record-api';

/** 订单或采购单的关联单据（订单的带唛头、生产送货，采购单的带到货记录；用 'marks' in、'arrivals' in 分辨） */
export type RelatedData = Awaited<ReturnType<typeof readRelated<'orders' | 'purchases'>>>;
/** 订单、采购单详情要用的关联单据（生产任务、送货、采购、到货、库存），和“下一步”。 */
export type Related = { data: RelatedData | null; plan: NextSteps | null; error: string; canEdit: boolean };

/** 关联单据读到的结果记着是哪张单的；换了一张单，上一张的结果一律不用。 */
type RelatedState<D = RelatedData> = { key: string; data: D | null; error: string };
export const relatedKey = (entity: RecordEntity, id: unknown) => entity + '/' + String(id);
/** 当前这张单能用的关联单据：只认同一张单读回来的；读失败了不留旧数据。 */
export function currentRelated<D>(state: RelatedState<D>, key: string, wanted: boolean) {
  if (!wanted || state.key !== key) return { data: null, error: '' };
  return { data: state.error ? null : state.data, error: state.error };
}

/**
 * 读关联单据：单据被生产、送货或确认改变后重读（重读时先留着这张单上一次读到的）。
 * 能看这张单的账号都读（只读账号也看得到关联单据）。
 */
export function useRelatedData(entity: RecordEntity, row: { id: number; version: number }, enabled: boolean) {
  const [state, setState] = useState<RelatedState>({ key: '', data: null, error: '' });
  const [revision] = useBusinessRevision();
  const wanted = enabled && (entity === 'orders' || entity === 'purchases');
  const key = relatedKey(entity, row.id);
  useEffect(() => {
    let active = true;
    if (!wanted || (entity !== 'orders' && entity !== 'purchases')) return;
    // 换了一张单：先清掉上一张的关联单据，“下一步”不能拿上一张的单据算
    setState((s) => (s.key === key ? s : { key, data: null, error: '' }));
    readRelated(entity, row.id)
      .then((v) => {
        // 旧请求晚到（已经换了单或又重读了）就丢掉，不覆盖当前这张
        if (active) setState({ key, data: v, error: '' });
      })
      .catch((e: unknown) => {
        if (active) setState({ key, data: null, error: errorMessage(e) });
      });
    return () => {
      active = false;
    };
  }, [entity, row.id, row.version, wanted, revision, key]);
  return currentRelated(state, key, wanted);
}
