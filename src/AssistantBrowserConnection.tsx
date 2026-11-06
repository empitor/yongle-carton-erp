import { useEffect, useState } from 'react';
import { managementRequest, useAuthState } from './session';
export default function AssistantBrowserConnection() {
  const user = useAuthState()?.actor?.id;
  const [status, setStatus] = useState<{ installed: boolean; connected: boolean }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [unavailable, setUnavailable] = useState(false);
  // 部署到服务器后，独立浏览器窗口开在服务器上，员工看不到，不显示这个入口。
  useEffect(() => {
    if (user)
      void managementRequest<any>('/assistant')
        .then((s) => setUnavailable(s.localFeaturesAvailable === false))
        .catch(() => {});
  }, [user]);
  useEffect(() => {
    setStatus(undefined);
    if (user && !unavailable)
      void managementRequest('/assistant/browser')
        .then(setStatus)
        .catch((e) => setError(e.message));
  }, [user]);
  const change = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(
        await managementRequest(
          '/assistant/browser/' + (status?.connected ? 'disconnect' : 'connect'),
          status?.connected ? {} : { route: location.hash || '#dashboard' },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '浏览器连接失败');
    } finally {
      setBusy(false);
    }
  };
  if (unavailable) return null;
  return (
    <section className="panel ai-browser-connection" aria-label="本地ERP浏览器">
      <div>
        <h3>让助手操作浏览器</h3>
        <p>打开一个独立窗口供助手截图和点击，只能操作本机 ERP，沿用当前账号权限。</p>
      </div>
      <button disabled={busy || !user || !status?.installed} onClick={() => void change()}>
        {busy ? '正在处理…' : status?.connected ? '断开可控浏览器' : '打开可控ERP浏览器'}
      </button>
      <span role="status">
        {status?.connected
          ? ' 已连接'
          : status && !status.installed
            ? ' 本机未找到 Chrome 或 Edge'
            : ''}
      </span>
      {error && (
        <p role="alert" className="operation-error">
          {error}
        </p>
      )}
    </section>
  );
}
