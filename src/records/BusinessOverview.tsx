import { ArrowUpRight, ClipboardList, Truck, Warehouse, Package, AlertTriangle, Layers } from 'lucide-react';
import { movementTypeLabel } from '../../shared/business/index';
import { businessStatusTone } from '../recordkit/record-meta';
import { UNPRICED_TEXT, purchaseState } from '../../shared/business/index';
import { StatusChip } from '../ui/index';
import type { ReactNode } from 'react';
import type { Dashboard } from '../../shared/business/index';
import type { UnitBalance } from '../../shared/business/index';
import { yuan } from '../ui/index';
import { displayAmount as exactMoney, monthsBefore, today } from '../../shared/core/index';

type OverviewData = Dashboard['overview'];

/** 一个指标卡：点了去对应的列表 */
const metric = (href: string, label: string, value: ReactNode, detail: string, tone = '') => (
  <a className={'bo-metric ' + tone} href={href}>
    <span>
      {label}
      <ArrowUpRight size={15} />
    </span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </a>
);

/** 张数里有几张已归档的：点进去的列表不列已归档的，数对不上时看得懂；0 张不写 */
const archivedNote = (n: number) => (n > 0 ? '含已归档 ' + n + ' 张' : '');

/** 按单位分开的数量（张和只不相加） */
const units = (groups: UnitBalance[], empty = '暂无库存') =>
  groups.length ? (
    <div className="bo-units">
      {groups.map((g) => (
        <div key={g.unit}>
          <strong>
            {g.quantity}
            <small>{g.unit}</small>
          </strong>
          <span>{g.itemCount} 项明细</span>
        </div>
      ))}
    </div>
  ) : (
    <p className="bo-empty-inline">{empty}</p>
  );

/** 订单：总数、有效金额、待完成和逾期（实时）、状态分布、送货金额和预估毛利 */
function OrdersSection({ data, orders }: { data: Dashboard; orders: string }) {
  const v = data.overview;
  return (
    <section className="bo-section">
      <header>
        <div>
          <ClipboardList size={19} />
          <h2>订单</h2>
          <span>所选日期内</span>
        </div>
        <a href={orders}>
          查看订单 <ArrowUpRight size={15} />
        </a>
      </header>
      <div className="bo-metrics">
        {metric(orders, '订单总数', v.orders.total, ['包含待确认和已取消', archivedNote(v.orders.archived)].filter(Boolean).join('；'))}
        {metric(orders, '有效订单金额', '¥' + yuan(data.amountCents), '不含待确认、已取消', 'bo-accent')}
        {metric(
          '#orders?view=pending&range=all',
          '待完成订单 · 实时',
          v.orders.pendingAll,
          `所选日期内 ${v.orders.pendingInRange} 张，更早没完成的也算在内`,
        )}
        {metric(
          '#orders?view=pending&range=all',
          '逾期未发货 · 实时',
          v.orders.overdueAll,
          '按交货日期算，不含待确认',
          v.orders.overdueAll ? 'bo-warning' : '',
        )}
      </div>
      <div className="bo-order-bottom">
        <div className="bo-status-chart" aria-label="所选日期订单状态分布">
          {data.byStatus.map((s) => (
            <a key={s.status} href={orders + '&status=' + encodeURIComponent(s.status)}>
              <span>{s.status}</span>
              <i>
                <b
                  style={{
                    width: (v.orders.total ? (s.count / v.orders.total) * 100 : 0) + '%',
                  }}
                />
              </i>
              <strong>{s.count}</strong>
              {s.archived > 0 && <small>{archivedNote(s.archived)}</small>}
            </a>
          ))}
        </div>
        <div className="bo-financial">
          <span>
            送货金额 <strong>¥{yuan(data.deliveredCents)}</strong>
            {data.deliveryUncomputed > 0 && <small>另有 {data.deliveryUncomputed} 张算不出金额（缺单价、数量或尺寸），未计入</small>}
          </span>
          <span>
            已核算预估成本 <strong>¥{yuan(data.estimatedCostCents)}</strong>
          </span>
          <span>
            对应预估毛利{' '}
            <strong className={data.estimatedProfitCents < 0 ? 'bo-negative' : ''}>
              ¥{yuan(data.estimatedProfitCents)}
            </strong>
          </span>
          <small>
            只算 {data.costedCount} 张已核算成本的订单，另有 {data.uncostedCount} 张待核算；不是净利润或会计收入。
          </small>
          <a href={'#orders?scope=all&range=custom&end=' + monthsBefore(today(), 2)}>两个月前已完结的订单 {v.orders.history} 张</a>
        </div>
      </div>
    </section>
  );
}

