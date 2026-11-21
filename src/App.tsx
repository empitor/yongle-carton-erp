import { Suspense, useState } from 'react';
import { AlertCircle, Check, Info } from 'lucide-react';
import { APP_VERSION, financeOnlyAccount } from '../shared/core/index';
import { BrandLogo, canEditBusiness, canViewFinance, ErrorBoundary, FormMessage, PageHeading, useAuthState, useBackLayer, type AuthState } from './ui/index';
import { useAppHome } from './app-bridge';
import LoginScreen from './LoginScreen';
import ForcedPasswordChange from './ForcedPasswordChange';
import Navigation from './Navigation';
import AppTopbar from './AppTopbar';
import { MobileSubNav, MobileTabBar, useMobileTables } from './mobile/MobileNav';
import { useAppContentStretch } from './mobile/content-stretch';
import CommandPalette from './CommandPalette';
import { useAppShareAccount } from './import/index';
import { SuperModeBanner } from './admin/index';
import {
  AccountManagement,
  AiSettingsHub,
  FinancePages,
  FlowPage,
  GlobalAssistant,
  InboxPage,
  OperationsPage,
  OrderImportPage,
} from './lazy-pages';
import { RecordPages, recordPages } from './records/index';
import GuidePage from './GuidePage';
import {
  homePage,
  ownHeading,
  pageAllowed,
  pageNames,
  useHashPage,
  useNavCounts,
  useNotice,
  usePaletteShortcut,
  useReloadOnAccountSwitch,
  type Notice,
  type Page,
} from './app-shell';

/** 外壳：登录前是登录页（临时密码登录的先改密码）；登录后是 Shell。 */
export default function App() {
  const session = useAuthState();
  if (!session) return <div className="login-screen" />;
  // 还没改掉临时密码时当作未登录，业务数据都不加载。
  if (session.actor?.mustChangePassword) return <ForcedPasswordChange name={session.actor.name} />;
  if (!session.actor) return <LoginScreen auth={session} />;
  return <Shell auth={session} actor={session.actor} />;
}

/** 登录以后：侧栏导航、顶栏、当前页面、底部提示、全局助手和搜索面板。 */
function Shell({ auth, actor }: { auth: AuthState; actor: NonNullable<AuthState['actor']> }) {
  const superMode = !!actor.superAdminMode,
    // 出纳这类纯财务账号只看财务页面，业务数据也不加载（后端同样会拒绝）。
    financeOnly = financeOnlyAccount(actor),
    finance = canViewFinance(auth),
    canCreate = canEditBusiness(auth);
  useReloadOnAccountSwitch(actor.id);
  useMobileTables();
  useAppContentStretch();
  const { page, routeKey } = useHashPage(financeOnly);
  const counts = useNavCounts(actor.id, financeOnly);
  const { notice, notify } = useNotice();
  const [menu, setMenu] = useState(false),
    [palette, setPalette] = useState(false);
  usePaletteShortcut(() => setPalette((v) => !v));
  const navigate = (target: string) => {
    location.hash = target;
    setMenu(false);
  };
  // 安卓 App 的返回键：手机侧边菜单开着先关菜单；没有弹层时回首页
  useBackLayer(() => setMenu(false), { active: menu });
  const home = homePage(financeOnly);
  useAppHome(page === home, () => navigate(home));
  // 安卓 App 分享来的文件：这个账号进不了 AI 导入就回绝
  useAppShareAccount(pageAllowed('ai-import', financeOnly));
  const recordPage = (recordPages as readonly string[]).includes(page);
  return (
    <div className="shell">
      <aside className={menu ? 'sidebar open' : 'sidebar'}>
        <a className="brand" href="#dashboard" title="宁波甬勒包装制品有限公司">
          <BrandLogo size={28} />
          <span className="brand-name">甬勒包装</span>
        </a>
        <Navigation
          page={page}
          route={routeKey}
          navigate={navigate}
          inboxCount={counts.inbox}
          importCount={counts.imports}
          finance={finance}
          financeOnly={financeOnly}
          accounts={actor.role === 'super_admin'}
          accountRequests={auth.pendingRequests || 0}
        />
      </aside>
      {menu && <div className="mobile-backdrop" onClick={() => setMenu(false)} />}
      <div className="main">
        <AppTopbar
          financeOnly={financeOnly}
          canCreate={canCreate}
          inboxCount={counts.inbox}
          toggleMenu={() => setMenu(!menu)}
          openPalette={() => setPalette(true)}
        />
        <main className={page === 'ai-import' ? 'import-main' : ''}>
          <MobileSubNav page={page} route={routeKey} navigate={navigate} />
          {superMode && !actor.localAdministrator && <SuperModeBanner until={actor.superAdminUntil} />}
          {/* 今日、订单、客户、产品、归档：一直挂着，换页后筛选和归档页选的类型还在 */}
          <RecordPages
            page={page}
            routeKey={routeKey}
            auth={auth}
            financeOnly={financeOnly}
            canCreate={canCreate}
            title={pageNames[page]}
            notify={notify}
          />
          <ErrorBoundary key={page}>
            <Suspense fallback={<p role="status">正在打开页面…</p>}>
              {!recordPage && !ownHeading(page) && <PageHeading title={pageNames[page]} />}
              {notice && <Toast notice={notice} />}

              <CurrentPage page={page} routeKey={routeKey} finance={finance} actor={actor} pending={auth.pendingRequests || 0} />
              <footer>
                宁波甬勒包装制品有限公司 · 管理系统
                <span>v{APP_VERSION}</span>
              </footer>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <MobileTabBar page={page} financeOnly={financeOnly} navigate={navigate} />
      <Suspense fallback={null}>
        <GlobalAssistant />
      </Suspense>
      {palette && !financeOnly && <CommandPalette canEdit={canCreate} close={() => setPalette(false)} />}
    </div>
  );
}

/** 底部提示的图标：办完的对勾，没办成的感叹号，提醒的 i（不是办成了） */
const toastIcons = { done: Check, error: AlertCircle, info: Info };
/** 底部提示：办完的绿色对勾，没办成的红色感叹号，提醒不带对勾 */
function Toast({ notice }: { notice: Notice }) {
  const failed = notice.tone === 'error',
    Icon = toastIcons[notice.tone];
  return (
    <div className={'toast' + (failed ? ' toast-error' : '')} role={failed ? 'alert' : 'status'}>
      <Icon size={18} />
      {notice.message}
    </div>
  );
}

/** 不常挂着的那些页面：按需加载，换页就卸掉。 */
function CurrentPage({
  page,
  routeKey,
  finance,
  actor,
  pending,
}: {
  page: Page;
  routeKey: string;
  finance: boolean;
  actor: NonNullable<AuthState['actor']>;
  /** 待处理的账号申请 */
  pending: number;
}) {
  if (page === 'ai-settings') return <AiSettingsHub actor={actor} />;
  if (page === 'ai-import') return <OrderImportPage />;
  if (page === 'inbox') return <InboxPage />;
  if (page === 'accounts')
    return <AccountManagement selfId={actor.id} isAdmin={actor.role === 'super_admin'} pending={pending} />;
  if (page.startsWith('finance'))
    return finance ? (
      <FinancePages page={page} />
    ) : (
      <FormMessage>当前账号没有财务权限。需要的话请找管理员在“账号管理”里调整。</FormMessage>
    );
  if (page === 'suppliers' || page === 'purchases' || page === 'warehouse')
    return <OperationsPage key={page + routeKey} mode={page} />;
  if (page === 'production') return <FlowPage key={page + routeKey} mode="task" />;
  if (page === 'guide') return <GuidePage />;
  return null;
}