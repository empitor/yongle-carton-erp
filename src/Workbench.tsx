import { ShoppingCart, Factory, Warehouse, ArrowRight, Plus } from 'lucide-react';
import type { BusinessOverview } from '../shared/overview';
export default function Workbench({
  value,
  overview,
}: {
  value: NonNullable<BusinessOverview['workbench']>;
  overview: BusinessOverview;
}) {
  const date = value.date;
  const chain = (
    title: string,
    Icon: any,
    stages: [string, string, number, string][],
    action: [string, string],
  ) => (
    <section className="workflow-chain">
      <header>
        <Icon size={22} />
        <h2>{title}</h2>
        <a href={action[1]}>{action[0]}</a>
      </header>
      <div className="workflow-stages">
        {stages.map(([label, description, count, href], i) => (
          <a href={href} key={label}>
            <span className="workflow-step">{i + 1}</span>
            <div>
              <strong>{label}</strong>
              <small>{description}</small>
            </div>
            <b>
              {count}
              <small>
                {label.includes('库存') ? '项' : label.includes('任务') ? '项' : '单 / 批'}
              </small>
            </b>
            {i < stages.length - 1 && <ArrowRight className="workflow-arrow" size={18} />}
          </a>
        ))}
      </div>
    </section>
  );
  return (
    <div className="workbench">
      <div className="workbench-heading">
        <div>
          <h2>今日业务 · {date}</h2>
          <p>待处理为当前全部记录，今日完成按实际业务日期统计。</p>
        </div>
        <div className="workbench-shortcuts">
          <a className="action-link primary" href="#orders?create=1">
            <Plus size={16} />
            新建销售订单
          </a>
          <a className="action-link" href="#purchases?create=1">
            新建采购单
          </a>
          <a className="action-link" href={'#production?date=' + date}>
            今日生产任务
          </a>
        </div>
      </div>
      {chain(
        '采购管理',
        ShoppingCart,
        [
          ['采购订货', '待订货采购单', value.toOrder, '#purchases?businessStatus=待订货'],
          [
            '到货验收',
            '待执行到货计划 / 草稿',
            value.pendingArrivals,
            '#warehouse?arrivals=1&state=pending&scope=all',
          ],
          [
            '原材料入库',
            '今日实际到货批次',
            value.arrivalsToday,
            '#warehouse?arrivals=1&state=completed&date=' + date,
          ],
        ],
        ['查看采购进度', '#purchases?pending=1'],
      )}
      {chain(
        '销售履约',
        Factory,
        [
          [
            '销售订单',
            '尚未完成订单',
            overview.orders.pendingAll,
            '#orders?view=pending&range=all',
          ],
          ['生产任务', '尚未完工任务', value.activeTasks, '#production?scope=all&pending=1'],
          [
            '成品入库',
            '今日确认完工登记',
            value.productionToday,
            '#production?view=production&range=custom&start=' + date + '&end=' + date,
          ],
          [
            '送货',
            '待执行送货计划',
            value.pendingDeliveries,
            '#warehouse?deliveries=1&kind=finished&state=pending&scope=all',
          ],
        ],
        ['查看今日送货', '#warehouse?deliveries=1&kind=finished&date=' + date],
      )}
      {chain(
        '库存管理',
        Warehouse,
        [
          [
            '库存查询',
            '原材料与成品档案',
            overview.inventory.rawCount + overview.inventory.finishedCount,
            '#warehouse',
          ],
          ['零库存提醒', '已建档且余额为零', overview.inventory.zeroCount, '#warehouse?zero=1'],
          ['采购补货', '已建采购中待订货', value.toOrder, '#purchases?businessStatus=待订货'],
          [
            '进度跟踪',
            '尚有未到货数量的采购',
            overview.purchases.pendingAll,
            '#purchases?pending=1',
          ],
        ],
        ['查看出入库流水', '#warehouse?flow=1'],
      )}
      <p className="help-text">
        库存提醒仅反映零余额；尚未配置安全库存线。生产任务、采购与送货分别保留计划和实际执行记录。
      </p>
    </div>
  );
}