/** 采购：期间采购单、已定价金额、到货金额、待到货（实时）、近期采购 */
function PurchasesSection({ v, purchases }: { v: OverviewData; purchases: string }) {
  return (
    <section className="bo-section">
      <header>
        <div>
          <Truck size={19} />
          <h2>采购</h2>
          <span>外购瓦楞纸板</span>
        </div>
        <a href={purchases}>
          查看采购单 <ArrowUpRight size={15} />
        </a>
      </header>
      <div className="bo-metrics bo-purchase-metrics">
        {metric(
          purchases,
          '期间采购单',
          v.purchases.total,
          [`所选日期内 ${v.purchases.pending} 张还没到齐`, archivedNote(v.purchases.archived)].filter(Boolean).join('；'),
        )}
        {metric(
          purchases,
          '已定价采购金额',
          '¥' + exactMoney(v.purchases.amount),
          `不含已取消；${v.purchases.unknownPrices} 张没定价，未计入`,
        )}
        {metric(
          purchases,
          '到货金额',
          '¥' + yuan(v.purchases.arrivedCents),
          '所选日期内的到货单，按实际入库数量和单据上的单价算，不另加税' +
            (v.purchases.arrivalUncomputed ? `；${v.purchases.arrivalUncomputed} 张算不出金额（缺单价、数量或尺寸），未计入` : ''),
        )}
        {metric('#purchases?pending=1', '待到货采购单 · 实时', v.purchases.pendingAll, '包含待订货、待到货和部分到货')}
        <a className="bo-metric" href="#purchases?pending=1">
          <span>
            剩余待到货 · 实时
            <ArrowUpRight size={15} />
          </span>
          {units(v.purchases.outstanding, '没有待到货的数量')}
          <small>订购数量减去已到货，按单位分别统计</small>
        </a>
      </div>
      <div className="bo-table table-wrap">
        <table>
          <thead>
            <tr>
              <th>近期采购 / 供应商</th>
              <th>采购日期</th>
              <th>状态 / 到货进度</th>
              <th>金额 / 元</th>
            </tr>
          </thead>
          <tbody>
            {v.purchases.recent.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={'#purchases?record=' + p.id}>
                    <strong>{p.number}</strong>
                  </a>
                  <span className="sub">{p.supplierName}</span>
                </td>
                <td>{p.orderDate}</td>
                <td>
                  <StatusChip tone={businessStatusTone(purchaseState(p))}>{purchaseState(p)}</StatusChip>
                </td>
                <td>{p.totalAmount === null ? UNPRICED_TEXT : exactMoney(p.totalAmount)}</td>
              </tr>
            ))}
            {!v.purchases.recent.length && (
              <tr>
                <td colSpan={4}>
                  <div className="records-empty">
                    <strong>所选日期没有采购单</strong>
                    <a href="#purchases">查看采购单</a>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 库存：原材料、成品按单位的实时余额，零库存 */
function InventorySection({ v }: { v: OverviewData }) {
  return (
    <section className="bo-section">
      <header>
        <div>
          <Warehouse size={19} />
          <h2>库存</h2>
          <span>实时余额，不受日期影响</span>
        </div>
        <a href="#warehouse">
          查看库存 <ArrowUpRight size={15} />
        </a>
      </header>
      <div className="bo-inventory-grid">
        <a className="bo-stock" href="#warehouse?kind=raw">
          <div>
            <Layers size={21} />
            <h3>原材料</h3>
            <span>{v.inventory.rawCount} 种库存品</span>
          </div>
          {units(v.inventory.raw)}
          <small>外购瓦楞纸板；不同单位分别统计</small>
        </a>
        <a className="bo-stock" href="#warehouse?kind=finished">
          <div>
            <Package size={21} />
            <h3>成品</h3>
            <span>{v.inventory.finishedCount} 种库存品</span>
          </div>
          {units(v.inventory.finished)}
          <small>加工完成的纸箱；余额按出入库流水计算</small>
        </a>
        <a className="bo-stock bo-stock-alert" href="#warehouse?zero=1">
          <div>
            <AlertTriangle size={20} />
            <h3>零库存</h3>
          </div>
          <strong>
            {v.inventory.zeroCount}
            <small> 项</small>
          </strong>
          <p>已建档但余额为零的库存品。没有设最低库存线，不推测“库存偏低”。</p>
        </a>
      </div>
    </section>
  );
}

/** 产品：总数和资料待补的 */
function ProductStrip({ v }: { v: OverviewData }) {
  return (
    <section className="bo-product-strip">
      <Package size={22} />
      <div>
        <h2>产品</h2>
        <p>当前有效的产品档案</p>
      </div>
      <a href="#products">
        <strong>{v.products.total}</strong>
        <span>
          产品总数 <ArrowUpRight size={14} />
        </span>
      </a>
      <a href="#products">
        <strong>{v.products.incomplete}</strong>
        <span>
          尺寸或配纸资料待补 <ArrowUpRight size={14} />
        </span>
      </a>
    </section>
  );
}

/** 最近出入库：所选日期内最多 8 条 */
function RecentMovements({ v }: { v: OverviewData }) {
  return (
    <section className="bo-section">
      <header>
        <div>
          <h2>最近出入库</h2>
          <span>所选日期内，最多 8 条</span>
        </div>
        <a href="#warehouse?flow=1">查看流水</a>
      </header>
      <div className="bo-movements">
        {v.movements.map((m) => (
          <a key={m.id} href={'#warehouse?flow=1&kind=' + m.kind}>
            <div>
              <strong>{m.itemName}</strong>
              <span>
                {m.date} ·{' '}
                {m.purchaseNumber || m.customerOrderNumber || movementTypeLabel(m) || '库存变动'}
              </span>
            </div>
            <b className={m.direction === '-' ? 'bo-negative' : ''}>
              {m.direction}
              {m.delta} {m.unit}
            </b>
          </a>
        ))}
        {!v.movements.length && (
          <div className="records-empty">
            <strong>所选日期没有出入库</strong>
            <span>到货、完工、送货或手动出入库后会显示在这里。</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** 近期动态：按业务日期排 */
function RecentActivity({ v }: { v: OverviewData }) {
  return (
    <section className="bo-section">
      <header>
        <div>
          <h2>近期动态</h2>
          <span>按业务日期排序</span>
        </div>
      </header>
      <ol className="bo-activity">
        {v.activity.map((a) => (
          <li key={a.id}>
            <a href={a.target}>
              <time>{a.date}</time>
              <div>
                <small>{a.category}</small>
                <strong>{a.title}</strong>
                <span>{a.detail}</span>
              </div>
              <ArrowUpRight size={14} />
            </a>
          </li>
        ))}
        {!v.activity.length && (
          <li className="records-empty">
            <strong>所选日期没有业务动态</strong>
            <span>把统计日期换成“全部日期”可以看更早的记录。</span>
          </li>
        )}
      </ol>
    </section>
  );
}

/** 经营概况：这段时间的接单、发货、采购、库存和流水（数据由今日页切到“经营概况”时读）。 */
export default function Overview({ data, rangeFilter }: { data: Dashboard; rangeFilter?: ReactNode }) {
  const v = data.overview,
    range = new URLSearchParams({ range: 'custom' });
  if (v.range.start) range.set('start', v.range.start);
  if (v.range.end) range.set('end', v.range.end);
  return (
    <div className="business-overview td-overview">
      {rangeFilter}
      <p className="td-scope">
        订单按下单日期、采购按采购日期、出入库按业务日期统计，已归档的也算；标“实时”的数字、库存和产品不受日期影响，实时的数字和最近的记录不算已归档的。
      </p>
      <OrdersSection data={data} orders={'#orders?' + range} />
      <PurchasesSection v={v} purchases={'#purchases?' + range} />
      <InventorySection v={v} />
      <ProductStrip v={v} />
      <div className="bo-bottom-grid">
        <RecentMovements v={v} />
        <RecentActivity v={v} />
      </div>
    </div>
  );
}
