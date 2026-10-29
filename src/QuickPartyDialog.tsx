import { useState } from 'react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
export default function QuickPartyDialog({
  close,
  saved,
}: {
  close: () => void;
  saved: (supplier: any) => void;
}) {
  const [form, setForm] = useState({ name: '', contact: '', phone: '', address: '', notes: '' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <ManagementDialog title="新增供应商" busy={busy} close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            saved(await managementRequest('/suppliers', form));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-intro">保存后直接选入当前采购单，已填明细会保留。</p>
        <div className="form-grid">
          {(
            [
              ['name', '供应商名称 *', 100],
              ['contact', '联系人', 60],
              ['phone', '联系电话', 50],
              ['address', '供应商地址', 300],
              ['notes', '备注', 1000],
            ] as const
          ).map(([k, label, max]) => (
            <label className={'field' + (k === 'address' || k === 'notes' ? ' wide' : '')} key={k}>
              <span>{label}</span>
              <input
                required={k === 'name'}
                maxLength={max}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            保存供应商
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
