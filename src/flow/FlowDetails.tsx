import { FINISHED_UNIT, finishedUnit, flowDocHref, pageHref } from '../../shared/core/index';
import {
  flowStatusText,
  type ArrivalDaily,
  type DeliveryDaily,
  type FlowDocView,
} from '../../shared/business/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { businessStatusTone, useRecordContext } from '../recordkit/record-meta';
import ProductMarks from '../marks/ProductMarks';
import { planDate } from '../../shared/business/index';
import { Facts, Hint, Progress, Section, StatusChip, type Tone } from '../ui/index';
import { MaterialsTable, TaskProduction } from './FlowTaskSections';
import { flowOverdue } from './flow-dates';
import { waitingText } from './task-progress';
import CorrectionNote from './CorrectionNote';
import { ArrivalSections, DeliverySections, handler } from './FlowDocSections';

/** 详情要对照的档案（显示名称、单号、单位用）：单据页读的全部清单，AI 导入的到货单只读了到货要的几份 */
type DetailData = Partial<CatalogLists>;
/** 到货单、送货单在台账里的样子（flow-api.ts 的 readFlowRecord 读的）：验收入库、每行的进度和流水 */
export type FlowRecord = ArrivalDaily | DeliveryDaily;
type DetailProps = { doc: FlowDocView; data: DetailData; record?: FlowRecord };

/** 单据状态的颜色：按状态文字走全站同一个颜色函数 */
export function flowStatusTone(d: Parameters<typeof flowStatusText>[0]): Tone {
  return businessStatusTone(flowStatusText(d));
}

/** 列表和详情头部的状态：已归档、逾期分别再加一个标签。 */
export function FlowStatus({ doc }: { doc: FlowDocView }) {
  return (
    <span className="flow-status">
      <StatusChip tone={doc.archived ? 'neutral' : flowStatusTone(doc)}>{flowStatusText(doc)}</StatusChip>
      {doc.archived ? (
        <StatusChip tone="neutral">已归档</StatusChip>
      ) : (
        flowOverdue(doc) && <StatusChip tone="danger">逾期</StatusChip>
      )}
    </span>
  );
}

/** 产品名：单据上存了的用存的，没存的按档案补上 */
const productNameOf = (d: { productName?: string; productId: number }, data: DetailData) =>
  d.productName || data.products?.find((p) => p.id === d.productId)?.name;

