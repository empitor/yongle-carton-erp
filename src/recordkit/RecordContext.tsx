import { ManagementDialog, beijingTime, useLoad } from '../ui/index';
import { readRecordContext } from './record-api';
import { dataManagementNames, type WorkbenchApi } from '../../shared/business/index';
import { EditorFooter, FormMessage } from '../ui/index';
import { Facts, Hint, Section, StatusChip } from '../ui/index';
import { historyActionName, historyView, type HistoryRefs } from '../../shared/business/index';
import { businessStatusTone } from './record-meta';
import { purchaseState } from '../../shared/business/index';
import { orderDisplayStatus, flowKinds } from '../../shared/core/index';
import { flowStatusText } from '../../shared/business/index';

type RecordContextView = WorkbenchApi['GET /business/:module/:id/context']['response'];
type RelatedRecord = RecordContextView['related'][number];
type HistoryEntry = RecordContextView['history'][number];

/** 状态叫法和列表、详情一样：订单 orderDisplayStatus、采购单 purchaseState、单据 flowStatusText */
const statusText = (r: RelatedRecord) =>
  !r.status
    ? r.archived
      ? '已归档'
      : '正常'
    : r.module === 'orders'
      ? orderDisplayStatus({ status: r.status, shippingProgress: r.view.shippingProgress })
      : r.module === 'purchases'
        ? purchaseState({ status: r.status, businessStatus: r.view.businessStatus })
        : flowKinds.some((k) => k === r.module)
          ? flowStatusText({ ...r.view, status: r.status, kind: r.module })
          : r.status;

/** 读一条记录的关联记录和修改历史：能看这条记录的账号都能看（和助手查修改历史同一个接口函数） */
function useRecordHistory(module: string, id: number) {
  const { data, error, loading } = useLoad(module + '/' + id, () => readRecordContext(module, id));
  // 换了一条记录、或读失败：上一条的内容不再显示
  return { data: loading || error ? null : data, error: loading ? '' : error };
}

function RelatedList({ related }: { related: RelatedRecord[] }) {
  if (!related.length) return <p className="sales-muted">没有关联记录。</p>;
  return (
    <ul className="record-links sales-context-links">
      {related.map((r) => (
        <li key={r.module + r.id}>
          <span className="sales-context-kind">{dataManagementNames[r.module] || r.module}</span>
          <span>{r.name}</span>
          <StatusChip
            tone={r.status ? businessStatusTone(statusText(r)) : r.archived ? 'warning' : 'neutral'}
          >
            {statusText(r)}
          </StatusChip>
        </li>
      ))}
    </ul>
  );
}

/** 一条修改改了什么：一项一行“字段：改之前 → 改之后”，排版在 shared/business/overview/record-history.ts，不显示原始数据 */
function HistoryChanges({ module, id, entry, refs }: { module: string; id: number; entry: HistoryEntry; refs: HistoryRefs }) {
  const view = historyView({ module, action: entry.action, detail: entry.detail, recordId: id }, refs);
  // 同一个字段名的几行（明细逐行改了几处）并成一项，一行一处
  const groups: { label: string; values: string[] }[] = [];
  for (const item of view.items) {
    const same = groups.find((g) => g.label === item.label);
    if (same) same.values.push(item.value);
    else groups.push({ label: item.label, values: [item.value] });
  }
  return (
    <div className="sales-history-changes">
      {groups.length > 0 && (
        <Facts
          items={groups.map((g) => ({
            label: g.label,
            wide: true,
            value: g.values.length === 1 ? g.values[0] : g.values.map((v, i) => <div key={i}>{v}</div>),
          }))}
        />
      )}
      {view.note && <p className="sales-muted">{view.note}</p>}
    </div>
  );
}

/**
 * 每条后面一个小标签写来源（sourceLabel：页面、助手、数据管理、系统，server/overview/record-context.ts）。
 * 数据管理窗口里做的维护下层业务服务记一条、数据管理再记一条带“原因”，两条都标“数据管理”，看得出是同一次维护。
 */
export function HistoryList({
  module,
  id,
  history,
  refs,
}: {
  module: string;
  id: number;
  history: readonly HistoryEntry[];
  refs: HistoryRefs;
}) {
  if (!history.length) return <p className="sales-muted">没有修改记录。</p>;
  return (
    <ol className="sales-history">
      {history.map((r, i) => (
        <li key={i}>
          <div>
            {/* 没登记中文名的动作不把英文代码露给用户 */}
            <strong>{historyActionName(r.action)}</strong>
            <span>{r.actorName}</span>
            <StatusChip>{r.sourceLabel}</StatusChip>
            <small>{beijingTime(r.at)}</small>
          </div>
          <details>
            <summary>查看变更内容</summary>
            <HistoryChanges module={module} id={id} entry={r} refs={refs} />
          </details>
        </li>
      ))}
    </ol>
  );
}

/** 一条记录的关联记录和修改历史：单独打开的窗口，分节显示。 */
export default function RecordContextDialog({
  module,
  id,
  label,
  close,
}: {
  module: string;
  id: number;
  /** 编号或名称，显示在标题下面 */
  label?: string;
  close: () => void;
}) {
  const { data, error } = useRecordHistory(module, id);
  return (
    <ManagementDialog
      title="关联记录与修改历史"
      subtitle={[dataManagementNames[module], label].filter(Boolean).join(' · ') || undefined}
      size="md"
      close={close}
      footer={
        <EditorFooter>
          <button type="button" className="secondary" onClick={close}>
            关闭
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      {!data && !error && (
        <p className="sales-muted" role="status">
          正在查询关联关系…
        </p>
      )}
      {data && (
        <>
          {data.archiveEffect && <Hint tone="info">{data.archiveEffect}</Hint>}
          <Section title={'关联记录 ' + data.related.length}>
            <RelatedList related={data.related} />
          </Section>
          <Section title={'最近修改 ' + data.history.length}>
            <HistoryList module={module} id={id} history={data.history} refs={data.historyRefs} />
          </Section>
        </>
      )}
    </ManagementDialog>
  );
}
