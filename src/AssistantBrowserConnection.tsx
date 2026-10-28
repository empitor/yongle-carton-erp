import { useEffect, useState } from 'react';
import { managementRequest, useAuthState } from './session';
export default function AssistantBrowserConnection() {
  const user = useAuthState()?.actor?.id;
  const [status, setStatus] = useState<{ installed: boolean; connected: boolean }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setStatus(undefined);
    if (user)
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
  return (
    <section className="panel ai-browser-connection" aria-label="本地ERP浏览器">
      <h3>截图与鼠标键盘后备</h3>
      <p>
        需要视觉操作时，打开独立的可控 ERP 窗口。沿用当前登录权限，只操作本机
        ERP；密码和密钥区域仍由人维护。
      </p>
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