/** 详情标题下面那一行：最关键的上下文（到货、送货写往来单位和几种货）。 */
export function flowSubtitle(d: FlowDocView, data: DetailData) {
  switch (d.kind) {
    // 成品数量都带单位“只”，和详情、列表一样
    case 'task':
      return [productNameOf(d, data), '计划 ' + d.quantity + ' ' + finishedUnit(d.unit)].filter(Boolean).join(' · ');
    case 'production':
      return [
        productNameOf(d, data),
        '合格 ' + d.goodQuantity + ' ' + FINISHED_UNIT +
          (d.scrapQuantity && d.scrapQuantity !== '0' ? '，报废 ' + d.scrapQuantity + ' ' + FINISHED_UNIT : ''),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'arrival': {
      const supplier = d.supplierName || data.suppliers?.find((s) => s.id === d.supplierId)?.name;
      return [supplier, d.lines.length + ' 种纸板'].filter(Boolean).join(' · ');
    }
    case 'delivery': {
      const customer = d.customerName || data.customers?.find((c) => c.id === d.customerId)?.name;
      return [customer, d.lines.length + ' 种产品'].filter(Boolean).join(' · ');
    }
  }
}

/** 按单据种类的正文；到货单、送货单的在 FlowDocSections.tsx */
function KindDetails({ doc: d, data, record }: DetailProps) {
  const person = handler(d);
  switch (d.kind) {
    case 'task':
      return <TaskDetails d={d} data={data} person={person} />;
    case 'production':
      return <ProductionDetails d={d} data={data} person={person} />;
    case 'arrival':
      return <ArrivalSections d={d} data={data} record={record && 'flowId' in record ? record : undefined} />;
    case 'delivery':
      return <DeliverySections d={d} data={data} record={record && !('flowId' in record) ? record : undefined} />;
  }
}

/**
 * 一张单据的详情正文（单据页、库存页、归档、单据窗口、核对窗都是这一份）：更正、撤销、取消、逾期的提示，再按种类的正文。
 * record 是到货单、送货单的台账记录（核对窗里没有）。
 */
export default function FlowDetails({ doc: d, data, record }: DetailProps) {
  // 告诉助手正在看哪张单据：报单据种类（全站的记录种类），助手那边换成它自己的模块名
  useRecordContext(d.kind, d.id, d.number);
  return (
    <div
      className="flow-details"
      data-agent-module={d.kind}
      data-agent-record={d.id}
      data-agent-label={d.number}
    >
      <CorrectionNote d={d} />
      {d.reversal && !d.replacedBy && (
        <Hint tone="danger">
          已撤销：{d.reversal.reason}（{d.reversal.by}，{d.reversal.at}）
        </Hint>
      )}
      {d.cancellation && (
        <Hint tone="warning">
          已取消：{d.cancellation.reason}（{d.cancellation.by}，{d.cancellation.at}）。已完工的部分和库存记录保留。
        </Hint>
      )}
      {flowOverdue(d) && (
        <Hint tone="warning">
          计划 {planDate(d)}
          {d.kind === 'task' ? ' 生产，已经过了还没做完。' : ' 送货，已经过了还没出库。'}
        </Hint>
      )}

      <KindDetails doc={d} data={data} record={record} />
    </div>
  );
}

/** 生产任务：完工进度（另有已登记、待核对入库的写在后面）、计划和实际、关联订单，名下的完工记录和领料，产品的唛头 */
function TaskDetails({ d, data, person }: { d: FlowDocView<'task'>; data: DetailData; person: string }) {
  const waiting = waitingText(d);
  return (
    <>
      <Progress
        label="完工进度"
        done={d.completed || '0'}
        total={d.quantity}
        unit={d.unit}
        text={
          waiting ? (
            <>
              {d.completed || '0'} / {d.quantity} {d.unit}（另有 {waiting} {d.unit}已登记、待核对入库）
            </>
          ) : undefined
        }
      />
      <Section title="基本信息">
        <Facts
          items={[
            { label: '计划生产', value: [planDate(d), d.plannedTime].filter(Boolean).join(' ') },
            {
              label: '实际完工',
              value: d.actualCompletionDate || (d.actualStartDate ? d.actualStartDate + ' 开工，还没做完' : '还没开工'),
            },
            { label: '关联订单', value: orderLinks(d.orderIds, data) || '独立备货，不关联订单' },
            { label: '经办人', value: person },
            { label: '备注', value: d.notes, wide: true, hidden: !d.notes },
          ]}
        />
      </Section>
      <TaskProduction task={d} data={data} />
      {d.productId && (
        <div className="record-section">
          <ProductMarks productId={d.productId} readOnly />
        </div>
      )}
    </>
  );
}

/** 完工记录：挂哪张任务、合格和报废、领料，产品的唛头 */
function ProductionDetails({ d, data, person }: { d: FlowDocView<'production'>; data: DetailData; person: string }) {
  const task = d.taskId ? data.tasks?.find((t) => t.id === d.taskId) : null;
  return (
    <>
      <Section title="基本信息">
        <Facts
          items={[
            {
              label: '生产任务',
              value: d.taskId ? <a href={flowDocHref('task', d.taskId)}>{task?.number || '查看任务'}</a> : '不挂任务的完工',
            },
            { label: '完工日期', value: d.date },
            {
              label: '合格 / 报废',
              value:
                d.goodQuantity +
                ' / ' +
                (d.scrapQuantity || '0') +
                ' ' +
                (data.items?.find((s) => s.id === d.finishedStockId)?.unit || task?.unit || ''),
            },
            { label: '机台操作', value: d.operator },
            { label: '经办人', value: person },
            // 完工单的备注就是成品库存里那一批的“批次备注”，和完工窗口、批次同一个叫法
            { label: '批次备注', value: d.notes, wide: true, hidden: !d.notes },
          ]}
        />
      </Section>
      <MaterialsTable rows={d.materials} data={data} />
      {d.productId && (
        <div className="record-section">
          <ProductMarks productId={d.productId} readOnly />
        </div>
      )}
    </>
  );
}

/** 关联订单：每张一个链接，顿号隔开；没有关联返回 null */
function orderLinks(ids: number[], data: DetailData) {
  return ids.length
    ? ids.map((id, i) => (
        <span key={id}>
          {i > 0 && '、'}
          <a href={pageHref('orders', { order: id })}>{data.orders?.find((o) => o.id === id)?.number || '订单'}</a>
        </span>
      ))
    : null;
}
