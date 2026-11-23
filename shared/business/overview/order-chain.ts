/** 履约链：把一张订单的进度压缩成一组节点。只表达系统里有事实依据的环节。 */
type ChainState = 'done' | 'active' | 'blocked' | 'todo' | 'na';
type ChainNode = { key: string; label: string; title: string; state: ChainState };
type ChainOrder = {
  status: string;
  deliveryDate?: string;
  shippingProgress?: string;
  materialProgress?: MaterialProgress;
};
type MaterialProgress = 'none' | 'pending' | 'partial' | 'done';
/** 订单这一环要看的几件事（由状态和发货进度算出来） */
type ChainFacts = { cancelled: boolean; draft: boolean; shipped: boolean; partial: boolean; produced: boolean; producing: boolean };

const materialTitles: Record<MaterialProgress, string> = {
  none: '纸板：未关联采购单',
  done: '纸板：已全部到货',
  partial: '纸板：部分到货',
  pending: '纸板：采购中',
};
const materialStates: Record<MaterialProgress, ChainState> = { none: 'na', done: 'done', partial: 'active', pending: 'active' };

const orderNode = ({ cancelled, draft }: ChainFacts): ChainNode => ({
  key: 'order',
  label: '订',
  title: draft ? '订单：待确认' : cancelled ? '订单：已取消' : '订单：已确认',
  state: cancelled ? 'na' : draft ? 'active' : 'done',
});
const materialNode = (material: MaterialProgress): ChainNode => ({
  key: 'material',
  label: '料',
  title: materialTitles[material],
  state: materialStates[material],
});
const productionNode = ({ cancelled, produced, producing }: ChainFacts): ChainNode => ({
  key: 'production',
  label: '产',
  title: produced ? '生产：已完工' : producing ? '生产：进行中' : '生产：未开始',
  state: cancelled ? 'na' : produced ? 'done' : producing ? 'active' : 'todo',
});
const deliveryNode = ({ cancelled, shipped, partial }: ChainFacts): ChainNode => ({
  key: 'delivery',
  label: '送',
  title: shipped ? '送货：已发完' : partial ? '送货：部分发货' : '送货：未发货',
  state: cancelled ? 'na' : shipped ? 'done' : partial ? 'active' : 'todo',
});

function chainFacts(order: ChainOrder): ChainFacts {
  const shipped = order.shippingProgress === '已发完' || order.status === '已发货';
  return {
    cancelled: order.status === '已取消',
    draft: order.status === '待确认',
    shipped,
    partial: order.shippingProgress === '部分发货',
    produced: shipped || order.status === '待发货',
    producing: order.status === '生产中',
  };
}

export function orderChain(order: ChainOrder, today: string): ChainNode[] {
  const facts = chainFacts(order);
  const nodes = [orderNode(facts), materialNode(order.materialProgress || 'none'), productionNode(facts), deliveryNode(facts)];
  const overdue = !facts.cancelled && !facts.draft && !facts.shipped && !!order.deliveryDate && order.deliveryDate < today;
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
