import { Fragment } from 'react';
import { orderChain } from '../../shared/business/index';
import { today } from '../../shared/core/index';

/** 所有页面表达订单进度都用这一个组件，保持同一种视觉语言。 */
export default function Chain({ order, large = false }: { order: Parameters<typeof orderChain>[0]; large?: boolean }) {
  const nodes = orderChain(order, today());
  return (
    <span
      className={'chain' + (large ? ' chain-large' : '')}
      role="img"
      aria-label={nodes.map((n) => n.title).join('；')}
      title={nodes.map((n) => n.title).join('\n')}
    >
      {nodes.map((n, i) => (
        <Fragment key={n.key}>
          {i > 0 && <i className={'chain-link' + (nodes[i - 1].state === 'done' ? ' done' : '')} />}
          <span className={'chain-node ' + n.state}>{n.label}</span>
        </Fragment>
      ))}
    </span>
  );
}
