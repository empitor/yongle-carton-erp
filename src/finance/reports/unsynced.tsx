import { useEffect, useRef, useState } from 'react';
import { FormMessage } from '../../ui/index';
import { finChanged, useFinRead, type FinData } from '../fin-api';
import { readinessOf } from './reports-api';

/*
 * 还没进财务的业务单据：服务端在每个财务请求前补扫（server/finance/catch-up.ts），页面不另发补扫，
 * 只读正式报表的资料检查（GET /finance/reports/readiness）看还剩几张、补扫成没成功。
 *
 * 服务端一次最多扫两批，大批单据（刚启用、批量导入后）要几个请求才扫完。所以剩下的不是 0 时页面再读一次：
 * 每读一次服务端就接着扫，数在变少就是“还在进财务”，接着读；数不动了，剩下的就是内容读不出来、补扫跳过的。
 * 这一轮进了新单据，最后让财务页面都重读一遍（台账、待补清单跟着更新）。
 */

type Readiness = FinData<'GET /finance/reports/readiness'>;
/** checking：剩下的数还没再读一次核对；moving：数在变少，还在进财务；settled：数不动了 */
type Phase = 'checking' | 'moving' | 'settled';

/** 读这个月的资料检查（enabled 为 false 时不读，财务没启用时用），剩下的不是 0 就接着读到数不动为止 */
export function useUnsynced(period: string, enabled = true) {
  const { data, reload } = useFinRead(enabled ? readinessOf(period) : null);
  const last = useRef<{ period: string; unsynced: number } | null>(null);
  const moved = useRef(false);
  const [phase, setPhase] = useState<Phase>('checking');
  useEffect(() => {
    if (!data) return;
    const before = last.current?.period === data.period ? last.current.unsynced : null;
    last.current = { period: data.period, unsynced: data.unsynced };
    const going = !data.syncFailed && data.unsynced > 0 && (before === null || data.unsynced < before);
    if (going) {
      if (before !== null) moved.current = true;
      setPhase(before === null ? 'checking' : 'moving');
      reload();
      return;
    }
    setPhase('settled');
    if (moved.current) {
      moved.current = false;
      finChanged();
    }
  }, [data, reload]);
  return { data, phase };
}

/** 列出来的单号（盘点流水是拼的说明）；没有单号的只算张数 */
const numbersOf = (data: Readiness) => {
  const numbers = data.unsyncedSources.flatMap((s) => (s.number ? [s.number] : []));
  return numbers.length ? '：' + numbers.join('、') + (numbers.length < data.unsynced ? ' 等' : '') : '';
};

/** 补扫没成功、还在进财务、有单据进不来时的一句话（都没有给 null） */
export function unsyncedNotice(data: Readiness | null, phase: Phase) {
  if (!data) return null;
  if (data.syncFailed)
    return {
      tone: 'danger',
      text: '业务单据没能进财务（原因已记进出错记录），这里的数可能不是最新的；结账、正式报表和财务的修改先拦下，请联系维护人员。',
    } as const;
  if (data.unsynced === 0 || phase === 'checking') return null;
  if (phase === 'moving')
    return { tone: 'info', text: '正在把业务单据记进财务，还剩 ' + data.unsynced + ' 张，记完页面自动更新。' } as const;
  return {
    tone: 'warning',
    text:
      '有 ' + data.unsynced + ' 张业务单据还没进财务，结账和正式报表先拦下' + numbersOf(data) +
      '。多半是单据内容读不出来，请联系维护人员查看出错记录；在库里改好后打开财务会自动补上。',
  } as const;
}

/** 概览、月度台账、业务单据页上的一行提示（结账页、报表页签由 Readiness 一起说） */
export function UnsyncedNotice({ period, enabled = true }: { period: string; enabled?: boolean }) {
  const { data, phase } = useUnsynced(period, enabled);
  const notice = unsyncedNotice(data, phase);
  return notice && <FormMessage tone={notice.tone}>{notice.text}</FormMessage>;
}
