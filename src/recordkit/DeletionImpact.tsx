import { Section } from '../ui/index';
import { deletionImpactView, type DeletionPlanView, type ImpactLine } from './deletion-impact';

/**
 * 删除会一起处理哪些记录：人工删除窗和助手的删除确认卡片共用。plan 是删除预览（impact 清单和选了什么）。
 * 顶部一句按类别汇总；逐条列会删除的、保留只解除关联的；内部关联只说一共几条。怎么排版见 deletion-impact.ts。
 */
export default function DeletionImpact({ plan }: { plan: DeletionPlanView }) {
  const view = deletionImpactView(plan);
  const item = (r: ImpactLine, i: number) => (
    <li key={i}>
      <span className="sales-context-kind">{r.kind}</span>
      <span>{r.name}</span>
      {r.note && <small>{r.note}</small>}
    </li>
  );
  return (
    <>
      {view.summary && <p role="status">{view.summary}</p>}
      <Section title={'会删除 ' + view.deleted.length}>
        {view.deleted.length ? (
          <ul className="record-links sales-context-links">{view.deleted.map(item)}</ul>
        ) : (
          <p className="sales-muted">—</p>
        )}
        {view.hidden > 0 && (
          <p className="sales-muted">另有 {view.hidden} 条系统内部的关联记录一起清理。</p>
        )}
      </Section>
      {view.kept.length > 0 && (
        <Section title={'保留，只解除关联 ' + view.kept.length}>
          <ul className="record-links sales-context-links">{view.kept.map(item)}</ul>
        </Section>
      )}
    </>
  );
}
