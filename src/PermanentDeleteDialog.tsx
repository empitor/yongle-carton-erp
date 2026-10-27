import { useState } from 'react';
import { ShieldAlert, Trash2 } from 'lucide-react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
import type { RecordEntity } from '../shared/operations';
export default function PermanentDeleteDialog({
  entity,
  rows,
  close,
  done,
}: {
  entity: RecordEntity;
  rows: any[];
  close: () => void;
  done: (message: string) => void;
}) {
  const [preview, setPreview] = useState<any>(null),
    [include, setInclude] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [agreed, setAgreed] = useState(false);
  return (
    <ManagementDialog
      title={'永久删除 ' + rows.length + ' 条记录'}
      close={close}
      busy={busy}
      danger
    >
      <div className="permanent-warning">
        <ShieldAlert size={23} />
        <div>
          <strong>此操作会真正移除业务记录，不能从回收站恢复。</strong>
          <p>
            先生成影响预览，确认范围后再次验证密码。未选中的其他客户和产品、操作审计及订单原始来源凭据保留。
          </p>
        </div>
      </div>
      <p className="selected-record-names">{rows.map((r) => r.number || r.name).join('、')}</p>
      {['customers', 'products'].includes(entity) && (
        <label className="impact-consent">
          <input
            type="checkbox"
            checked={include}
            disabled={busy}
            onChange={(e) => {
              setInclude(e.target.checked);
              setPreview(null);
              setAgreed(false);
              setPassword('');
              setConfirmation('');
            }}
          />
          如果存在关联订单，我要求一并永久删除这些整张订单及全部明细（须先查看下方清单）。
        </label>
      )}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          setPreview(null);
          setAgreed(false);
          setConfirmation('');
          setPassword('');
          try {
            setPreview(
              await managementRequest('/admin/permanent-deletions/preview', {
                entity,
                items: rows.map((r) => ({ id: r.id, version: r.version })),
                includeRelatedOrders: include,
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '正在处理…' : preview ? '重新生成影响预览' : '生成删除影响预览'}
      </button>
      {preview && (
        <div className="deletion-impact">
          <h3>本次将永久移除</h3>
          <div className="impact-counts">
            {preview.plan.counts.suppliers !== undefined && (
              <span>
                供应商 <b>{preview.plan.counts.suppliers}</b>
              </span>
            )}
            {preview.plan.counts.purchases !== undefined && (
              <span>
                采购单 <b>{preview.plan.counts.purchases}</b>
              </span>
            )}
            {preview.plan.counts.stock_items !== undefined && (
              <span>
                库存品 <b>{preview.plan.counts.stock_items}</b>
              </span>
            )}
            <span>
              客户 <b>{preview.plan.counts.customers}</b>
            </span>
            <span>
              产品 <b>{preview.plan.counts.products}</b>
            </span>
            <span>
              订单 <b>{preview.plan.counts.orders}</b>
            </span>
            <span>
              订单明细 <b>{preview.plan.counts.lines}</b>
            </span>
          </div>
          {preview.plan.blockers.map((s: string) => (
            <p key={s} className="operation-error" role="alert">
              {s}
            </p>
          ))}
          <details open={!!preview.plan.relatedOrders.length}>
            <summary>关联订单清单（{preview.plan.relatedOrders.length}张）</summary>
            <ul className="impact-record-list">
              {preview.plan.relatedOrders.map((o: any) => (
                <li key={o.id}>
                  <strong>{o.number}</strong> · {o.customerName} · {o.status} ·{' '}
                  {o.archived ? '已归档' : '正常'} · 全部{o.lines.length}项明细
                </li>
              ))}
            </ul>
          </details>
          {preview.plan.orders.some((o: any) =>
            ['生产中', '待发货', '已发货'].includes(o.status),
          ) && (
            <p className="operation-error">包含已进入生产或发货的历史订单，请特别核对业务影响。</p>
          )}
          <p>
            预览有效至 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}
            。记录或关联改变时必须重新预览。
          </p>
          {!preview.plan.blockers.length && (
            <form
              className="auth-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!agreed) return;
                setBusy(true);
                setError('');
                try {
                  const result = await managementRequest<any>(
                    '/admin/permanent-deletions/execute',
                    { previewId: preview.id, acknowledged: true, confirmation, password },
                  );
                  done(
                    ['suppliers', 'purchases', 'stock_items'].includes(entity)
                      ? '已永久删除选中业务记录。'
                      : '已永久删除：客户' +
                          result.counts.customers +
                          '条、产品' +
                          result.counts.products +
                          '条、订单' +
                          result.counts.orders +
                          '张、明细' +
                          result.counts.lines +
                          '项。审计与来源凭据保留。',
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setPassword('');
                  setBusy(false);
                }
              }}
            >
              <label className="impact-consent">
                <input
                  type="checkbox"
                  required
                  checked={agreed}
                  disabled={busy}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                我已核对所有记录和关联订单，确认上述不可恢复的删除范围。
              </label>
              <label>
                输入“永久删除”确认
                <input
                  autoComplete="off"
                  value={confirmation}
                  disabled={busy}
                  onChange={(e) => setConfirmation(e.target.value)}
                  required
                  pattern="永久删除"
                />
              </label>
              <label>
                再次验证当前账号密码
                <input
                  aria-label="永久删除验证密码"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <div className="management-dialog-actions">
                <button type="button" disabled={busy} onClick={close}>
                  取消
                </button>
                <button
                  className="danger-solid"
                  type="submit"
                  disabled={busy || !agreed || confirmation !== '永久删除' || !password}
                >
                  <Trash2 size={15} />
                  {busy ? '正在删除…' : '确认永久删除'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {error && (
        <p className="operation-error" role="alert">
          {error}
        </p>
      )}
    </ManagementDialog>
  );
}
