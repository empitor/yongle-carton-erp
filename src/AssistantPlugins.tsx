import { useEffect, useRef, useState } from 'react';
import { managementRequest, useAuthState } from './session';
type Execution = { state: string; at: string; tool?: string };
export type ManagedTool = {
  name: string;
  description: string;
  parameters: unknown;
  permissions: string[];
  pluginEnabled: boolean;
  toolEnabled: boolean;
  permitted: boolean;
  permissionLimited?: boolean;
  available: boolean;
  usable: boolean;
  status: string;
  serviceStatus: string;
  permissionNote: string;
  lastExecution?: Execution | null;
};
export type ManagedPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  tools: ManagedTool[];
  logs: Execution[];
};
export type PluginManagementState = {
  revision: number;
  canManage: boolean;
  plugins: ManagedPlugin[];
};
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
    <div className="ai-plugin-list">
      {state.plugins.map((p) => {
        const usable = p.tools.filter((t) => t.usable).length;
        return (
          <article key={p.id} className="panel ai-plugin-card" aria-label={p.name + '插件'}>
            <div className="ai-plugin-heading">
              <div>
                <h3>
                  {p.name} <small>v{p.version}</small>
                </h3>
                <p>{p.description}</p>
              </div>
              <label className="ai-plugin-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={'启用插件 ' + p.name}
                  checked={p.enabled}
                  disabled={!state.canManage || busy}
                  onChange={() => onPluginToggle(p)}
                />
                插件总开关
              </label>
            </div>
            <p className="ai-plugin-status">
              <span className="record-state">{p.enabled ? '已启用' : '已停用'}</span>
              <span>
                共 {p.tools.length} 个工具 · 当前可用 {usable} 个
              </span>
              {!p.enabled && <span>独立工具设置已保留</span>}
            </p>
            <details className="ai-plugin-tools">
              <summary>展开或收起工具列表（{p.tools.length}）</summary>
              {p.tools.map((t) => (
                <section key={t.name} className="ai-plugin-tool" aria-label={'工具 ' + t.name}>
                  <div className="ai-plugin-heading">
                    <div>
                      <h4>{t.name}</h4>
                      <p>{t.description}</p>
                    </div>
                    <label className="ai-plugin-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={'单独启用工具 ' + t.name}
                        checked={t.toolEnabled}
                        disabled={!state.canManage || busy}
                        onChange={() => onToolToggle(t)}
                      />
                      工具独立开关
                    </label>
                  </div>
                  <p className={t.usable ? 'ai-tool-ready' : 'ai-tool-unavailable'} role="status">
                    {t.usable ? (t.permissionLimited ? '部分操作可用' : '当前可用') : t.status}
                  </p>
                  <div className="ai-tool-factors">
                    <span>插件：{t.pluginEnabled ? '已启用' : '已停用'}</span>
                    <span>工具：{t.toolEnabled ? '已启用' : '已停用'}</span>
                    <span>
                      账号权限：
                      {t.permitted ? (t.permissionLimited ? '部分操作满足' : '满足') : '不满足'}
                    </span>
                    <span>执行服务：{t.available ? '已连接' : '未连接'}</span>
                  </div>
                  <p>权限要求：{t.permissions.join('、')}</p>
                  {t.permissionNote && <p className="ai-plugin-muted">{t.permissionNote}</p>}
                  <p className="ai-plugin-muted">{t.serviceStatus}</p>
                  <details>
                    <summary>参数结构</summary>
                    <pre>{JSON.stringify(t.parameters, null, 2)}</pre>
                  </details>
                  <p className="ai-plugin-muted">
                    最近执行：
                    {t.lastExecution
                      ? new Date(t.lastExecution.at).toLocaleString('zh-CN') +
                        ' · ' +
                        t.lastExecution.state
                      : '暂无执行记录'}
                  </p>
                </section>
              ))}
              {!p.tools.length && <p>此插件尚未注册工具。</p>}
            </details>
            <details className="ai-plugin-logs">
              <summary>当前账号操作日志</summary>
              {p.logs.length ? (
                <ul>
                  {p.logs.map((l, i) => (
                    <li key={i}>
                      {new Date(l.at).toLocaleString('zh-CN')} · {l.tool} · {l.state}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无操作记录</p>
              )}
            </details>
          </article>
        );
      })}
    </div>
  );
}
export default function AssistantPlugins() {
  const auth = useAuthState(),
    userId = auth?.actor?.id;
  const [state, setState] = useState<PluginManagementState | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const owner = useRef(userId);
  owner.current = userId;
  const identity = JSON.stringify(auth?.actor);
  useEffect(() => {
    let active = true;
    setState(null);
    setError('');
    setNotice('');
    setBusy(false);
    if (userId)
      void managementRequest<PluginManagementState>('/assistant/plugins')
        .then((v) => {
          if (active) setState(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [identity]);
  async function change(path: string, body: unknown, label: string) {
    if (!state || busy) return;
    const user = userId;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await managementRequest(path, body);
      const latest = await managementRequest<PluginManagementState>('/assistant/plugins');
      if (owner.current === user) {
        setState(latest);
        setNotice(label + '，已保存。');
      }
    } catch (e) {
      if (owner.current === user) {
        setError((e as Error).message);
        const latest = await managementRequest<PluginManagementState>('/assistant/plugins').catch(
          () => null,
        );
        if (latest && owner.current === user) setState(latest);
      }
    } finally {
      if (owner.current === user) setBusy(false);
    }
  }
  return (
    <section className="ai-plugin-management" aria-label="AI插件与工具管理">
      <div className="ai-plugin-intro">
        <h2>AI 插件与工具管理</h2>
        <p>
          按真实注册关系管理插件和工具。插件关闭时保留各工具的独立设置；工具是否可用还取决于当前账号权限和执行服务。
        </p>
      </div>
      {error && (
        <p role="alert" className="operation-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!userId ? <p>请先登录管理账号。</p> : !state && !error ? <p>正在读取插件与工具…</p> : null}
      {state && (
        <PluginManagementView
          state={state}
          busy={busy}
          onPluginToggle={(p) =>
            void change(
              '/assistant/plugins/settings',
              { id: p.id, enabled: !p.enabled, expectedRevision: state.revision },
              p.name + (p.enabled ? '已停用，工具独立设置保留' : '已启用，工具按原独立设置恢复'),
            )
          }
          onToolToggle={(t) =>
            void change(
              '/assistant/tools/settings',
              { name: t.name, enabled: !t.toolEnabled, expectedRevision: state.revision },
              t.name + (t.toolEnabled ? '已停用' : '已启用'),
            )
          }
        />
      )}
      {state && !state.canManage && (
        <p>当前账号可以查看状态和日志；仅有管理权限的超级管理员可修改开关。</p>
      )}
    </section>
  );
}
