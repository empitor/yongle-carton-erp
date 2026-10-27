import {
  ArrowUpRight,
  ClipboardList,
  Truck,
  Warehouse,
  Package,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import type { Dashboard } from '../shared/domain';
import type { UnitBalance } from '../shared/overview';
import './overview.css';
import StatusBadge from './StatusBadge';
import { displayAmount as exactMoney } from '../shared/display-amount';
const money = (cents: number) =>
  (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export default function DashboardPage({ data }: { data: Dashboard }) {
  if (!data.overview)
    return (
      <div className="error" role="alert">
        当前后端仍是旧版本，请关闭原服务并重新启动系统，再刷新页面。
      </div>
    );
  const v = data.overview,
    range = new URLSearchParams({ range: 'custom' });
  if (v.range.start) range.set('start', v.range.start);
  if (v.range.end) range.set('end', v.range.end);
  const orders = '#orders?' + range,
    purchases = '#purchases?' + range;
  const metric = (
    href: string,
    label: string,
    value: string | number,
    detail: string,
    tone = '',
  ) => (
    <a className={'bo-metric ' + tone} href={href}>
      <span>
        {label}
        <ArrowUpRight size={15} />
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </a>
  );
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
  return (
    <div className="business-overview">
      <div className="bo-scope">
        <CalendarScope />
        <p>
          <strong>统计口径</strong>
          ：订单按下单日期、采购按采购日期、出入库按业务日期筛选。待处理总数、待到货余量、库存余额与产品档案为实时全量数据，不受日期范围限制；手工归档记录不计入。
        </p>
      </div>
      <section className="bo-section">
        <header>
          <div>
            <ClipboardList size={19} />
            <h2>订单概况</h2>
            <span>所选日期内</span>
          </div>
          <a href={orders}>
            客户订单 <ArrowUpRight size={15} />
          </a>
        </header>
        <div className="bo-metrics">
          {metric(orders, '订单总数', v.orders.total, '包含草稿与取消')}
          {metric(
            orders,
            '有效订单金额',
            '¥' + money(data.amountCents),
            '不含草稿、取消',
            'bo-accent',
          )}
          {metric(
            '#orders?view=pending&range=all',
            '待完成订单 · 实时',
            v.orders.pendingAll,
            `所选日期内 ${v.orders.pendingInRange} 张，更早未完成仍保留`,
          )}
          {metric(
            '#orders?view=pending&range=all',
            '逾期未发货 · 实时',
            v.orders.overdueAll,
            '按交货日期判断，不含草稿',
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
                    style={{ width: (v.orders.total ? (s.count / v.orders.total) * 100 : 0) + '%' }}
                  />
                </i>
                <strong>{s.count}</strong>
              </a>
            ))}
          </div>
          <div className="bo-financial">
            <span>
              已发货订单金额 <strong>¥{money(data.shippedCents)}</strong>
            </span>
            <span>
              已核算预估成本 <strong>¥{money(data.estimatedCostCents)}</strong>
            </span>
            <span>
              对应预估毛利{' '}
              <strong className={data.estimatedProfitCents < 0 ? 'bo-negative' : ''}>
                ¥{money(data.estimatedProfitCents)}
              </strong>
            </span>
            <small>
              仅 {data.costedCount} 张已核算订单计算毛利，{data.uncostedCount}{' '}
              张待核算；非净利润或会计收入。
            </small>
            <a href="#orders?view=history&range=all">
              历史归档 {v.orders.history} 张 · 查看历史订单
            </a>
          </div>
        </div>
      </section>
      <section className="bo-section">
        <header>
          <div>
            <Truck size={19} />
            <h2>采购概况</h2>
            <span>外购瓦楞纸板</span>
          </div>
          <a href={purchases}>
            采购订货 <ArrowUpRight size={15} />
          </a>
        </header>
        <div className="bo-metrics bo-purchase-metrics">
          {metric(
            purchases,
            '期间采购单',
            v.purchases.total,
            `所选日期内 ${v.purchases.pending} 张待完成到货`,
          )}
          {metric(
            purchases,
            '已定价采购金额',
            '¥' + exactMoney(v.purchases.amount),
            `不含取消；${v.purchases.unknownPrices} 张未定价未计入`,
          )}
          {metric(
            '#purchases?pending=1',
            '待到货采购单 · 实时',
            v.purchases.pendingAll,
            '包含待订货、已订货及部分到货',
          )}
          <a className="bo-metric" href="#purchases?pending=1">
            <span>
              剩余待到货 · 实时
              <ArrowUpRight size={15} />
            </span>
            {units(v.purchases.outstanding, '暂无待到货数量')}
            <small>订购数量 − 累计到货，按单位分别统计</small>
          </a>
        </div>
        <div className="bo-table table-wrap">
          <table>
            <thead>
              <tr>
                <th>近期采购 / 供应商</th>
                <th>采购日期</th>
                <th>状态</th>
                <th>金额 / 元</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {v.purchases.recent.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.number}</strong>
                    <span className="sub">{p.supplierName}</span>
                  </td>
                  <td>{p.orderDate}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>{p.totalAmount === null ? '待定价' : exactMoney(p.totalAmount)}</td>
                  <td>
                    <a href={'#purchases?q=' + encodeURIComponent(p.number)}>查看</a>
                  </td>
                </tr>
              ))}
              {!v.purchases.recent.length && (
                <tr>
                  <td colSpan={5}>
                    <div className="records-empty">
                      <strong>所选日期暂无采购单</strong>
                      <a href="#purchases">前往采购订货</a>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="bo-section">
        <header>
          <div>
            <Warehouse size={19} />
            <h2>库存概况</h2>
            <span>实时余额 · 不受日期筛选限制</span>
          </div>
          <a href="#warehouse">
            仓库管理 <ArrowUpRight size={15} />
          </a>
        </header>
        <div className="bo-inventory-grid">
          <a className="bo-stock" href="#warehouse?kind=raw">
            <div>
              <Layers size={21} />
              <h3>原材料库存</h3>
              <span>{v.inventory.rawCount} 种库存品</span>
            </div>
            {units(v.inventory.raw)}
            <small>外购瓦楞纸板；不同单位分别统计</small>
          </a>
          <a className="bo-stock" href="#warehouse?kind=finished">
            <div>
              <Package size={21} />
              <h3>成品库存</h3>
              <span>{v.inventory.finishedCount} 种库存品</span>
            </div>
            {units(v.inventory.finished)}
            <small>加工完成的纸箱；余额由出入库流水计算</small>
          </a>
          <a className="bo-stock bo-stock-alert" href="#warehouse?zero=1">
            <div>
              <AlertTriangle size={20} />
              <h3>库存提醒</h3>
            </div>
            <strong>
              {v.inventory.zeroCount}
              <small> 项零库存</small>
            </strong>
            <p>仅提醒已建档但余额为零的库存品。尚未设置最低库存线，不推测低库存阈值。</p>
          </a>
        </div>
      </section>
      <section className="bo-product-strip">
        <Package size={22} />
        <div>
          <h2>产品概况</h2>
          <p>当前有效产品档案，与产品管理一致</p>
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
            尺寸或配纸资料待补充 <ArrowUpRight size={14} />
          </span>
        </a>
      </section>
      <div className="bo-bottom-grid">
        <section className="bo-section">
          <header>
            <div>
              <h2>最近出入库</h2>
              <span>所选日期内 · 最多 8 条</span>
            </div>
            <a href="#warehouse?flow=1">全部流水</a>
          </header>
          <div className="bo-movements">
            {v.movements.map((m) => (
              <a key={m.id} href={'#warehouse?flow=1&kind=' + m.kind}>
                <div>
                  <strong>{m.itemName}</strong>
                  <span>
                    {m.date} ·{' '}
                    {m.purchaseNumber ||
                      { in: '手动入库', out: '手动出库', adjust: '盘点调整', purchase: '采购到货' }[
                        m.action as 'in'
                      ]}
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
                <strong>所选日期暂无出入库记录</strong>
                <span>采购到货或手动出入库后会在此显示。</span>
              </div>
            )}
          </div>
        </section>
        <section className="bo-section">
          <header>
            <div>
              <h2>近期业务动态</h2>
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
                <strong>所选日期暂无业务动态</strong>
                <span>可切换“全部日期”查看历史记录。</span>
              </li>
            )}
          </ol>
        </section>
      </div>
    </div>
  );
}
function CalendarScope() {
  return <span className="bo-scope-mark">日期说明</span>;
}
