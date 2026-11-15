import { useEffect, useRef, useState } from 'react';
import { FormMessage, StatusChip, SuperModeNotice, useAction, useAuthState, useLoad } from '../ui/index';
import {
  readPlugins,
  setPluginEnabled,
  setToolEnabled,
  type ManagedPlugin,
  type ManagedTool,
  type PluginManagementState,
} from './assistant-api';

/**
 * 工具分组（设置 → 高级）：每组一张卡片，名字、说明和整组开关；组里的工具收在“工具（N）”里，
 * 每个工具一行：名字、说明、能不能用、单独开关。整组停用时各工具自己的开关保留。
 */
export function PluginManagementView({
  state,
  busy,
  onPluginToggle,
  onToolToggle,
}: {
  state: PluginManagementState;
  busy: boolean;
  onPluginToggle: (plugin: ManagedPlugin) => void;
  onToolToggle: (tool: ManagedTool) => void;
}) {
  return (
    <div className="adm-plugin-list">
      {state.plugins.map((p) => (
        <article key={p.id} className="adm-plugin" aria-label={p.name + '分组'}>
          <header className="adm-plugin-head">
            <div>
              <h3>{p.name}</h3>
              <p>{p.description}</p>
            </div>
            {!p.enabled && (
              <span className="adm-plugin-count">
                <StatusChip tone="neutral">已停用</StatusChip>
                <small>独立工具设置已保留</small>
              </span>
            )}
            <label className="adm-switch">
              <input
                type="checkbox"
                role="switch"
                aria-label={'启用分组 ' + p.name}
                checked={p.enabled}
                disabled={!state.canManage || busy}
                onChange={() => onPluginToggle(p)}
              />
              启用
            </label>
          </header>
          <details className="adm-plugin-tools">
            <summary>工具（{p.tools.length}）</summary>
            {p.tools.map((t) => (
              <section key={t.name} className="adm-plugin-tool" aria-label={'工具 ' + t.name}>
                <div className="adm-plugin-tool-row">
                  <div>
                    <h4>{t.name}</h4>
                    <p>{t.description}</p>
                  </div>
                  <span role="status">
                    <StatusChip tone={t.usable ? 'success' : 'neutral'}>{t.usable ? '可用' : t.status}</StatusChip>
                  </span>
                  <label className="adm-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={'单独启用工具 ' + t.name}
                      checked={t.toolEnabled}
                      disabled={!state.canManage || busy}
                      onChange={() => onToolToggle(t)}
                    />
                    启用
                  </label>
                </div>
              </section>
            ))}
          </details>
        </article>
      ))}
    </div>
  );
}
export default function AssistantPlugins() {
  const auth = useAuthState(),
    userId = auth?.actor?.id;
  // 换了账号（或同一账号的身份变了）就重读；没登录不读
  const identity = JSON.stringify(auth?.actor);
  const plugins = useLoad(userId ? identity : null, () => readPlugins()),
    action = useAction(),
    [notice, setNotice] = useState('');
  // 只在换了账号或身份时清掉提示：action.clear 每次渲染都是新的，经 ref 取
  const clearError = useRef(action.clear);
  clearError.current = action.clear;
  useEffect(() => {
    setNotice('');
    clearError.current();
  }, [identity]);
  const state: PluginManagementState | null = userId && !plugins.loading ? plugins.data : null,
    error = action.error || (plugins.loading ? '' : plugins.error),
    busy = action.busy;
  /** 改一个开关：改成了说一声；成没成都重读一份，开关按服务器上的显示 */
  function change(send: () => Promise<unknown>, label: string) {
    if (!state || busy) return;
    setNotice('');
    void action.run(async () => {
      try {
        await send();
        setNotice(label + '，已保存。');
      } finally {
        plugins.reload();
      }
    });
  }
  return (
    <section className="adm-plugins" aria-label="插件与工具">
      <header className="adm-plugins-head">
        <h2>插件与工具</h2>
        <p className="adm-muted">
          控制小甬小勒能用哪些工具，平时不用改。整组停用时，组里每个工具的开关会保留；工具能不能用还要看账号权限和执行服务。
        </p>
      </header>
      <FormMessage>{error}</FormMessage>
      <FormMessage tone="info">{notice}</FormMessage>
      {!userId ? (
        <p className="adm-muted">请先登录管理账号。</p>
      ) : !state && !error ? (
        <p className="adm-muted">正在读取插件与工具…</p>
      ) : null}
      {/* 开关要在超级管理员模式里改：超级管理员账号没进时给入口，别的账号只能看 */}
      {state &&
        !state.canManage &&
        (auth?.actor?.role === 'super_admin' ? (
          <SuperModeNotice what="启停工具" />
        ) : (
          <FormMessage tone="info">当前账号只能查看状态；开关只有管理员能改。</FormMessage>
        ))}
      {state && (
        <PluginManagementView
          state={state}
          busy={busy}
          onPluginToggle={(p) =>
            change(
              () => setPluginEnabled(p.id, !p.enabled, state.revision),
              p.name + (p.enabled ? '已停用，工具独立设置保留' : '已启用，工具按原独立设置恢复'),
            )
          }
          onToolToggle={(t) =>
            change(
              () => setToolEnabled(t.name, !t.toolEnabled, state.revision),
              t.name + (t.toolEnabled ? '已停用' : '已启用'),
            )
          }
        />
      )}
    </section>
  );
}
