export default function StatusBadge({ status }: { status: string }) {
  const tone = ['已完成送货', '已完成到货', '全部合格', '已入库', '已到货', '已发完', '已到齐', '更正后有效', '有效到货', '已发货','已完成', '全部到货', '手动入库', '采购到货','生产完工入库','生产退料'].includes(status)
    ? 'success'
    : ['已确认', '已订货', '手动出库', '待发货'].includes(status)
      ? 'info'
      : // 紫色只给 AI 用；部分发货和部分到货一样，表示还没完。
        ['含不合格品', '部分入库', '入库待核对', '历史验收未记录', '待验收入库', '生产中', '部分到货', '部分发货', '盘点调整', '待核对差异', '历史数量待核对'].includes(status)
        ? 'warning'
        : 'muted';
  return (
    <span className="business-status" data-tone={tone}>
      {status}
    </span>
  );
}
