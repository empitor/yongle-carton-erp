import { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2, RotateCcw, Code2 } from 'lucide-react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
import { developerModules, developerNames, developerFieldNames } from '../shared/developer';
import './developer.css';
import DatabaseDeleteDialog from './DatabaseDeleteDialog';
const numberFields = new Set([
  'length',
  'width',
  'height',
  'priceCents',
  'unitPriceCents',
  'customerId',
  'supplierId',
  'productId',
  'stockId',
  'stockItemId',
  'finishedStockId',
  'taskId',
  'orderId',
  'orderLineId',
  'purchaseLineId',
  'customerOrderId',
  'correctionOf',
]);
const options: Record<string, string[]> = {
  status: ['草稿', '已确认', '生产中', '待发货', '已发货', '已取消', '待订货', '已订货'],
  kind: ['raw', 'finished'],
  dimensionUnit: ['mm', 'cm'],
  priceBasis: ['area', 'quantity'],
  roundingPolicy: ['exact-cents', 'half-up-cent'],
};
function Fields({
  value,
  change,
  path = '',
}: {
  value: any;
  change: (v: any) => void;
  path?: string;
}) {
  if (Array.isArray(value))
    return (
      <div className="dev-array">
        {value.map((item, i) => (
          <section key={i}>
            <header>
              <strong>第{i + 1}项</strong>
              <button
                type="button"
                onClick={() => change(value.filter((_: any, j: number) => i !== j))}
              >
                移除本项
              </button>
            </header>
            <Fields
              value={item}
              path={path}
              change={(v) => change(value.map((x: any, j: number) => (j === i ? v : x)))}
            />
          </section>
        ))}
        <button
          type="button"
          onClick={() =>
            change([
              ...value,
              typeof value[0] === 'object' ? { ...structuredClone(value[0]), id: undefined } : 0,
            ])
          }
        >
          <Plus size={14} />
          增加明细
        </button>
      </div>
    );
  if (value && typeof value === 'object')
    return (
      <div className="dev-fields">
        {Object.entries(value)
          .filter(([k]) => !['version', 'requestId'].includes(k))
          .map(([key, v]) => {
            const title = developerFieldNames[key] || key,
              update = (x: any) => change({ ...value, [key]: x });
            if (v && typeof v === 'object')
              return (
                <fieldset key={key} className="dev-nested">
                  <legend>{title}</legend>
                  <Fields value={v} change={update} path={key} />
                </fieldset>
              );
            if (typeof v === 'boolean')
              return (
                <label key={key} className="dev-check">
                  <input type="checkbox" checked={v} onChange={(e) => update(e.target.checked)} />
                  {title}
                </label>
              );
            return (
              <label key={key}>
                {title}
                {options[key] ? (
                  <select
                    aria-label={'开发者 ' + title}
                    value={String(v ?? '')}
                    onChange={(e) => update(e.target.value || null)}
                  >
                    <option value="">未填写</option>
                    {options[key].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : ['notes', 'requirements', 'terms', 'specification', 'productName'].includes(
                    key,
                  ) ? (
                  <textarea
                    aria-label={'开发者 ' + title}
                    value={String(v ?? '')}
                    onChange={(e) => update(e.target.value)}
                  />
                ) : (
                  <input
                    aria-label={'开发者 ' + title}
                    disabled={key === 'id'}
                    type={
                      numberFields.has(key) || typeof v === 'number'
                        ? 'number'
                        : /Date$/.test(key) || key === 'date'
                          ? 'date'
                          : 'text'
                    }
                    step="any"
                    value={v == null ? '' : String(v)}
                    placeholder={v === null ? '未填写' : ''}
                    onChange={(e) =>
                      update(
                        e.target.value === ''
                          ? null
                          : numberFields.has(key) || typeof v === 'number'
                            ? Number(e.target.value)
                            : e.target.value,
                      )
                    }
                  />
                )}
              </label>
            );
          })}
      </div>
    );
  return (
    <input
      aria-label={path || '编号'}
      type="number"
      value={value ?? ''}
      onChange={(e) => change(Number(e.target.value))}
    />
  );
}
export default function DeveloperEditor({
  close,
  initialModule = 'orders',
}: {
  close: () => void;
  initialModule?: string;
}) {
  const [deleting, setDeleting] = useState<any[] | null>(null);
  const [module, setModule] = useState(initialModule),
    [data, setData] = useState<any>(null),
    [selected, setSelected] = useState<(number | string)[]>([]),
    [editing, setEditing] = useState<any>(null),
    [input, setInput] = useState<any>(null),
    [q, setQ] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [ask, setAsk] = useState<any>(null),
    [batch, setBatch] = useState(false),
    [batchKey, setBatchKey] = useState('notes'),
    [batchValue, setBatchValue] = useState('');
  const generation = useRef(0),
    submission = useRef<{ key: string; id: string } | null>(null);
  async function load() {
    const g = ++generation.current;
    try {
      const next = await managementRequest(
        module === 'workspaces' ? '/management/workspaces' : '/management/records?module=' + module,
      );
      if (g === generation.current) setData(next);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    setData(null);
    setSelected([]);
    setInput(null);
    setEditing(null);
    setQ('');
    setAsk(null);
    setError('');
    setMessage('');
    void load();
    return () => {
      generation.current++;
    };
  }, [module]);
  const records =
    module === 'workspaces'
      ? [
          ...(data?.active || []).map((r: any) => ({
            record: { ...r, id: r.id, version: r.revision, archived: false, name: r.fileName },
          })),
          ...(data?.trash || []).map((r: any) => ({
            record: { ...r, id: r.id, archived: true, name: r.fileName },
          })),
        ]
      : data?.records || [];
  const filtered = records.filter((r: any) =>
    JSON.stringify([
      r.record.name,
      r.record.number,
      r.record.customerName,
      r.record.supplierName,
      r.record.id,
    ])
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  const chosen = records.filter((r: any) => selected.includes(r.record.id));
  async function act(action: string, rows: any[], patch: any = {}) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const key = JSON.stringify({
        module,
        action,
        rows: rows.map((x) => ({ id: x.record.id, version: x.record.version })),
        patch,
      });
      if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
      const result =
        module === 'workspaces'
          ? await managementRequest<any>('/management/workspaces', {
              action,
              requestId: submission.current!.id,
              items: rows.map((x) => ({
                id: x.record.id,
                ...(x.record.version == null ? {} : { revision: x.record.version }),
              })),
            })
          : await managementRequest<any>('/management/execute', {
              requestId: submission.current!.id,
              module,
              action,
              items: rows.map((x) => ({ id: x.record.id, version: x.record.version })),
              patch,
              reason: '管理员数据维护',
            });
      const failed = result.results?.filter((x: any) => x.success === false) || [];
      if (failed.length) setError(failed.map((x: any) => x.id + '：' + x.message).join('；'));
      setMessage(
        failed.length
          ? '部分记录处理失败，见下方原因。'
          : '已保存服务器实际结果，共' + (result.count ?? result.results.length) + '条。',
      );
      if (module === 'workspaces' && action === 'fork' && result.results[0]?.success) {
        location.hash = '#ai-import?workspace=' + result.results[0].result.id;
        close();
      }
      window.dispatchEvent(new Event('erp-business-changed'));
      setInput(null);
      setEditing(null);
      setSelected([]);
      setAsk(null);
      setBatch(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ManagementDialog title="业务数据管理" close={close} busy={busy}>
      {deleting && (
        <DatabaseDeleteDialog
          module={module}
          rows={deleting}
          close={() => setDeleting(null)}
          done={(message) => {
            setDeleting(null);
            setMessage(message);
            setSelected([]);
            window.dispatchEvent(new Event('erp-business-changed'));
            void load();
          }}
        />
      )}
      <div className="dev-editor">
        <p className="dev-mode-note">
          <Code2 size={17} />
          普通编辑直接保存；删除核对选定范围。关联和库存同步重算，历史和审计保留。
        </p>
        <div className="dev-toolbar">
          <label>
            业务模块
            <select
              aria-label="开发者业务模块"
              value={module}
              disabled={busy}
              onChange={(e) => setModule(e.target.value)}
            >
              {[...developerModules, 'workspaces'].map((m) => (
                <option key={m} value={m}>
                  {developerNames[m]}
                </option>
              ))}
            </select>
          </label>
          <label>
            搜索
            <input
              aria-label="开发者搜索"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="名称、编号"
            />
          </label>
          <button disabled={busy} onClick={() => void load()}>
            刷新
          </button>
          {module !== 'workspaces' && (
            <button
              className="primary"
              disabled={busy || !data}
              onClick={() => {
                setInput(structuredClone(data.template));
                setEditing(null);
              }}
            >
              <Plus size={15} />
              新建
            </button>
          )}
        </div>
        {message && (
          <p role="status" className="dev-success">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="operation-error">
            {error}
          </p>
        )}
        {!!chosen.length && (
          <div className="dev-bulk">
            <strong>已选{chosen.length}条</strong>
            <button disabled={busy} onClick={() => void act('archive', chosen)}>
              归档
            </button>
            <button disabled={busy} onClick={() => void act('restore', chosen)}>
              <RotateCcw size={14} />
              恢复
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                module === 'workspaces'
                  ? void act('delete', chosen)
                  : setDeleting(chosen.map((r: any) => r.record))
              }
            >
              <Trash2 size={14} />
              删除
            </button>
            {module !== 'workspaces' && <button onClick={() => setBatch(!batch)}>批量修改</button>}
          </div>
        )}
        {batch && (
          <div className="dev-bulk">
            <select
              aria-label="批量修改字段"
              value={batchKey}
              onChange={(e) => setBatchKey(e.target.value)}
            >
              {[
                'notes',
                ...(module === 'orders'
                  ? ['orderDate', 'deliveryDate', 'status']
                  : module === 'purchases'
                    ? ['orderDate', 'expectedDate', 'status']
                    : ['arrival', 'task', 'production', 'delivery'].includes(module)
                      ? ['date']
                      : []),
              ].map((k) => (
                <option key={k} value={k}>
                  {developerFieldNames[k]}
                </option>
              ))}
            </select>
            <input
              aria-label="批量修改值"
              value={batchValue}
              onChange={(e) => setBatchValue(e.target.value)}
            />
            <button
              onClick={() =>
                setAsk({ action: 'update', rows: chosen, patch: { [batchKey]: batchValue } })
              }
            >
              核对并批量保存
            </button>
          </div>
        )}
        {ask && (
          <div className="dev-confirm">
            <strong>
              {ask.action === 'permanent-delete' || ask.action === 'purge'
                ? '删除不可恢复'
                : '即将执行：' + ask.action}{' '}
              · {ask.rows.length}条
            </strong>
            <p>
              {ask.rows.map((x: any) => x.record.number || x.record.name || x.record.id).join('、')}
            </p>
            {ask.patch && <p>修改：{JSON.stringify(ask.patch)}</p>}
            <button disabled={busy} onClick={() => setAsk(null)}>
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void act(ask.action, ask.rows, ask.patch)}
            >
              确认此范围
            </button>
          </div>
        )}
        <div className="dev-records">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="全选开发者筛选结果"
                    checked={
                      !!filtered.length &&
                      filtered.every((x: any) => selected.includes(x.record.id))
                    }
                    onChange={(e) =>
                      setSelected(e.target.checked ? filtered.map((x: any) => x.record.id) : [])
                    }
                  />
                </th>
                <th>记录 / 编号</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r: any) => (
                <tr key={r.record.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={'选择开发者记录 ' + r.record.id}
                      checked={selected.includes(r.record.id)}
                      onChange={(e) =>
                        setSelected((a) =>
                          e.target.checked
                            ? [...a, r.record.id]
                            : a.filter((id) => id !== r.record.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <strong>{r.record.number || r.record.name}</strong>
                    <small>
                      #{r.record.id} {r.record.customerName || r.record.supplierName || ''}
                    </small>
                  </td>
                  <td>
                    {r.record.archived
                      ? '已归档'
                      : r.record.status || r.record.task?.state || '正常'}
                  </td>
                  <td>
                    <div className="dev-actions">
                      <button
                        disabled={busy}
                        onClick={() => void act(r.record.archived ? 'restore' : 'archive', [r])}
                      >
                        {r.record.archived ? '恢复' : '归档'}
                      </button>

                      {module === 'workspaces' ? (
                        <>
                          <button
                            onClick={() => {
                              location.hash = '#ai-import?workspace=' + r.record.id;
                              close();
                            }}
                          >
                            编辑
                          </button>
                          <button
                            disabled={busy || r.record.archived}
                            onClick={() => void act('fork', [r])}
                          >
                            复制为新识别任务
                          </button>
                          <button disabled={busy} onClick={() => void act('delete', [r])}>
                            删除
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setEditing(r);
                              setInput(structuredClone(r.input));
                            }}
                          >
                            编辑
                          </button>
                          {['arrival', 'task', 'production', 'delivery'].includes(module) &&
                            r.record.status === 'draft' && (
                              <button disabled={busy} onClick={() => void act('confirm', [r])}>
                                确认单据
                              </button>
                            )}
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => setDeleting([r.record])}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <p>暂无匹配记录</p>}
        </div>
        {input && (
          <section className="dev-form">
            <h3>
              {editing
                ? '编辑 ' + (editing.record.number || editing.record.name)
                : '新建' + developerNames[module]}
            </h3>
            <Fields value={input} change={setInput} />
            {module === 'stock_items' && editing && (
              <div className="dev-inventory-adjust">
                <label>
                  盘点后实际数量（{editing.record.unit}）
                  <input
                    aria-label="开发者库存实际数量"
                    id="dev-quantity"
                    defaultValue={editing.record.quantity}
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() => {
                    const quantity = (document.getElementById('dev-quantity') as HTMLInputElement)
                      .value;
                    void act('move', [editing], {
                      action: 'adjust',
                      quantity,
                      date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
                      notes: '开发测试盘点调整',
                    });
                  }}
                >
                  登记盘点调整流水
                </button>
              </div>
            )}
            <div className="management-dialog-actions">
              <button disabled={busy} onClick={() => setInput(null)}>
                取消编辑
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(editing ? 'update' : 'create', editing ? [editing] : [], input)
                }
              >
                <Save size={15} />
                保存业务字段
              </button>
            </div>
          </section>
        )}
      </div>
    </ManagementDialog>
  );
}
