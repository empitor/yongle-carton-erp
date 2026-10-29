import { useEffect, useRef, useState } from 'react';
import ManagementDialog from './ManagementDialog';
import { useAuthState } from './session';
export default function BatchImportDialog({
  files,
  request,
  close,
  done,
}: {
  files: { id: string; fileName: string }[];
  request: <T>(path: string, body?: unknown) => Promise<T>;
  close: () => void;
  done: () => void;
}) {
  const auth = useAuthState(),
    api = useRef(request),
    [rows, setRows] = useState<any[]>(
      files.map((f) => ({ ...f, preview: null, error: '', receipt: null })),
    ),
    [busy, setBusy] = useState(false),
    [agreed, setAgreed] = useState(false);
  const prepare = async () => {
    setBusy(true);
    setAgreed(false);
    for (const file of files) {
      let row: any;
      try {
        const w = await api.current<any>('/' + file.id);
        if (w.imported && !w.imported.historical) {
          row = { receipt: { orderNumber: w.imported.orderNumber }, error: '' };
        } else {
          row = {
            preview: await api.current('/' + file.id + '/preview', {
              expectedRevision: w.revision,
            }),
            error: '',
          };
        }
      } catch (e) {
        row = { error: (e as Error).message, preview: null };
      }
      setRows((v) => v.map((r) => (r.id === file.id && !r.receipt ? { ...r, ...row } : r)));
    }
    setBusy(false);
  };
  useEffect(() => {
    void prepare();
  }, []);
  return (
    <ManagementDialog title="批量核对并导入客户订单" busy={busy} close={close}>
      <p>
        逐份显示真实完整预览，正式提交仍由原导入服务校验。成功文件不重复导入；失败文件保留并单独报告，可返回工作区修正匹配后继续。
      </p>
      {rows.map((r) => (
        <section className="batch-import-preview" key={r.id}>
          <h3>{r.fileName}</h3>
          {r.error && (
            <p className="form-error" role="alert">
              {r.error}
            </p>
          )}
          {r.receipt ? (
            <p className="success-banner">已正式导入 {r.receipt.orderNumber}</p>
          ) : (
            r.preview && (
              <details open>
                <summary>
                  客户：{r.preview.plan.customer.name} · 合计 {r.preview.plan.total} 元
                </summary>
                <p>
                  订单日期 {r.preview.plan.order.orderDate} · 交期{' '}
                  {r.preview.plan.order.deliveryDate} · 客户单号{' '}
                  {r.preview.plan.order.externalPurchaseOrder || '未填写'} ·{' '}
                  {r.preview.plan.order.status}
                </p>
                <p>
                  税费：{r.preview.plan.order.taxRate || '未明确'}{' '}
                  {r.preview.plan.order.taxMode || ''} · 结算 {r.preview.plan.order.roundingPolicy}
                </p>
                <div className="table-wrap">
                  <table className="flow-table">
                    <thead>
                      <tr>
                        {[
                          '产品名称',
                          '规格',
                          '数量 / 单位',
                          '单价 / 元',
                          '档案匹配',
                          '分项交期 / 税费',
                          '备注',
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.preview.plan.order.lines.map((l: any, i: number) => (
                        <tr key={i}>
                          <td>{l.productName}</td>
                          <td>{l.specification}</td>
                          <td>
                            {l.quantity} {l.unit}
                          </td>
                          <td>{l.unitPriceExact ?? String(l.unitPriceCents / 100)}</td>
                          <td>
                            {r.preview.plan.products[i]?.name} ·{' '}
                            {r.preview.plan.products[i]?.mode === 'new' ? '新建' : '已有'}
                          </td>
                          <td>
                            {l.deliveryDate || ''} {l.taxRate || ''} {l.taxMode || ''}
                          </td>
                          <td>{l.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {r.preview.plan.warnings.map((w: string, i: number) => (
                  <p key={i} className="help-text">
                    {w}
                  </p>
                ))}
              </details>
            )
          )}
        </section>
      ))}
      {!auth?.actor?.localAdministrator && (
        <label className="check-label">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          已核对以上完整明细及档案匹配
        </label>
      )}
      <div className="management-dialog-actions">
        <button disabled={busy} onClick={close}>
          返回工作区
        </button>
        <button disabled={busy} onClick={() => void prepare()}>
          重新预览未成功文件
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            (!auth?.actor?.localAdministrator && !agreed) ||
            !rows.some((r) => r.preview && !r.receipt && !r.error)
          }
          onClick={async () => {
            setBusy(true);
            for (const row of rows.filter((r) => r.preview && !r.receipt && !r.error)) {
              try {
                const receipt = await api.current<any>('/' + row.id + '/execute', {
                  previewId: row.preview.id,
                  acknowledged: true,
                });
                setRows((v) => v.map((r) => (r.id === row.id ? { ...r, receipt, error: '' } : r)));
              } catch (e) {
                setRows((v) =>
                  v.map((r) => (r.id === row.id ? { ...r, error: (e as Error).message } : r)),
                );
              }
            }
            setBusy(false);
            done();
          }}
        >
          {busy ? '正在处理…' : '按以上预览正式导入'}
        </button>
      </div>
    </ManagementDialog>
  );
}
