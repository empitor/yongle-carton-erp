import { useState, useRef } from 'react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
import { today } from '../shared/domain';
import { quantityUnits, quantityString } from '../shared/operations';
export default function ProductionBatchDialog({
  tasks,
  items,
  selected,
  close,
  done,
}: {
  tasks: any[];
  items: any[];
  selected: number[];
  close: () => void;
  done: (r: any) => void;
}) {
  const [rows, setRows] = useState(
      tasks
        .filter((t) => !t.archived && ['draft', 'confirmed'].includes(t.status) && t.progress < 100)
        .map((t) => ({
          ...t,
          checked: selected.includes(t.id),
          good: quantityString(quantityUnits(t.quantity) - quantityUnits(t.completed || '0')),
          scrap: '0',
          finishedStockId: '',
        })),
    ),
    [date, setDate] = useState(today()),
    [operator, setOperator] = useState(''),
    [allocation, setAllocation] = useState<'shared-proportional' | 'explicit'>(
      'shared-proportional',
    ),
    [createMissing, setCreateMissing] = useState(true),
    [materials, setMaterials] = useState([{ stockId: '', issued: '', returned: '0' }]),
    [distribution, setDistribution] = useState<
      Record<string, { issued: string; returned: string }>
    >({}),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const request = useRef(crypto.randomUUID()),
    raw = items.filter((s) => s.kind === 'raw' && s.unit === '张' && !s.archived),
    chosen = rows.filter((r) => r.checked);
  const changed = () => {
    setPreview(null);
    request.current = crypto.randomUUID();
  };
  const rowChange = (i: number, key: string, value: any) => {
    changed();
    setRows((v) => v.map((r, j) => (i === j ? { ...r, [key]: value } : r)));
  };
  const materialChange = (i: number, key: string, value: string) => {
    changed();
    setMaterials((v) => v.map((m, j) => (i === j ? { ...m, [key]: value } : m)));
  };
  const build = () => ({
    requestId: request.current,
    date,
    operator,
    taskIds: chosen.map((r) => r.id),
    allocation,
    createMissingFinished: createMissing,
    quantities: chosen.map((r) => ({ taskId: r.id, goodQuantity: r.good, scrapQuantity: r.scrap })),
    materials: materials.map((m) => ({ ...m, stockId: Number(m.stockId), unit: '张' })),
    finishedStocks: chosen
      .filter((r) => r.finishedStockId)
      .map((r) => ({ taskId: r.id, stockId: Number(r.finishedStockId) })),
    ...(allocation === 'explicit'
      ? {
          distribution: chosen.map((r) => ({
            taskId: r.id,
            materials: materials
              .filter((m) => Number(distribution[r.id + ':' + m.stockId]?.issued || 0) > 0)
              .map((m) => ({
                stockId: Number(m.stockId),
                issued: distribution[r.id + ':' + m.stockId].issued,
                returned: distribution[r.id + ':' + m.stockId].returned,
              })),
          })),
        }
      : {}),
  });
  return (
    <ManagementDialog title="整批领料与完工入库" close={close} busy={busy}>
      <form
        className="production-batch-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const input = build();
            if (!preview)
              setPreview(await managementRequest('/flow/production-completion/preview', input));
            else
              done(
                await managementRequest('/flow/production-completion/execute', {
                  input,
                  previewDigest: preview.previewDigest,
                }),
              );
          } catch (e) {
            setError((e as Error).message);
            setPreview(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-intro">
          选择实际完成任务并填写真实产量与领退料。预填良品是任务剩余量，请按实绩核对；预览不影响库存。
        </p>
        <div className="form-grid">
          <label className="field">
            实际完工日期 *
            <input
              required
              type="date"
              value={date}
              onChange={(e) => {
                changed();
                setDate(e.target.value);
              }}
            />
          </label>
          <label className="field">
            实际操作人员 *
            <input
              required
              maxLength={100}
              value={operator}
              onChange={(e) => {
                changed();
                setOperator(e.target.value);
              }}
            />
          </label>
        </div>
        <div className="table-wrap">
          <table className="flow-table">
            <thead>
              <tr>
                {['选择', '任务 / 产品', '剩余任务', '实际良品', '实际废品', '成品档案'].map(
                  (s) => (
                    <th key={s}>{s}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={'选择完工任务' + r.number}
                      checked={r.checked}
                      onChange={(e) => rowChange(i, 'checked', e.target.checked)}
                    />
                  </td>
                  <td>
                    {r.number}
                    <span className="sub">
                      {r.productName || items.find((s) => s.productId === r.productId)?.name}
                    </span>
                  </td>
                  <td>
                    {quantityString(quantityUnits(r.quantity) - quantityUnits(r.completed || '0'))}{' '}
                    {r.unit}
                  </td>
                  <td>
                    <input
                      aria-label={r.number + '实际良品'}
                      required={r.checked}
                      value={r.good}
                      onChange={(e) => rowChange(i, 'good', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={r.number + '实际废品'}
                      required={r.checked}
                      value={r.scrap}
                      onChange={(e) => rowChange(i, 'scrap', e.target.value)}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={r.number + '成品档案'}
                      value={r.finishedStockId}
                      onChange={(e) => rowChange(i, 'finishedStockId', e.target.value)}
                    >
                      <option value="">自动匹配现有档案</option>
                      {items
                        .filter(
                          (s) =>
                            s.kind === 'finished' &&
                            s.productId === r.productId &&
                            s.unit === r.unit &&
                            !s.archived,
                        )
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} · {s.specification}
                          </option>
                        ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label className="field">
          领料归属方式
          <select
            value={allocation}
            onChange={(e) => {
              changed();
              setAllocation(e.target.value as any);
            }}
          >
            <option value="shared-proportional">整批共享，按实际产量比例分配整张</option>
            <option value="explicit">逐任务填写实际领退料分配</option>
          </select>
        </label>
        <p className="help-text">只登记领料归属，不推断切割布局或纸板与纸箱的换算。</p>
        <h3>整批实际领退料（张）</h3>
        {materials.map((m, i) => (
          <div className="batch-material-row" key={i}>
            <select
              required
              aria-label={'原料' + (i + 1)}
              value={m.stockId}
              onChange={(e) => materialChange(i, 'stockId', e.target.value)}
            >
              <option value="">选择真实纸板库存</option>
              {raw.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · 库存 {s.quantity} 张
                </option>
              ))}
            </select>
            {(['issued', 'returned'] as const).map((key) => (
              <label key={key}>
                {key === 'issued' ? '领用' : '退回'} *
                <input
                  required
                  inputMode="numeric"
                  value={m[key]}
                  onChange={(e) => materialChange(i, key, e.target.value)}
                />
              </label>
            ))}
            <button
              type="button"
              disabled={materials.length === 1}
              onClick={() => {
                changed();
                setMaterials((v) => v.filter((_, j) => j !== i));
              }}
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            changed();
            setMaterials((v) => [...v, { stockId: '', issued: '', returned: '0' }]);
          }}
        >
          添加领料品种
        </button>
        {allocation === 'explicit' &&
          chosen.map((r) => (
            <fieldset className="form-section" key={r.id}>
              <legend>{r.number}的实际分配</legend>
              {materials
                .filter((m) => m.stockId)
                .map((m) => {
                  const key = r.id + ':' + m.stockId,
                    v = distribution[key] || { issued: '0', returned: '0' };
                  return (
                    <div className="batch-material-row" key={key}>
                      <span>{raw.find((s) => s.id === Number(m.stockId))?.name}</span>
                      {(['issued', 'returned'] as const).map((k) => (
                        <label key={k}>
                          {k === 'issued' ? '领用' : '退回'}
                          <input
                            required
                            value={v[k]}
                            onChange={(e) => {
                              changed();
                              setDistribution((d) => ({
                                ...d,
                                [key]: { ...v, [k]: e.target.value },
                              }));
                            }}
                          />
                        </label>
                      ))}
                    </div>
                  );
                })}
            </fieldset>
          ))}
        <label className="check-label">
          <input
            type="checkbox"
            checked={createMissing}
            onChange={(e) => {
              changed();
              setCreateMissing(e.target.checked);
            }}
          />
          没有匹配档案时，按真实任务产品建立成品档案
        </label>
        {preview && (
          <div className="completion-preview">
            <h3>完工预览 · {preview.results.length}项</h3>
            <p>{preview.allocationBasis}</p>
            {preview.results.map((r: any) => (
              <p key={r.taskId}>
                {rows.find((t) => t.id === r.taskId)?.number}：良品 {r.goodQuantity}、废品{' '}
                {r.scrapQuantity}；
                {r.materials
                  .map(
                    (m: any) =>
                      raw.find((s) => s.id === m.stockId)?.name +
                      ' 领用' +
                      m.issued +
                      ' / 退回' +
                      m.returned +
                      '张',
                  )
                  .join('；')}
              </p>
            ))}
            <p>提交后登记正式生产、领退料流水及成品入库。</p>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="management-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || !chosen.length}>
            {busy ? '正在处理…' : preview ? '登记实际完工并入库' : '预览领料与完工'}
          </button>
        </div>
      </form>
    </ManagementDialog>
  );
}
