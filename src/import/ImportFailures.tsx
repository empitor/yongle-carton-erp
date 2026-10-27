import { useState, useEffect } from 'react';
import { X, Download, RefreshCw } from 'lucide-react';
import type { ImportFailureRecord } from '../../server/import/failure-record';
export default function ImportFailures({
  selectedId,
  close,
}: {
  selectedId: string;
  close: () => void;
}) {
  const [onlyCurrent, setOnlyCurrent] = useState(false),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<{ items: ImportFailureRecord[]; total: number } | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ offset: String(offset) });
    if (onlyCurrent && selectedId) q.set('workspaceId', selectedId);
    void fetch('/api/ai/imports/diagnostics?' + q, { signal: controller.signal, cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.message || '读取错误档案失败');
        setData(d);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [onlyCurrent, selectedId, offset, refresh]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [close]);
  return (
    <div className="oi-modal-backdrop">
      <section
        className="oi-modal oi-failures"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oi-failure-title"
      >
        <button className="oi-modal-close" aria-label="关闭错误档案" onClick={close}>
          <X size={18} />
        </button>
        <h2 id="oi-failure-title">AI 错误档案</h2>
        <p>每次失败独立保留；不含密钥、文件正文或模型完整回答。旧记录仅保留当时已有摘要。</p>
        <div className="oi-failure-controls">
          <label>
            <input
              type="checkbox"
              checked={onlyCurrent}
              disabled={!selectedId}
              onChange={(e) => {
                setOnlyCurrent(e.target.checked);
                setOffset(0);
              }}
            />
            仅当前文件
          </label>
          <span>共 {data?.total ?? 0} 条</span>
          <button disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        {error && (
          <p className="oi-bad" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">正在读取…</p>
        ) : data?.items.length ? (
          data.items.map((r) => (
            <article className="oi-failure-record" key={r.id}>
              <div>
                <strong>{r.fileName}</strong>
                <a href={'/api/ai/imports/diagnostics/' + r.id + '?download=1'} download>
                  <Download size={14} />
                  下载诊断
                </a>
              </div>
              <p className="oi-bad">{r.message}</p>
              <dl>
                <dt>记录时间</dt>
                <dd>
                  {new Date(r.recordedAt).toLocaleString('zh-CN')}
                  {r.historical ? ' · 旧版摘要补录，原失败时间未知' : ''}
                </dd>
                <dt>阶段 / 错误码</dt>
                <dd>
                  {r.stage} / {r.code}
                </dd>
                <dt>模型 / 协议</dt>
                <dd>
                  {r.provider.model || '未知'} / {r.provider.protocol || '未知'}
                </dd>
                <dt>服务地址</dt>
                <dd>{r.provider.endpoint || '未知'}</dd>
                <dt>操作 / 操作者</dt>
                <dd>
                  {r.operation} / {r.operator?.name || '旧版未记录'}
                </dd>
                <dt>诊断编号</dt>
                <dd>{r.id}</dd>
              </dl>
              {r.response && (
                <p>
                  响应事件：{r.response.event}；原因：{r.response.reason}；输出Token：
                  {r.response.outputTokens ?? '未知'}；思考Token：
                  {r.response.reasoningTokens ?? '未知'}
                </p>
              )}
              {!!r.schemaIssues.length && (
                <p>
                  结构校验：{r.schemaIssues.map((i) => i.path + ' (' + i.code + ')').join('；')}
                </p>
              )}
              {r.workspaceId && (
                <small>
                  工作区 {r.workspaceId} · 修订 {r.revision ?? '未知'}
                  {r.durationMs !== null ? ' · ' + (r.durationMs / 1000).toFixed(1) + '秒' : ''}
                </small>
              )}
            </article>
          ))
        ) : (
          !error && <p>暂无失败记录。</p>
        )}
        <div className="oi-modal-actions">
          <button
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            上一页
          </button>
          <button
            disabled={loading || offset + 50 >= (data?.total || 0)}
            onClick={() => setOffset(offset + 50)}
          >
            下一页
          </button>
          <button onClick={close}>关闭</button>
        </div>
      </section>
    </div>
  );
}
