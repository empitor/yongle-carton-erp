import { currentOrderCard } from '../shared/assistant-order-card';
import type { AssistantBusinessTask } from '../shared/assistant-task';
const labels: Record<string, string> = {
  uploaded: '已关联',
  recognizing: '正在识别',
  failed: '识别失败',
  interrupted: '已中断，可重试',
  needs_review: '待核对',
  awaiting_confirmation: '待确认导入',
  imported: '已导入',
};
export default function AssistantOrderTask({ workflow, businessTask }: { workflow: any; businessTask?: AssistantBusinessTask | null }) {
  const task = currentOrderCard(workflow, businessTask);
  if (!task) return null;
  const plan = task.preview?.plan;
  return (
    <section className="ga-order-task" aria-label="当前订单任务">
      <div>
        <strong>{task.fileName}</strong>
        <span>{labels[task.state] || task.state}</span>
      </div>
      <a href={'#ai-import?workspace=' + task.workspaceId}>查看识别草稿与进度</a>
      {task.focusLine && <span>当前产品：第{task.focusLine}行</span>}
      {task.result && (
        <a href={'#orders?order=' + task.result.orderId}>正式订单 {task.result.orderNumber}</a>
      )}
      {task.error && <p role="status">{task.error}</p>}
      {plan && task.state !== 'imported' && (
        <details>
          <summary>核对本次完整导入方案 · {plan.total} 元</summary>
          <p>
            客户：{plan.customer.name}（{plan.customer.mode === 'new' ? '新建' : '已有'}）
          </p>
          <p>
            订单日期：{plan.order.orderDate}；交货：{plan.order.deliveryDate}；客户采购号：
            {plan.order.externalPurchaseOrder || '未提供'}
          </p>
          {plan.order.lines.map((l: any, i: number) => (
            <article key={i}>
              <strong>
                {i + 1}. {l.productName}
              </strong>
              <p>
                规格：{l.specification || '未提供'}；备注：{l.notes || '无'}
              </p>
              <p>
                {l.quantity} {l.unit} × {l.unitPriceExact} 元；产品档案：{plan.products[i].name}（
                {plan.products[i].mode === 'new' ? '新建' : '已有'}）
              </p>
            </article>
          ))}
          <p>
            币种 {plan.order.currency}；税率 {plan.order.taxRate || '未注明'}；{plan.order.taxMode}
            ；合同条件 {plan.order.terms || '无'}；备注 {plan.order.notes || '无'}
          </p>
          {plan.customer.mode === 'new' && (
            <p>
              新客户资料：联系人 {plan.customer.input.contact || '未提供'}；电话{' '}
              {plan.customer.input.phone || '未提供'}；地址{' '}
              {plan.customer.input.address || '未提供'}；备注 {plan.customer.input.notes || '无'}
            </p>
          )}
          {plan.products
            .filter((p: any) => p.mode === 'new')
            .map((p: any, i: number) => (
              <p key={i}>
                新产品 {p.name}：长宽高 {p.input.length ?? '未知'} × {p.input.width ?? '未知'} ×{' '}
                {p.input.height ?? '未知'} {p.input.dimensionUnit || '单位未知'}；材质{' '}
                {p.input.material || '待补'}；楞型 {p.input.flute || '待补'}；加工{' '}
                {p.input.requirements || '待补'}
              </p>
            ))}
          {plan.warnings.map((w: string, i: number) => (
            <p key={i}>{w}</p>
          ))}
          <p>核对后在聊天中回复“确认导入”，无需再勾选。</p>
        </details>
      )}
    </section>
  );
}
