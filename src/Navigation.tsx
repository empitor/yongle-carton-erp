import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ClipboardList,
  Users,
  Package,
  Bot,
  FileUp,
  Trash2,
  Warehouse,
  Factory,
  ChevronDown,
} from 'lucide-react';
export default function Navigation({
  page,
  navigate,
}: {
  page: string;
  navigate: (page: string) => void;
}) {
  const [expanded, setExpanded] = useState({ orders: true, parties: true });
  useEffect(() => {
    if (['orders', 'purchases', 'arrivals'].includes(page))
      setExpanded((v) => ({ ...v, orders: true }));
    if (['customers', 'suppliers'].includes(page)) setExpanded((v) => ({ ...v, parties: true }));
  }, [page]);
  const item = (id: string, label: string, Icon: any) => (
    <button
      key={id}
      className={'nav-item' + (page === id ? ' selected' : '')}
      onClick={() => navigate(id)}
      aria-current={page === id ? 'page' : undefined}
    >
      <Icon size={19} />
      {label}
    </button>
  );
  const group = (
    key: 'orders' | 'parties',
    label: string,
    Icon: any,
    children: [string, string][],
  ) => (
    <div className="nav-business-group">
      <button
        className={
          'nav-item nav-group-title' +
          (children.some(([id]) => id === page) || (page === 'arrivals' && key === 'orders')
            ? ' active-group'
            : '')
        }
        aria-expanded={expanded[key]}
        aria-controls={'nav-' + key}
        onClick={() => setExpanded((v) => ({ ...v, [key]: !v[key] }))}
      >
        <Icon size={19} />
        {label}
        <ChevronDown size={15} className={expanded[key] ? 'nav-chevron opened' : 'nav-chevron'} />
      </button>
      {expanded[key] && (
        <div id={'nav-' + key} className="nav-submenu">
          {children.map(([id, label]) => (
            <button
              key={id}
              className={
                'nav-subitem' +
                (page === id || (page === 'arrivals' && id === 'purchases') ? ' selected' : '')
              }
              aria-current={page === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <nav>
      {item('dashboard', '经营概览', LayoutDashboard)}
      {group('orders', '订单业务', ClipboardList, [
        ['orders', '客户订单'],
        ['purchases', '采购订货'],
      ])}
      {group('parties', '往来单位', Users, [
        ['customers', '客户管理'],
        ['suppliers', '供应商管理'],
      ])}
      {item('products', '产品管理', Package)}
      {item('production', '生产管理', Factory)}
      {item('warehouse', '仓库管理', Warehouse)}
      {item('ai-settings', 'AI 设置', Bot)}
      {item('ai-import', 'AI 智能订单导入', FileUp)}
      {item('trash', '业务回收站', Trash2)}
    </nav>
  );
}
