import { useCallback, useEffect, useState } from 'react';
import type { Listed } from '../../shared/business/index';
import { errorMessage, type Order } from '../../shared/core/index';
import { listen, useAuthState, useSlots, type Slots } from '../ui/index';
import { TODAY_SHOWN } from './today-groups';
import { loadPendingConfirm, loadToday } from './list-api';

type Today = Awaited<ReturnType<typeof loadToday>>;
type Mail = Awaited<ReturnType<NonNullable<Slots['inbox']>['pending']>>;
type AiFile = Awaited<ReturnType<NonNullable<Slots['aiFiles']>['open']>>[number];
type DueRow = Awaited<ReturnType<NonNullable<Slots['finance']>['dueSoon']>>[number];

/**
 * 今日页要的数据：今日待办、待确认订单、收件箱和 AI 识别文件（识别导入提供）、到期应收应付（财务提供，插槽里的服务接口），
 * 业务数据变了全部重读。除了今日待办，别的读不到就不显示那一块。
 */
export function useTodayData() {
  const { aiFiles, inbox, finance } = useSlots();
  const auth = useAuthState();
  const [data, setData] = useState<Today | null>(null),
    [error, setError] = useState(''),
    [pendingConfirm, setPendingConfirm] = useState<{ rows: Listed<Order>[]; total: number } | null>(null),
    [mail, setMail] = useState<Mail>({ rows: [], total: 0 }),
    [imports, setImports] = useState<AiFile[]>([]),
    [dueRows, setDueRows] = useState<DueRow[]>([]);
  const load = useCallback(() => {
    loadToday()
      .then((v) => {
        setData(v);
        setError('');
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    loadPendingConfirm(TODAY_SHOWN)
      .then((v) => setPendingConfirm({ rows: v.rows, total: v.filteredRecords ?? v.rows.length }))
      .catch(() => setPendingConfirm(null));
    inbox
      ?.pending(TODAY_SHOWN)
      .then(setMail)
      // 收件箱读不到就不显示那一块（今日待办照常）
      .catch(() => {});
    aiFiles
      ?.open()
      .then(setImports)
      // AI 识别文件读不到就不显示那一块
      .catch(() => {});
  }, [aiFiles, inbox]);
  useEffect(() => {
    load();
    return listen('erp-business-changed', load);
  }, [load]);
  // 到期应收应付：只有能看财务的账号才去取（业务员、只读账号不发这个请求，免得控制台一条 403），其他账号右栏不显示这一块。
  // 登录状态读到以后才知道有没有财务权限，所以单独取、跟着权限变。
  const canSeeFinance = !!auth?.actor?.permissions.includes('finance:view');
  useEffect(() => {
    if (!canSeeFinance || !finance) {
      setDueRows([]);
      return;
    }
    let active = true;
    const loadDue = () =>
      void finance
        .dueSoon(7, 10)
        .then((rows) => active && setDueRows(rows))
        .catch(() => active && setDueRows([]));
    loadDue();
    const stop = listen('erp-business-changed', loadDue);
    return () => {
      active = false;
      stop();
    };
  }, [canSeeFinance, finance]);
  return { data, error, pendingConfirm, mail, imports, dueRows, aiNote: aiFiles?.note, reload: load };
}
