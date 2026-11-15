import { Hint, useLoad } from '../ui/index';
import type { ImportWorkspaceView as Workspace } from '../../shared/import/index';
import type { useImportMatching } from './useImportMatching';
import { readStandardOrder } from './workspace-api';

type Match = ReturnType<typeof useImportMatching>;

/** 上面的几条提醒：档案读取失败、保存失败、尺寸换算不了、采购单号重复、标准订单还要补的、产品资料能后补的 */
export function OrderNotices({
  match,
  workspace,
  mappingError,
  dimensionError,
}: {
  match: Match;
  workspace: Workspace;
  mappingError?: string;
  dimensionError: string;
}) {
  const imported = !!workspace.imported,
    { matches } = match;
  // 按标准订单检查；读不到就当没有提示
  const standard = useLoad(workspace.id + ':' + workspace.revision, () =>
    readStandardOrder(workspace.id).catch(() => null),
  ).data;
  // 没选产品时导入会新建，不算没处理完
  const standardIssues = (standard?.issues || []).filter((s) => !s.startsWith('产品尚未选择'));
  // 产品资料能后补的提示按实际要用的档案算（已有档案看档案，新建的看识别出的资料）
  const productNotices = [...new Set(standard?.notices || [])];
  return (
    <>
      {match.readError && <Hint tone="danger">档案候选读取失败：{match.readError}</Hint>}
      {match.saveState === 'error' && !imported && <Hint tone="danger">{mappingError || match.saveError}</Hint>}
      {dimensionError && (
        <p className="record-hint tone-danger" role="alert">
          {dimensionError}
        </p>
      )}
      {!!matches?.duplicateOrders.length && !imported && (
        <Hint tone="warning">
          发现相同采购单号：
          {matches.duplicateOrders.map((o) => o.number + '（' + o.customerName + '）').join('、')}
          ，请核对是不是重复订单。
        </Hint>
      )}
      {!!standardIssues.length && workspace.mapping && !imported && (
        <details className="aii-fold tone-warning">
          <summary>标准订单资料还有 {standardIssues.length} 项要处理</summary>
          <ul>
            {[...new Set(standardIssues)].map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      )}
      {productNotices.length > 0 && (
        <details className="aii-fold tone-info">
          <summary>产品资料可以后补 {productNotices.length} 项，不影响导入</summary>
          <ul>
            {productNotices.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** “客户和订单”右上角：客户与产品选择存了没有；有没存的或存失败了给“保存”按钮 */
export function MappingSaveState({ match, saved, locked }: { match: Match; saved: boolean; locked: boolean }) {
  const text =
    match.saveState === 'saving'
      ? '保存中…'
      : match.saveState === 'error'
        ? '保存失败，当前选择已保留'
        : match.dirty
          ? '有选择待保存'
          : saved
            ? '客户和产品选择已保存'
            : '尚未保存选择';
  return (
    <div className="aii-section-extra" aria-label="客户与产品选择保存">
      <span role="status" aria-live="polite" className={match.saveState === 'error' ? 'aii-text-danger' : ''}>
        {text}
      </span>
      {(match.dirty || match.saveState === 'error') && (
        <button
          type="button"
          className="secondary"
          disabled={locked || !match.matches || !match.dirty}
          onClick={() => void match.save()}
        >
          {match.saveState === 'saving' ? '保存中…' : '保存客户与产品选择'}
        </button>
      )}
    </div>
  );
}
