import { useEffect, useState } from 'react';
import { managementRequest } from './session';
export default function AssistantCapabilities() {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [notice, setNotice] = useState('');
  const load = () => managementRequest('/assistant/tools').then(setState);
  useEffect(() => {
    let live = true;
    managementRequest('/assistant/tools')
      .then((v) => live && setState(v))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (tool: any) => {
    setBusy(tool.name);
    setError('');
    setNotice('');
    try {
      await managementRequest('/assistant/tools/settings', {
        name: tool.name,
        enabled: !tool.enabled,
        expectedRevision: state.revision,
      });
      await load();
      setNotice(tool.name + ' 已' + (tool.enabled ? '停用' : '启用') + '，已保存。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      await load().catch(() => {});
    } finally {
      setBusy('');
    }
  };
  const modules = [...new Set<string>((state?.tools || []).map((t: any) => t.module))];
  return (
    <section className="panel" style={{ padding: 20 }}>
      <h2>AI 工具管理</h2>
      <p style={{ color: 'var(--muted)' }}>
        工具来自后端实时注册表。停用会同时阻止模型调用，不影响人工操作。库存确认、冲销和永久删除仍需原有身份审核。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {modules.map((module) => (
        <section key={module} style={{ marginTop: 24 }}>
          <h3>{module}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>工具及用途</th>
                  <th>接入状态</th>
                  <th>参数结构</th>
                  <th>最近执行（当前账号）</th>
                  <th>启用</th>
                </tr>
              </thead>
              <tbody>
                {state.tools
                  .filter((t: any) => t.module === module)
                  .map((t: any) => (
                    <tr key={t.name}>
                      <td style={{ whiteSpace: 'normal', minWidth: 240, maxWidth: 440 }}>
                        <strong>{t.name}</strong>
                        <div style={{ color: 'var(--muted)', marginTop: 6 }}>{t.description}</div>
                      </td>
                      <td>
                        {t.status}
                        <small style={{ display: 'block' }}>
                          {t.risk === 'read'
                            ? '只读'
                            : t.risk === 'high'
                              ? '高风险审核'
                              : '受控业务操作'}
                        </small>
                      </td>
                      <td>
                        <details>
                          <summary>查看参数及必填项</summary>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              maxWidth: 400,
                              maxHeight: 320,
                              overflow: 'auto',
                            }}
                          >
                            {JSON.stringify(t.parameters, null, 2)}
                          </pre>
                        </details>
                      </td>
                      <td>
                        {t.lastExecution ? (
                          <>
                            <div>{t.lastExecution.state}</div>
                            <small>{new Date(t.lastExecution.at).toLocaleString('zh-CN')}</small>
                          </>
                        ) : (
                          '暂无执行记录'
                        )}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={'启用 ' + t.name}
                          checked={t.enabled}
                          disabled={!state.canManage || !!busy}
                          onChange={() => void toggle(t)}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {!state && <p>正在读取工具注册表…</p>}
      {state && !state.canManage && <p>当前账号可以查看工具，仅超级管理员可修改启停。</p>}
    </section>
  );
}
