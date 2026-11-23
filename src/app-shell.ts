import { useEffect, useRef, useState } from 'react';
import { businessSettingsTab } from '../shared/assistant/index';
import {
  financeOnlyPageAllowed,
  isFinancePage,
  pageHref,
  pageIdOf,
  type PageId,
  type SettingsTab,
} from '../shared/core/index';
import { aiFilesService, inboxService } from './import/index';
import { canEditBusiness, listen, readNotice, refreshOnReturn, type AuthState, type NoticeDetail, type NoticeTone } from './ui/index';

/* 外壳（App）的几件事：地址栏上的页面、导航角标、底部提示、快捷键、换账号后重新加载。 */

export type Page = PageId;

/** 自己画页头的页面（财务各页、采购库存、生产、收件箱、账号管理），App 不再给它们画 */
export const ownHeading = (page: Page) =>
  isFinancePage(page) || ['suppliers', 'purchases', 'warehouse', 'production', 'inbox', 'accounts'].includes(page);

/** 导航上的数字（收件箱、AI 导入）多久自己重新取一次：别的设备、别的人改了，这边最多晚这么久看到 */
const NAV_COUNTS_INTERVAL_MS = 15_000;

const hashPage = (): Page => pageIdOf(location.hash) ?? 'dashboard';

/** 登录后的首页：纯财务账号是财务概览，其余是“今日” */
export const homePage = (financeOnly: boolean): Page => (financeOnly ? 'finance' : 'dashboard');
/** 这个账号能不能打开这一页：出纳这类纯财务账号只看财务页面 */
export const pageAllowed = (page: Page, financeOnly: boolean) => !financeOnly || financeOnlyPageAllowed(page);

const settingsTabs: readonly (readonly [SettingsTab, string])[] = [
  ['api', 'API 配置'],
  ['prompts', '提示词'],
  ['templates', '单据模板'],
  ['channels', '消息接入'],
  ['tools', '高级'],
];
/**
 * 设置里这个账号看得到的页签：超级管理员账号全部；能改业务的只有单据模板（businessSettingsTab，读模板也要业务编辑权限）；
 * 别的账号（只读、纯财务）一个没有，侧栏也不显示“设置”。
 */
export function settingsTabsOf(actor: NonNullable<AuthState['actor']>) {
  if (actor.role === 'super_admin') return settingsTabs;
  return canEditBusiness({ actor }) ? settingsTabs.filter(([key]) => key === businessSettingsTab) : [];
}

/**
 * 地址栏 # 后面是哪一页（routeKey 是整个 #…，同一页换了参数也算变了）。切换页面时回到顶部。
 * 出纳这类纯财务账号只看财务页面，打开别的页面时换到财务概览。
 */
export function useHashPage(financeOnly: boolean) {
  const [page, setPage] = useState<Page>(hashPage),
    [routeKey, setRouteKey] = useState(location.hash);
  useEffect(() => {
    const f = () => {
      setRouteKey(location.hash);
      setPage(hashPage());
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  // 地址里不是哪一页、或这个账号打不开这一页（纯财务账号只看财务页面）：换到这个账号的首页
  useEffect(() => {
    if (!(routeKey && !pageIdOf(routeKey)) && pageAllowed(page, financeOnly)) return;
    const target = homePage(financeOnly),
      href = pageHref(target);
    history.replaceState(null, '', href);
    setPage(target);
    setRouteKey(href);
  }, [financeOnly, page, routeKey]);
  // 切换页面时回到顶部（编辑窗由 RecordPages 自己关）
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  return { page, routeKey };
}

/** 导航角标：收件箱待处理、AI 导入还要人处理的。和今日页用同一套识别导入的服务接口；纯财务账号不取。 */
export function useNavCounts(actorId: string | undefined, financeOnly: boolean) {
  const [inbox, setInbox] = useState(0),
    [imports, setImports] = useState(0);
  useEffect(() => {
    if (!actorId || financeOnly) return;
    const load = () => {
      // 角标取不到（网断了、服务在重启）就留着上一次的数，下一轮再取，不打扰人
      aiFilesService
        .open()
        .then((open) => setImports(open.length))
        .catch(() => {});
      inboxService
        .pending(1)
        .then((v) => setInbox(v.total))
        .catch(() => {});
    };
    load();
    const stopBusinessChanged = listen('erp-business-changed', load);
    const timer = setInterval(load, NAV_COUNTS_INTERVAL_MS);
    // 从别的窗口、别的应用切回来时，导航数字和眼前的列表都重新取（服务器不推送）
    const stopReturn = refreshOnReturn();
    return () => {
      stopBusinessChanged();
      clearInterval(timer);
      stopReturn();
    };
    // 换了账号或权限变了（变成、不再是纯财务账号）都重新开始取
  }, [actorId, financeOnly]);
  return { inbox, imports };
}

export type Notice = { message: string; tone: NoticeTone };
/**
 * 底部提示：弹窗里办完事就关掉窗口，提示交给这里显示，例如从订单安排生产后“已安排生产”；
 * 窗口关了但没办成的（tone 为 error），原因也在这里用红色提示说出来，多停一会儿，来得及看清原因。
 */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.tone === 'error' ? 9000 : 4500);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(
    () =>
      listen('erp-notice', (detail: NoticeDetail) => {
        const next = readNotice(detail);
        if (next) setNotice(next);
      }),
    [],
  );
  const notify = (message: string, tone: 'done' | 'error' = 'done') => setNotice(message ? { message, tone } : null);
  return { notice, notify };
}

/** Ctrl+K（Mac 上 ⌘K）打开、关上搜索面板 */
export function usePaletteShortcut(toggle: () => void) {
  // 快捷键只在打开页面时挂一次；toggle 每次渲染都是新函数，放进 ref 里取最新的
  const latest = useRef(toggle);
  useEffect(() => {
    latest.current = toggle;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 另一个标签页切换了账号：这里的页面和表单还是上一个账号的，重新加载。 */
export function useReloadOnAccountSwitch(actorId: string | undefined) {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const id = actorId || null;
    if (shown.current && id && id !== shown.current) location.reload();
    if (id) shown.current = id;
  }, [actorId]);
}
