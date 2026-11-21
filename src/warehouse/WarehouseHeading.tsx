import { FileUp } from 'lucide-react';
import { ListSummary, PageHeading } from '../ui/index';
import type { OrderBatch } from './order-batch-api';
import { statusOf, warehouseOverdue, type WarehouseKind, type WarehouseRecord } from './warehouse-list';

type Props = {
  kind: WarehouseKind;
  records: readonly WarehouseRecord[];
  /** 待到货的订货单（到货页） */
  batches: readonly OrderBatch[];
  canEdit: boolean;
  /** 正在为编辑窗读档案 */
  opening: boolean;
  plan: () => void;
  begin: () => void;
};

/**
 * 到货、送货页的页头：几个要紧的数（待送货、送货中、逾期 / 待到货、逾期）和这一页的入口。
 * 送货一个主按钮“安排送货”；到货的主操作在待到货每行，页头只有 AI 识别送货单和“更多”里的没有采购单的到货。
 */
export default function WarehouseHeading({ kind, records, batches, canEdit, opening, plan, begin }: Props) {
  const summary =
    kind === 'delivery'
      ? [
          { label: '待送货', value: records.filter((r) => r.pending).length },
          { label: '送货中', value: records.filter((r) => statusOf(kind, r) === '送货中').length },
          { label: '逾期', value: records.filter(warehouseOverdue).length },
        ]
      : [
          { label: '待到货', value: batches.length },
          { label: '逾期', value: batches.filter((b) => b.progress.overdue).length },
        ];
  const arrival = canEdit && kind === 'arrival';
  return (
    <PageHeading
      title={kind === 'arrival' ? '到货' : '送货'}
      meta={<ListSummary items={summary} />}
      primary={canEdit && kind === 'delivery' && { label: '安排送货', onClick: plan }}
      secondary={
        arrival && {
          label: 'AI 识别送货单',
          icon: <FileUp size={15} aria-hidden="true" />,
          onClick: () => (location.hash = '#ai-import?mode=arrival'),
        }
      }
      moreLabel="到货的其他操作"
      // 有采购单的货都在“待到货”里按订货单登记；这里只登记不挂采购单的（多送、样品）
      more={[arrival && { label: '登记没有采购单的到货', disabled: opening, onClick: begin }]}
    />
  );
}
