import { useState } from 'react';
import { Download } from 'lucide-react';
import { FormMessage, beijingTime, useLoad, Loading } from '../ui/index';
import { Facts } from '../ui/index';
import { FAILURE_PAGE as PAGE } from '../../shared/import/index';
import { failureDownloadUrl, readFailures } from './workspace-api';

/**
 * 识别失败的记录：每次失败一张卡片，不含密钥、文件正文或模型完整回答。
 * 放在“历史与归档”窗口里，是错误档案唯一的入口。
 */
export function FailureList({ selectedId }: { selectedId: string }) {
  const [onlyCurrent, setOnlyCurrent] = useState(false),
    [offset, setOffset] = useState(0);
  const workspaceId = onlyCurrent ? selectedId : '';
  const { data, error, loading } = useLoad(offset + ':' + workspaceId, () => readFailures(offset, workspaceId));
  const total = data?.total ?? 0;
  return (
    <div className="aii-stack">
      <div className="aii-filter-bar">
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
          只看当前文件
        </label>
        <span>共 {total} 条</span>
      </div>
      <FormMessage>{error}</FormMessage>
      {loading ? (
        <Loading />
      ) : data?.items.length ? (
        data.items.map((r) => (
          <article className="line-card" key={r.id}>
            <header>
              <strong title={r.fileName}>{r.fileName}</strong>
              <a
                className="aii-link"
                href={failureDownloadUrl(r.id)}
                download
              >
                <Download size={14} aria-hidden="true" />
                下载诊断
              </a>
            </header>
            <p className="record-hint tone-danger">{r.message}</p>
            <details className="aii-fold">
              <summary>技术细节（给维护人员看）</summary>
              <Facts
                items={[
                  {
                    label: '记录时间',
                    value:
                      beijingTime(r.recordedAt) +
                      (r.historical ? ' · 启动时补录，原失败时间未知' : ''),
                  },
                  { label: '阶段 / 错误码', value: r.stage + ' / ' + r.code },
                  { label: '模型', value: r.provider.model || '未知' },
                  { label: '操作 / 操作者', value: r.operation + ' / ' + (r.operator?.name || '旧版未记录') },
                  {
                    label: '响应',
                    wide: true,
                    hidden: !r.response,
                    value: r.response
                      ? '事件 ' +
                        r.response.event +
                        '；原因 ' +
                        r.response.reason +
                        '；输出 Token ' +
                        (r.response.outputTokens ?? '未知') +
                        '；思考 Token ' +
                        (r.response.reasoningTokens ?? '未知')
                      : '',
                  },
                  {
                    label: '结构校验',
                    wide: true,
                    hidden: !r.schemaIssues.length,
                    value: r.schemaIssues.map((i) => i.path + ' (' + i.code + ')').join('；'),
                  },
                  {
                    label: '工作区',
                    wide: true,
                    hidden: !r.workspaceId,
                    value:
                      r.workspaceId +
                      ' · 修订 ' +
                      (r.revision ?? '未知') +
                      (r.durationMs !== null ? ' · ' + (r.durationMs / 1000).toFixed(1) + '秒' : ''),
                  },
                  { label: '诊断编号', value: r.id, wide: true },
                ]}
              />
            </details>
          </article>
        ))
      ) : (
        !error && <p className="choice-list-empty">没有识别失败的记录。</p>
      )}
      {total > PAGE && (
        <div className="aii-pager">
          <span>
            第 {offset + 1}–{Math.min(offset + PAGE, total)} 条，共 {total} 条
          </span>
          <button
            type="button"
            className="secondary"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            上一页
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading || offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
