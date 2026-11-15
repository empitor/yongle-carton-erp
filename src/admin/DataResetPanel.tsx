import { useState } from 'react';
import { useAuthState } from '../ui/index';
import { FormField } from '../ui/index';
import { emit } from '../ui/index';
import { businessResetScope, type BusinessResetScope, type ResetPreview } from '../../shared/admin/index';
import { errorMessage } from '../../shared/core/index';
import { readResetPreview, resetData } from './data-api';

/**
 * 数据管理最下面的“初始化业务数据”：默认收起。先选范围、看清理影响，
 * 影响确认后才出现红色的“永久清空所选范围”。
 * 财务里有已结账的月份时，要先勾选“连已结账的月份一起清空”（勾选后重新读一次影响，拿到这次范围的摘要），
 * 提交时带上摘要；范围变了（期间又有人结账、加了记录）服务端会拒绝，请重新查看影响。
 */
export default function DataResetPanel() {
  const auth = useAuthState(),
    [scope, setScope] = useState<BusinessResetScope>('business'),
    [preview, setPreview] = useState<ResetPreview | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    // 业务数据已清空但原件归档没删干净时的提醒，需要人去处理，单独醒目显示。
    [warnings, setWarnings] = useState<string[]>([]);
  if (!auth?.actor?.localAdministrator) return null;
  const finance = preview?.finance,
    closed = finance?.closed || [],
    // 有已结账的月份就要勾选过才能清
    blocked = !!closed.length && !finance?.allowed;
  /** 读清理影响；clearClosedFinance 是“连已结账的月份一起清空”勾没勾 */
  async function readPreview(clearClosedFinance = false) {
    setBusy(true);
    try {
      setPreview(await readResetPreview(scope, clearClosedFinance));
      setMessage('');
      setWarnings([]);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="adm-reset">
      <summary>
        <span>初始化业务数据</span>
        <small>本机最高管理员 · 清空后不能从归档恢复</small>
      </summary>
      <div className="adm-reset-body">
        <p className="adm-reset-note">
          清空选定范围，无法从归档页恢复。账号、审计、AI配置、提示词和单据模板保留。日常记录维护请使用上方编辑、归档和删除。
        </p>
        <div className="adm-reset-row">
          <FormField label="清理范围">
            <select
              aria-label="初始化数据范围"
              value={scope}
              onChange={(e) => {
                // 下拉里只有这三种范围
                const next = businessResetScope.find((s) => s === e.target.value);
                if (next) setScope(next);
                setPreview(null);
              }}
            >
              <option value="business">全部业务记录</option>
              <option value="ai-imports">AI识别工作区及工作原件</option>
              <option value="all">业务记录与AI识别工作区</option>
            </select>
          </FormField>
          <button className="secondary" disabled={busy} onClick={() => void readPreview()}>
            查看清理影响
          </button>
        </div>
        {preview && (
          <div className="adm-reset-impact">
            <p>
              将清空
              {scope === 'ai-imports'
                ? '识别工作区及其工作原件'
                : Object.values(preview.tables || {}).reduce((a, b) => Number(a) + Number(b), 0) + '条业务数据'}
              {scope === 'all' ? '，并清理全部AI识别工作区及工作原件' : ''}
              {scope === 'ai-imports' ? '。' : '，正式导入留下的原件归档一并删除。'}此操作实际删除数据。
            </p>
            {!!closed.length && (
              <>
                <p>
                  财务里有 {closed.length} 个已结账的月份：{closed.map((c) => c.period).join('、')}。
                  清空会连这些月份的凭证和账簿一起清掉。
                </p>
                <label className="adm-check">
                  <input
                    type="checkbox"
                    aria-label="连已结账的月份一起清空"
                    checked={!!preview.finance?.clearClosedFinance}
                    disabled={busy}
                    onChange={(e) => void readPreview(e.target.checked)}
                  />
                  连已结账的月份一起清空
                </label>
              </>
            )}
            <button
              className="danger-solid"
              disabled={busy || blocked}
              onClick={async () => {
                setBusy(true);
                setWarnings([]);
                try {
                  const r = await resetData({
                    scope,
                    // 勾选过已结账的月份：带上这次范围的摘要，服务端核对范围没变才清
                    ...(finance && closed.length ? { clearClosedFinance: true, financeDigest: finance.digest } : {}),
                  });
                  setMessage(
                    '已按实际范围清理 ' +
                      r.count +
                      ' 条' +
                      (scope === 'all' ? '业务数据及' + r.aiImports + '份AI工作区' : '') +
                      (r.archiveCleanup === 'after-commit'
                        ? '；原件归档会在本次操作整体提交后再删除，若整体回滚则保留。'
                        : r.archives
                          ? '，删除原件归档 ' + r.archives + ' 份。'
                          : '。'),
                  );
                  setWarnings(
                    Array.isArray(r.warnings)
                      ? r.warnings.filter((w: unknown) => typeof w === 'string' && w)
                      : [],
                  );
                  setPreview(null);
                  emit('erp-business-changed');
                } catch (e) {
                  setMessage(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              永久清空所选范围
            </button>
          </div>
        )}
        {message && (
          <p role="status" className="adm-reset-message">
            {message}
          </p>
        )}
        {warnings.map((w) => (
          <p key={w} className="flow-warning adm-reset-warning" role="alert">
            {w}
          </p>
        ))}
      </div>
    </details>
  );
}
