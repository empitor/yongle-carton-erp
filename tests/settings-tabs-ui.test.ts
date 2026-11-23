// 设置页按账号显示页签：API 配置、提示词、消息接入、高级只给超级管理员账号，能改业务的只有单据模板，
// 从旧链接（tab=prompts 这些）进来也落到单据模板；只读、出纳一个页签都没有，侧栏也没有设置。助手窗口“更多”里去这两页的入口也一样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AiSettingsHub from '../src/AiSettingsHub.js';
import { settingsTabsOf } from '../src/app-shell.js';
import AssistantHeader from '../src/assistant/AssistantHeader.js';
import Navigation from '../src/Navigation.js';
import { actor, grant, superActor } from './actor-fixture.js';

const tabsOf = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
/** 设置页按这个链接打开时显示的页签和选中的那个（页面读 location.hash，测试里临时给一个） */
function settingsAs(who: Parameters<typeof AiSettingsHub>[0]['actor'], hash: string) {
  Object.defineProperty(globalThis, 'location', { value: { hash }, configurable: true });
  try {
    const html = renderToStaticMarkup(createElement(AiSettingsHub, { actor: who }));
    return { tabs: tabsOf(html), selected: /aria-selected="true"[^>]*>([^<]+)</.exec(html)?.[1], html };
  } finally {
    Reflect.deleteProperty(globalThis, 'location');
  }
}

// 各级别的权限照账号库的 levelGrant（server/accounts/account-db.ts）
const staff = actor,
  viewer = { ...actor, permissions: grant() },
  finance = { ...actor, permissions: grant('business:edit', 'finance:view', 'finance:edit', 'finance:approve', 'finance:close') },
  cashier = { ...actor, permissions: grant('finance:view', 'finance:cash') };

test('超级管理员账号看到设置的全部五个页签，链接指哪个选哪个', () => {
  const admin = { ...superActor(), superAdminMode: false };
  assert.deepEqual(settingsAs(admin, '#ai-settings').tabs, ['API 配置', '提示词', '单据模板', '消息接入', '高级']);
  assert.equal(settingsAs(admin, '#ai-settings?tab=prompts').selected, '提示词');
  assert.equal(settingsAs(admin, '#ai-settings?tab=tools').selected, '高级');
});

const links = ['#ai-settings', '#ai-settings?tab=api', '#ai-settings?tab=prompts', '#ai-settings?tab=channels', '#ai-settings?tab=tools'];

test('业务人员、财务账号的设置页只有单据模板；从 API 配置、提示词、消息接入、高级的链接进来也落到单据模板', () => {
  for (const who of [staff, finance])
    for (const hash of links) {
      const page = settingsAs(who, hash);
      assert.deepEqual(page.tabs, ['单据模板'], who.permissions.join() + hash);
      assert.equal(page.selected, '单据模板', hash);
      assert.match(page.html, /aria-label="单据模板"/, hash);
      for (const hidden of ['API 配置', '提示词', '消息接入', '插件与工具']) assert.doesNotMatch(page.html, new RegExp(hidden), hash);
    }
});

test('只读、出纳账号读不了单据模板，设置一个页签都没有：从链接进来只说一句，不挂任何设置页', () => {
  for (const who of [viewer, cashier])
    for (const hash of links) {
      const page = settingsAs(who, hash);
      assert.deepEqual(page.tabs, [], who.permissions.join() + hash);
      assert.match(page.html, /当前账号没有可改的设置/, hash);
      assert.doesNotMatch(page.html, /tabpanel/, hash);
    }
});

test('侧栏的设置：超级管理员、业务人员、财务账号有，只读账号没有', () => {
  const nav = (who: Parameters<typeof settingsTabsOf>[0]) =>
    renderToStaticMarkup(createElement(Navigation, { page: 'dashboard', navigate: () => {}, settings: settingsTabsOf(who).length > 0 }));
  for (const who of [superActor(), staff, finance]) assert.match(nav(who), />设置</, who.permissions.join());
  assert.doesNotMatch(nav(viewer), />设置</);
});

test('助手窗口“更多”：插件与工具、管理提示词只给超级管理员账号，记忆人人都有', () => {
  const none = () => {};
  const header = (superAdmin: boolean) =>
    renderToStaticMarkup(
      createElement(AssistantHeader, {
        docked: true,
        phone: false,
        large: false,
        floatingLauncher: true,
        signedIn: true,
        superAdmin,
        busy: false,
        newDisabled: false,
        sessionLocked: false,
        speaker: undefined,
        speakTick: 0,
        // 停靠时头部不能拖，拖动的处理不会挂上
        dragBind: { onPointerDown: none, onPointerMove: none, onPointerUp: none, onPointerCancel: none, onLostPointerCapture: none, onKeyDown: none },
        onNew: () => {},
        onPanelMode: () => {},
        onToggleLarge: () => {},
        onClear: () => {},
        onMemory: () => {},
        onRemove: () => {},
        onClose: () => {},
      }),
    );
  const admin = header(true),
    other = header(false);
  for (const item of ['插件与工具', '管理提示词']) {
    assert.match(admin, new RegExp(item));
    assert.doesNotMatch(other, new RegExp(item));
  }
  for (const html of [admin, other]) assert.match(html, />记忆</);
});
