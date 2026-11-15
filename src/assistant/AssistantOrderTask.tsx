import { finishedUnit, linePrice } from '../../shared/core/index';
import { amountText, specLine } from '../../shared/business/index';
import type { ThreadView } from '../../shared/assistant/index';
import { importedOrderOf, previewPlanOf, type PreviewPlan } from './order-task-view';

const labels: Record<string, string> = {
  uploaded: '已关联',
  recognizing: '正在识别',
  failed: '识别失败',
  interrupted: '已中断，可重试',
  needs_review: '待核对',
  awaiting_confirmation: '可以导入',
  imported: '已导入',
};

/** 预览里的明细：品名、规格备注、数量单价和用哪个产品档案 */
function PreviewLines({ plan }: { plan: PreviewPlan }) {
  return plan.order.lines.map((l, i) => (
    <article key={i}>
      <strong>
        {i + 1}. {l.productName}
      </strong>
      <p>
        规格：{l.specification || '未提供'}；备注：{l.notes || '无'}
      </p>
      <p>
        {l.quantity} {finishedUnit(l.unit)} × {linePrice(l)} 元；产品档案：{plan.products[i]?.name}（
        {plan.products[i]?.mode === 'new' ? '新建' : '已有'}）
      </p>
    </article>
  ));
}

/** 要新建的客户、产品的资料 */
function NewRecords({ plan }: { plan: PreviewPlan }) {
  const customer = plan.customer;
  return (
    <>
      {customer.mode === 'new' && (
        <p>
          新客户资料：联系人 {customer.input.contact || '未提供'}；电话{' '}
          {customer.input.phone || '未提供'}；地址{' '}
          {customer.input.address || '未提供'}；备注 {customer.input.notes || '无'}
        </p>
      )}
      {plan.products.map((p, i) =>
        p.mode === 'new' ? (
          <p key={i}>
            新产品 {p.name}：{specLine(p.input) || '尺寸、材质待补'}；加工 {p.input.requirements || '待补'}
          </p>
        ) : null,
      )}
    </>
  );
}

/** 正式导入前的预览：客户、订单、明细、新建的资料和提醒（只看） */
function ImportPreview({ plan }: { plan: PreviewPlan }) {
  const order = plan.order;
  return (
    <details>
      <summary>查看导入预览 · {amountText(plan.total)} 元</summary>
      <p>
        客户：{plan.customer.name}（{plan.customer.mode === 'new' ? '新建' : '已有'}）
      </p>
      <p>
        订单日期：{order.orderDate}；交货：{order.deliveryDate}；客户采购号：
        {order.externalPurchaseOrder || '未提供'}
      </p>
      <PreviewLines plan={plan} />
      <p>
        币种 {order.currency}；税率 {order.taxRate || '未注明'}；{order.taxMode}
        ；合同条件 {order.terms || '无'}；备注 {order.notes || '无'}
      </p>
      <NewRecords plan={plan} />
      {plan.warnings.map((w, i) => (
        <p key={i}>{w}</p>
      ))}
      <p>要导入就让助手正式导入：它会出一张确认卡片，点了确认才建订单。</p>
    </details>
  );
}

/** 这个会话里当前在办的那份识别任务：状态、链接和导入预览（只看；正式导入要在助手出的确认卡片上点确认） */
export default function AssistantOrderTask({ workflow }: { workflow: ThreadView['orderWorkflow'] }) {
  const task = workflow?.tasks.find((t) => t.id === workflow.activeId);
  if (!task) return null;
  const plan = previewPlanOf(task.preview),
    imported = importedOrderOf(task.result);
  return (
    <section className="ga-order-task" aria-label="当前订单任务">
      <div>
        <strong>{task.fileName}</strong>
        <span>{labels[task.state] || task.state}</span>
      </div>
      <a href={'#ai-import?workspace=' + task.workspaceId}>查看识别结果与进度</a>
      {task.focusLine && <span>当前产品：第{task.focusLine}行</span>}
      {imported && <a href={'#orders?order=' + imported.orderId}>正式订单 {imported.orderNumber}</a>}
      {task.error && <p role="status">{task.error}</p>}
      {plan && task.state !== 'imported' && <ImportPreview plan={plan} />}
    </section>
  );
}
