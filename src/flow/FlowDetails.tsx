import { FINISHED_UNIT, finishedUnit } from '../../shared/core/index';
import { flowStatusText, type FlowDocView, type FlowKind } from '../../shared/business/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { businessStatusTone, useRecordContext } from '../recordkit/record-meta';
import ProductMarks from '../marks/ProductMarks';
import { ArrivalLines, DeliveryLines } from './DocLines';
import { planDate } from '../../shared/business/index';
import { Facts, Hint, Progress, Section, StatusChip, type Tone } from '../ui/index';
import { MaterialsTable, TaskProduction } from './FlowTaskSections';
import { flowOverdue, shipDate } from './flow-dates';
import { waitingText } from './task-progress';
import CorrectionNote from './CorrectionNote';

/** 详情要对照的档案（显示名称、单号、单位用）：单据页读的全部清单，AI 导入的到货单只读了到货要的几份 */
type DetailData = Partial<CatalogLists>;

const agentModule: Record<FlowKind, string> = {
  arrival: 'arrivals',
  task: 'production_tasks',
  production: 'production_records',
  delivery: 'deliveries',
};

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

/** 详情标题下面那一行：最关键的上下文。 */
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
      return [customer, d.address].filter(Boolean).join(' · ');
    }
  }
}

/** 按单据种类的正文 */
function KindDetails({ d, data, person }: { d: FlowDocView; data: DetailData; person: string }) {
  switch (d.kind) {
    case 'task':
      return <TaskDetails d={d} data={data} person={person} />;
    case 'production':
      return <ProductionDetails d={d} data={data} person={person} />;
    case 'arrival':
      return <ArrivalDetails d={d} data={data} person={person} />;
    case 'delivery':
      return <DeliveryDetails d={d} data={data} person={person} />;
  }
}

export default function FlowDetails({ doc: d, data }: { doc: FlowDocView; data: DetailData }) {
  useRecordContext(agentModule[d.kind], d.id, d.number);
  const person = d.confirmedBy || d.actorName;
  return (
    <div
      className="flow-details"
      data-agent-module={agentModule[d.kind]}
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

      <KindDetails d={d} data={data} person={person} />
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
              value: d.taskId ? <a href={'#production?doc=' + d.taskId}>{task?.number || '查看任务'}</a> : '不挂任务的完工',
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

/**
 * 到货单：到货明细（对上的采购单）、到货时间、送货单号、原件。
 * 过了核对这一步的（已入库、已取消、已撤销）明细的入库数没有就写“—”，还待入库的写“核对时算”（和到货页同一个判断）。
 */
function ArrivalDetails({ d, data, person }: { d: FlowDocView<'arrival'>; data: DetailData; person: string }) {
  return (
    <>
      <ArrivalLines
        lines={d.lines}
        confirmed={d.status !== 'draft'}
        purchaseOf={(l) => data.purchases?.find((p) => p.lines.some((x) => x.id === l.purchaseLineId))}
      />
      <Section title="基本信息">
        <Facts
          items={[
            { label: '实际到货', value: [d.date, d.actualTime || ''].join(' ').trim() },
            { label: '供应商送货单号', value: d.reference },
            { label: '经办人', value: person },
            {
              label: '送货单原件',
              value: d.sourceId ? (
                <a target="_blank" rel="noreferrer" href={'/api/flow/sources/' + d.sourceId + '/file'}>
                  查看原件
                </a>
              ) : (
                ''
              ),
              hidden: !d.sourceId,
            },
            { label: '备注', value: d.notes, wide: true, hidden: !d.notes },
          ]}
        />
      </Section>
    </>
  );
}

/** 送货单：送货明细（对上的订单明细）、计划和实际发货、送达、联系人和地址 */
function DeliveryDetails({ d, data, person }: { d: FlowDocView<'delivery'>; data: DetailData; person: string }) {
  return (
    <>
      <DeliveryLines
        lines={d.lines}
        orderLineOf={(l) => {
          const order = data.orders?.find((o) => o.id === l.orderId);
          return { order, line: order?.lines.find((x) => x.id === l.orderLineId) };
        }}
      />
      <Section title="基本信息">
        <Facts
          items={[
            { label: '计划送货', value: [planDate(d), d.plannedTime].filter(Boolean).join(' ') },
            { label: '实际发货', value: shipDate(d) || '还没出库' },
            { label: '送达', value: d.deliveredAt, hidden: !d.deliveredAt },
            { label: '联系人', value: [d.contact, d.phone].filter(Boolean).join(' ') },
            { label: '经办人', value: person },
            { label: '收货地址', value: d.address, wide: true },
            { label: '备注', value: d.notes, wide: true, hidden: !d.notes },
          ]}
        />
      </Section>
    </>
  );
}

/** 关联订单：每张一个链接，顿号隔开；没有关联返回 null */
function orderLinks(ids: number[], data: DetailData) {
  return ids.length
    ? ids.map((id, i) => (
        <span key={id}>
          {i > 0 && '、'}
          <a href={'#orders?order=' + id}>{data.orders?.find((o) => o.id === id)?.number || '订单'}</a>
        </span>
      ))
    : null;
}
