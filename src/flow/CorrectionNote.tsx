import { flowDocHref, type FlowKind } from '../../shared/core/index';
import type { FlowDocView } from '../../shared/business/index';
import { Hint, useLoad } from '../ui/index';
import { readFlow } from './flow-api';

/** 更正链上另一张单据的链接：单据上只记着编号（id），单号读那张单据 */
function DocLink({ id, kind }: { id: number; kind: FlowKind }) {
  const { data } = useLoad('flow:' + id, () => readFlow(id));
  return <a href={flowDocHref(kind, id)}>{data?.number || '查看单据'}</a>;
}

/**
 * 详情头部的更正关系（到货、送货、完工三种同一处）：被更正的原单写“已更正为 ××”和原因，
 * 替代单写“更正自 ××”和原因，都点得开。没有更正关系的不显示。
 */
export default function CorrectionNote({ d }: { d: Pick<FlowDocView, 'kind' | 'replacedBy' | 'reversal' | 'correctionOf' | 'correctionReason'> }) {
  if (d.replacedBy)
    return (
      <Hint tone="warning">
        已更正为 <DocLink id={d.replacedBy} kind={d.kind} />
        {d.reversal ? '：' + d.reversal.reason + '（' + d.reversal.by + '，' + d.reversal.at + '）' : ''}
      </Hint>
    );
  if (d.correctionOf)
    return (
      <Hint tone="info">
        更正自 <DocLink id={d.correctionOf} kind={d.kind} />
        {d.correctionReason ? '：' + d.correctionReason : ''}
      </Hint>
    );
  return null;
}
