import { useEffect, useState, lazy, Suspense } from 'react';
import { managementRequest, useAuthState } from './session';
const FlowPage = lazy(() => import('./FlowPage'));
import StatusBadge from './StatusBadge';
import { flowStatusLabel, type FlowKind } from '../shared/physical-flow';
import { formatStockSize } from '../shared/operations';

export default function RelatedBusiness({
  entity,
  row,
}: {
  entity: 'orders' | 'purchases';
  row: any;
}) {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
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
  const records = (title: string, list: any[], mode: FlowKind) => (
    <section className="related-section">
      <h3>
        {title} <span>{list.length}</span>
      </h3>
      {list.length ? (
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
      ) : (
        <p className="related-empty">暂无{title}。</p>
      )}
    </section>
  );
  return (
    <section className="related-business" aria-label="关联业务与下一步">
      <header>
        <div>
          <h2>关联业务与下一步</h2>
          <p>在当前单据中处理生产、到货和送货。</p>
        </div>
        <button onClick={() => setRevision((v) => v + 1)}>刷新关联记录</button>
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {canEdit && !row.archived && (
        <div className="related-next-actions">
          {entity === 'orders'
            ? ['已确认', '生产中', '待发货'].includes(row.status) && (
                <>
                  <div className="related-production-lines">
                    {row.lines.map((l: any) => (
                      <button
                        className="primary"
                        key={l.id}
                        onClick={() =>
                          setLaunch({
                            mode: 'task',
                            params: { order: String(row.id), product: String(l.productId) },
                          })
                        }
                      >
                        安排生产 · {l.productName}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() =>
                      setLaunch({ mode: 'delivery', params: { order: String(row.id) } })
                    }
                  >
                    安排送货
                  </button>
                </>
              )
            : row.businessStatus === '已订货' &&
              row.arrivalProgress !== '全部到货' && (
                <>
                  <button
                    className="primary"
                    onClick={() =>
                      setLaunch({
                        mode: 'arrival',
                        params: { purchase: String(row.id), isPlan: '1' },
                      })
                    }
                  >
                    新建到货计划
                  </button>
                  <button
                    onClick={() =>
                      setLaunch({ mode: 'arrival', params: { purchase: String(row.id) } })
                    }
                  >
                    登记实际到货
                  </button>
                </>
              )}
        </div>
      )}
      {entity === 'orders' && row.status === '草稿' && (
        <p className="help-text">先将订单状态保存为“已确认”，再安排生产和送货。</p>
      )}
      {entity === 'purchases' && row.businessStatus === '待订货' && (
        <p className="help-text">
          先完成订货，再安排到货；上方可预览、导出或正式导出并标记已订货。
        </p>
      )}
      {!canEdit && (
        <p className="help-text">当前账号可查看单据；关联业务操作需要原业务编辑权限。</p>
      )}
      {canEdit && !data && !error && <p role="status">正在读取关联业务…</p>}
      {data && (
        <>
          {entity === 'orders' ? (
            <>
              {records('生产任务', data.tasks, 'task')}
              {records('完工入库记录', data.productions, 'production')}
              {records('送货记录', data.deliveries, 'delivery')}
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
          <section className="related-section">
            <h3>{entity === 'orders' ? '对应成品库存' : '对应原材料库存'}</h3>
            <p className="help-text">
              同一档案可能用于多张订单；这里展示总库存余额，不代表本单独占或可发数量。
            </p>
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
            {!data.stocks.length && <p className="related-empty">尚无已关联的库存档案。</p>}
          </section>
        </>
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
    </section>
  );
}
