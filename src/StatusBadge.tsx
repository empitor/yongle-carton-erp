export default function StatusBadge({ status }: { status: string }) {
  const tone = ['已发货','已完成', '全部到货', '手动入库', '采购到货','生产完工入库','生产退料'].includes(status)
    ? 'success'
    : ['已确认', '已订货', '手动出库'].includes(status)
      ? 'info'
      : ['生产中', '部分到货', '盘点调整'].includes(status)
        ? 'warning'
        : ['待发货','部分发货'].includes(status)
          ? 'purple'
          : 'muted';
  return (
    <span className="business-status" data-tone={tone}>
      {status}
    </span>
  );
}
