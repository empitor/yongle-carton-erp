import { useEffect, useRef, useState } from 'react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
const tableLabels: Record<string, string> = {
  customers: '客户',
  products: '产品',
  orders: '销售订单',
  order_lines: '销售明细',
  suppliers: '供应商',
  purchases: '采购订单',
  purchase_lines: '采购明细',
  purchase_receipts: '采购实收关联',
  stock_items: '库存档案',
  stock_movements: '库存流水',
  flow_documents: '业务单据',
  flow_refs: '单据关联',
  flow_receipt_keys: '收货编号关联',
  flow_file_uses: '原件关联',
  import_executions: '导入回执',
  product_extensions: '产品补充资料',
  order_extensions: '订单补充资料',
  order_line_extensions: '明细补充资料',
};
const fieldLabels: Record<string, string> = {
  customer_order_id: '客户订单',
  purchase_line_id: '采购明细',
  purchase_id: '采购订单',
  stock_id: '库存档案',
  stock_item_id: '库存档案',
  product_id: '产品',
  order_id: '销售订单',
  source_id: '来源',
  source_kind: '来源类型',
  task_id: '生产任务',
  document: '单据内关联',
};
export default function DatabaseDeleteDialog({
  module,
  rows,
  close,
  done,
}: {
  module: string;
  rows: any[];
  close: () => void;
  done: (message: string) => void;
}) {
  const [plan, setPlan] = useState<any>(null),
    [policy, setPolicy] = useState('preserve'),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID()),
    generation = useRef(0);
  const selection = {
    module,
    items: rows.map((r) => ({ id: r.id, version: r.version })),
    inventoryPolicy: policy,
  };
  async function execute(p: any) {
    setBusy(true);
    setError('');
    try {
      const r = await managementRequest('/management/execute', {
        ...selection,
        requestId: requestId.current,
        action: 'delete',
        deletionDigest: p.digest,
        reason: '管理员删除数据库记录',
      });
      window.dispatchEvent(new Event('erp-business-changed'));
      done('已从数据库删除 ' + r.count + ' 条目标记录，关联数据已同步处理。');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  useEffect(() => {
    const g = ++generation.current;
    setBusy(true);
    setError('');
    setPlan(null);
    managementRequest('/management/deletions/preview', selection)
      .then((p) => {
        if (g !== generation.current) return;
        setPlan(p);
        if (!p.hasIndependentImpact) void execute(p);
        else setBusy(false);
      })
      .catch((e) => {
        if (g === generation.current) {
          setError(e.message);
          setBusy(false);
        }
      });
    return () => {
      generation.current++;
    };
  }, [module, policy, rows.map((r) => r.id + ':' + r.version).join(',')]);
  return (
    <ManagementDialog title="删除数据库记录" close={close} busy={busy} danger>
      <p>删除将实际移除目标记录，不能恢复。以下是后端查到的关联处理范围。</p>
      <label>
        库存处理方式
        <select
          value={policy}
          disabled={busy}
          onChange={(e) => {
            requestId.current = crypto.randomUUID();
            setPolicy(e.target.value);
          }}
        >
          <option value="preserve">保留其他库存已有数量，解除被删来源引用</option>
          <option value="recalculate">同时移除被删单据的来源流水并重算库存</option>
        </select>
      </label>
      {plan && (
        <>
          <p>{plan.inventoryEffect}</p>
          <ul>
            {plan.impact.map((r: any, i: number) => (
              <li key={i}>
                {r.action === 'delete' ? '删除' : '解除引用'} · {tableLabels[r.table] || r.table} ·{' '}
                {r.name}
                {r.fields
                  ? '（' + r.fields.map((k: string) => fieldLabels[k] || k).join('、') + '）'
                  : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p className="operation-error" role="alert">
          {error}
        </p>
      )}
      <div className="management-dialog-actions">
        <button disabled={busy} onClick={close}>
          返回
        </button>
        {plan && (plan.hasIndependentImpact || error) && (
          <button className="danger-solid" disabled={busy} onClick={() => void execute(plan)}>
            {busy ? '正在删除…' : '删除以上范围'}
          </button>
        )}
      </div>
    </ManagementDialog>
  );
}
