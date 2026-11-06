import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { managementRequest, useAuthState } from './session';
const FlowPage = lazy(() => import('./FlowPage'));
import StatusBadge from './StatusBadge';
import FinanceRelated from './finance/FinanceRelated';
import { MarkCards } from './marks/ProductMarks';
import { flowStatusLabel, type FlowKind } from '../shared/physical-flow';
import { formatStockSize } from '../shared/operations';
import { orderNextSteps, purchaseNextSteps, type NextStep } from '../shared/order-next-step';

const stepMode: Partial<Record<NextStep['kind'], FlowKind>> = {
  schedule: 'task',
  confirm_task: 'task',
  complete: 'production',
  delivery: 'delivery',
  confirm_delivery: 'delivery',
  arrival: 'arrival',
  arrival_plan: 'arrival',
};

/** 单据详情的骨架：顶部下一步，中间是单据本身（children），底部是有内容的相关记录。 */
export default function RelatedBusiness({
  entity,
  row,
  children,
}: {
  entity: 'orders' | 'purchases';
  row: any;
  children?: ReactNode;
}) {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [launch, setLaunch] = useState<{ mode: FlowKind; params: any } | null>(null);
  useEffect(() => {
    const changed = () => setRevision((v) => v + 1);
    window.addEventListener('erp-business-changed', changed);
    return () => window.removeEventListener('erp-business-changed', changed);
  }, []);
  useEffect(() => {
    let active = true;
    if (!canEdit) return;
    managementRequest('/business/' + entity + '/' + row.id + '/related')
      .then((v) => {
        if (active) {
          setData(v);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [entity, row.id, row.version, canEdit, revision]);
  const open = (mode: FlowKind, doc: any) => {
    const id = String(doc.flowId || doc.id).replace('flow-', '');
    if (mode === 'arrival' && !/^\d+$/.test(id)) {
      location.hash = 'warehouse?arrivals=1&receipt=' + encodeURIComponent(doc.id);
      return;
    }
    setLaunch({ mode, params: { doc: id } });
  };
  const run = async (step: NextStep) => {
    if (step.kind !== 'confirm') {
      const mode = stepMode[step.kind];
      if (mode) setLaunch({ mode, params: step.params });
      return;
    }
    setBusy(true);
    setError('');
    try {
      await managementRequest('/orders/' + row.id, { ...row, status: '已确认' }, 'PUT');
      window.dispatchEvent(new Event('erp-business-changed'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const records = (title: string, list: any[], mode: FlowKind) =>
    list.length > 0 && (
      <section className="related-section">
        <h3>
          {title} <span>{list.length}</span>
        </h3>
        <div className="related-records">
          {list.map((d) => (
            <button key={d.id} onClick={() => open(mode, d)}>
              <strong>{d.number || d.reference}</strong>
              <span>{d.plannedDate || d.date}</span>
              <StatusBadge status={d.kind ? flowStatusLabel(d) : d.status} />
              {mode === 'task' && (
                <small>
                  已完工 {d.completed} / {d.quantity} {d.unit}
                </small>
              )}
            </button>
          ))}
        </div>
      </section>
    );
  // 还没读到关联记录时不猜下一步，只有草稿确认这种不依赖关联的才先显示
  const plan =
    !canEdit || row.archived
      ? null
      : entity === 'purchases'
        ? purchaseNextSteps(row)
        : row.status === '草稿' || data
          ? orderNextSteps(row, data)
          : null;
  const [primary, ...others] = plan?.steps || [];
  return (
    <>
      <section className="next-step" aria-label="关联业务与下一步">
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!canEdit && <p className="help-text">当前账号只能查看单据，操作需要业务编辑权限。</p>}
        {canEdit && !plan && !error && !row.archived && (
          <p className="help-text" role="status">
            正在读取…
          </p>
        )}
        {plan?.done && (
          <p className="next-step-done">
            <Check size={15} aria-hidden="true" />
            {plan.done}
          </p>
        )}
        {primary && (
          <div className="next-step-main">
            <div>
              <small>下一步</small>
              <strong>{primary.title}</strong>
              {primary.detail && <span>{primary.detail}</span>}
            </div>
            {primary.label && (
              <button className="primary" disabled={busy} onClick={() => void run(primary)}>
                {busy ? '处理中…' : primary.label}
              </button>
            )}
          </div>
        )}
        {others.length > 0 && (
          <ul className="next-step-more" aria-label="其他待办">
            {others.map((step) => (
              <li key={step.key}>
                <span>
                  {step.title}
                  {step.detail && <small> {step.detail}</small>}
                </span>
                {step.label && <button onClick={() => void run(step)}>打开</button>}
              </li>
            ))}
          </ul>
        )}
        {plan?.notes.map((note) => (
          <p className="next-step-note" key={note}>
            {note}
          </p>
        ))}
        {!!plan?.lines.length && (
          <table className="next-step-lines">
            <thead>
              <tr>
                <th>产品</th>
                <th className="numeric">待发</th>
                <th className="numeric">可用库存</th>
                <th className="numeric">完工 / 计划</th>
              </tr>
            </thead>
            <tbody>
              {plan.lines.map((l) => (
                <tr key={l.id}>
                  <td className="cell-wrap" title={l.name}>
                    {l.name}
                  </td>
                  <td className="numeric">
                    {l.remaining} {l.unit}
                  </td>
                  <td className="numeric">{l.available}</td>
                  <td className="numeric">
                    {l.production === 'none' ? <span className="sub">未排产</span> : l.production}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {children}
      {entity === 'orders' && <FinanceRelated kind="orders" id={row.id} />}
      {data && (
        <div className="related-business">
          {entity === 'orders' ? (
            <>
              {records('生产任务', data.tasks, 'task')}
              {records('完工入库记录', data.productions, 'production')}
              {records('送货记录', data.deliveries, 'delivery')}
              {data.purchases.length > 0 && (
                <section className="related-section">
                  <h3>
                    关联采购 <span>{data.purchases.length}</span>
                  </h3>
                  {data.purchases.map((p: any) => (
                    <a className="related-link" href={'#purchases?record=' + p.id} key={p.id}>
                      {p.number} <StatusBadge status={p.arrivalProgress} />
                    </a>
                  ))}
                </section>
              )}
            </>
          ) : (
            <>
              {records('到货计划与实际记录', data.arrivals, 'arrival')}
              {data.orders.map((o: any) => (
                <a className="related-link" href={'#orders?order=' + o.id} key={o.id}>
                  关联销售订单 {o.number} · {o.customerName}
                </a>
              ))}
            </>
          )}
          {data.marks?.length > 0 && (
            <section className="related-section">
              <h3>
                产品唛头 <span>{data.marks.length}</span>
              </h3>
              <MarkCards marks={data.marks} />
            </section>
          )}
          {data.stocks.length > 0 && (
            <details className="related-section">
              <summary>
                {entity === 'orders' ? '对应成品库存' : '对应原材料库存'} {data.stocks.length}
              </summary>
              <p className="help-text">同一档案可能用于多张订单；这里是总余额，不代表本单独占。</p>
              <div className="related-records">
                {data.stocks.map((s: any) => (
                  <a
                    key={s.id}
                    href={'#warehouse?kind=' + s.kind + '&q=' + encodeURIComponent(s.name)}
                  >
                    <strong>{s.name}</strong>
                    <span>{s.specification || formatStockSize(s)}</span>
                    <b>
                      {s.quantity} {s.unit}
                    </b>
                  </a>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {launch && (
        <Suspense fallback={<p role="status">正在打开业务表单…</p>}>
          <FlowPage
            key={launch.mode + JSON.stringify(launch.params)}
            mode={launch.mode}
            dialogOnly
            launch={launch.params}
            onClose={() => {
              setLaunch(null);
              setRevision((v) => v + 1);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
