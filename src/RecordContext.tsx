import { useEffect, useState } from 'react';
import ManagementDialog from './ManagementDialog';
import { managementRequest } from './session';
import { developerNames } from '../shared/developer';
export function RecordRelations({ module, id }: { module: string; id: number }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    managementRequest('/management/context?module=' + module + '&id=' + id)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [module, id]);
  return (
    <div className="record-relations">
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>正在查询关联关系…</p>}
      {data && (
        <>
          <p>{data.archiveEffect}</p>
          <h3>关联记录（{data.related.length}）</h3>
          <ul>
            {data.related.map((r: any) => (
              <li key={r.module + r.id}>
                {developerNames[r.module]} · {r.name} ·{' '}
                {r.status || (r.archived ? '已归档' : '正常')}
              </li>
            ))}
          </ul>
          <details>
            <summary>最近修改历史（{data.history.length}）</summary>
            <ul>
              {data.history.map((r: any, i: number) => (
                <li key={i}>
                  {new Date(r.at).toLocaleString('zh-CN')} · {r.actorName} · {r.action}
                  <details>
                    <summary>查看变更内容</summary>
                    <pre style={{ whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(r.detail, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
export default function RecordContextDialog({
  module,
  id,
  close,
}: {
  module: string;
  id: number;
  close: () => void;
}) {
  return (
    <ManagementDialog title="关联记录与修改历史" close={close}>
      <RecordRelations module={module} id={id} />
    </ManagementDialog>
  );
}
