import { useState } from 'react';
import { managementRequest, useAuthState } from './session';
export default function DataResetPanel() {
  const auth = useAuthState(),
    [scope, setScope] = useState('business'),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  if (!auth?.actor?.localAdministrator) return null;
  return (
    <details className="data-reset-panel">
      <summary>初始化业务数据（本机最高管理员）</summary>
      <p>
        清空选定范围，无法从归档页恢复。账号、审计、AI配置、提示词和单据模板保留。日常记录维护请使用上方编辑、归档和删除。
      </p>
      <div className="arrival-toolbar">
        <select
          aria-label="初始化数据范围"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setPreview(null);
          }}
        >
          <option value="business">全部业务记录</option>
          <option value="ai-imports">AI识别工作区及工作原件</option>
          <option value="all">业务记录与AI识别工作区</option>
        </select>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setPreview(await managementRequest('/management/reset-preview?scope=' + scope));
              setMessage('');
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          查看清理影响
        </button>
      </div>
      {preview && (
        <>
          <p>
            将清空
            {scope === 'ai-imports'
              ? '识别工作区及其工作原件'
              : Object.values(preview.tables || {}).reduce(
                  (a: any, b: any) => Number(a) + Number(b),
                  0,
                ) + '条业务数据'}
            {scope === 'all' ? '，并清理全部AI识别工作区及工作原件。' : '。'}此操作实际删除数据。
          </p>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await managementRequest<any>('/management/reset', { scope });
                setMessage(
                  '已按实际范围清理 ' +
                    r.count +
                    ' 条' +
                    (scope === 'all' ? '业务数据及' + r.aiImports + '份AI工作区。' : '。'),
                );
                setPreview(null);
                window.dispatchEvent(new Event('erp-business-changed'));
              } catch (e) {
                setMessage((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            永久清空所选范围
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
