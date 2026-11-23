import { useEffect, useRef, useState } from 'react';
import { Bot, Menu, Plus, Search } from 'lucide-react';
import AuthPanel from './AuthPanel';
import { createActions } from './CommandPalette';
import { assistantDisplayName, useAssistantTopbarEntry } from './assistant/index';
import { emit, MenuItem, useBackLayer } from './ui/index';
import { useTopbarCollapse } from './mobile/topbar-collapse';

/**
 * 顶栏：手机上的导航按钮（带收件箱数字）、全局搜索、“新建”菜单、小甬小勒的顶栏入口、账号菜单。
 * 搜索和新建都是业务数据，出纳这类纯财务账号不显示。
 */
export default function AppTopbar({
  financeOnly,
  canCreate,
  inboxCount,
  toggleMenu,
  openPalette,
}: {
  financeOnly: boolean;
  canCreate: boolean;
  inboxCount: number;
  toggleMenu: () => void;
  openPalette: () => void;
}) {
  // 小甬小勒的顶栏入口：收起方式选了“放到顶栏”才显示，否则用悬浮小人，两者不同时出现
  const topbarAssistant = useAssistantTopbarEntry();
  const [newMenu, setNewMenu] = useState(false),
    newMenuRef = useRef<HTMLDivElement>(null),
    bar = useRef<HTMLElement>(null);
  // 手机上跟着滚动收起、露出
  useTopbarCollapse(bar);
  // 安卓 App 的返回键：“新建”菜单开着时先收起菜单
  useBackLayer(() => setNewMenu(false), { active: newMenu });
  useEffect(() => {
    if (!newMenu) return;
    const outside = (e: PointerEvent) => {
      if (!newMenuRef.current?.contains(e.target instanceof Node ? e.target : null)) setNewMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewMenu(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [newMenu]);
  return (
    <header ref={bar} className="topbar">
      <div>
        <button
          className="mobile-menu icon-button"
          aria-label={inboxCount > 0 ? `切换导航，收件箱 ${inboxCount} 条` : '切换导航'}
          onClick={toggleMenu}
        >
          <Menu size={20} />
          {inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}
        </button>
        {!financeOnly && (
          <button className="top-search" onClick={openPalette}>
            <Search size={14} />
            搜索单号、客户、产品…
            <kbd>Ctrl K</kbd>
          </button>
        )}
      </div>
      <div className="topbar-right">
        {!financeOnly && (
          <div className="top-new" ref={newMenuRef}>
            <button aria-haspopup="menu" aria-expanded={newMenu} disabled={!canCreate} onClick={() => setNewMenu((v) => !v)}>
              <Plus size={15} />
              新建
            </button>
            {newMenu && (
              <div className="top-new-menu" role="menu" onClick={() => setNewMenu(false)}>
                {/* 和 Ctrl+K 搜索面板的“操作”同一份清单、同一套叫法 */}
                {createActions.map((a) => (
                  <MenuItem key={a.target} href={a.target}>
                    {a.label}
                  </MenuItem>
                ))}
              </div>
            )}
          </div>
        )}
        {topbarAssistant && (
          <button
            className="assistant-topbar-button"
            aria-label={'打开' + assistantDisplayName}
            aria-haspopup="dialog"
            title={assistantDisplayName + '（Ctrl+J）'}
            onClick={() => emit('erp-open-assistant')}
          >
            <Bot size={16} />
            {assistantDisplayName}
          </button>
        )}
        <AuthPanel />
      </div>
    </header>
  );
}
