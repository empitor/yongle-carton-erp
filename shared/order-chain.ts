/** 履约链：把一张订单的进度压缩成一组节点。只表达系统里有事实依据的环节。 */
export type ChainState = 'done' | 'active' | 'blocked' | 'todo' | 'na';
export type ChainNode = { key: string; label: string; title: string; state: ChainState };
type ChainOrder = {
  status: string;
  deliveryDate?: string;
  shippingProgress?: string;
  materialProgress?: 'none' | 'pending' | 'partial' | 'done';
};

export function orderChain(order: ChainOrder, today: string): ChainNode[] {
  const cancelled = order.status === '已取消',
    draft = order.status === '草稿',
    shipped = order.shippingProgress === '已发完' || order.status === '已发货',
    partial = order.shippingProgress === '部分发货',
    produced = shipped || order.status === '待发货',
    producing = order.status === '生产中',
    overdue =
      !cancelled && !draft && !shipped && !!order.deliveryDate && order.deliveryDate < today;
  const material = order.materialProgress || 'none';
  const nodes: ChainNode[] = [
    {
      key: 'order',
      label: '订',
      title: draft ? '订单：草稿' : cancelled ? '订单：已取消' : '订单：已确认',
      state: cancelled ? 'na' : draft ? 'active' : 'done',
    },
    {
      key: 'material',
      label: '料',
      title:
        material === 'none'
          ? '纸板：未关联采购单'
          : material === 'done'
            ? '纸板：已全部到货'
            : material === 'partial'
              ? '纸板：部分到货'
              : '纸板：采购中',
      state:
        material === 'none'
          ? 'na'
          : material === 'done'
            ? 'done'
            : 'active',
    },
    {
      key: 'production',
      label: '产',
      title: produced ? '生产：已完工' : producing ? '生产：进行中' : '生产：未开始',
      state: cancelled ? 'na' : produced ? 'done' : producing ? 'active' : 'todo',
    },
    {
      key: 'delivery',
      label: '送',
      title: shipped ? '送货：已发完' : partial ? '送货：部分发货' : '送货：未发货',
      state: cancelled ? 'na' : shipped ? 'done' : partial ? 'active' : 'todo',
    },
  ];
  if (overdue) {
    // 逾期标在当前卡住的环节上，让人一眼看到该催哪一步。
    const current = nodes.find((n) => n.key !== 'material' && n.state !== 'done');
    if (current) {
      current.state = 'blocked';
      current.title += '（已超交期）';
    }
  }
  return nodes;
}
