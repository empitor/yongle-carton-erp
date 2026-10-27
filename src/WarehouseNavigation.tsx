import { Layers, Package, ArrowLeftRight, Truck } from 'lucide-react';
export type WarehouseView = 'raw' | 'finished' | 'flows' | 'deliveries';
export default function WarehouseNavigation({
  view,
  onChange,
}: {
  view: WarehouseView;
  onChange: (view: WarehouseView) => void;
}) {
  return (
    <div className="warehouse-navigation" role="tablist" aria-label="仓库视图">
      {(
        [
          ['raw', '原材料库存', '外购瓦楞纸板的当前余额', Layers],
          ['finished', '成品库存', '加工完成纸箱的当前余额', Package],
          ['flows', '出入库流水', '每笔入库、出库和盘点记录', ArrowLeftRight],
          ['deliveries', '送货记录', '客户发货、分批交付与历史单据', Truck],
        ] as const
      ).map(([key, title, description, Icon]) => (
        <button
          key={key}
          role="tab"
          id={'warehouse-tab-' + key}
          aria-controls="warehouse-content"
          aria-label={title}
          aria-selected={view === key}
          onClick={() => onChange(key)}
          onKeyDown={(event) => {
            const views: WarehouseView[] = ['raw', 'finished', 'flows', 'deliveries'],
              index = views.indexOf(key);
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % views.length
                : event.key === 'ArrowLeft'
                  ? (index + views.length - 1) % views.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? views.length - 1
                      : -1;
            if (next >= 0) {
              event.preventDefault();
              onChange(views[next]);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }
          }}
        >
          <Icon size={20} />
          <span>
            <strong>{title}</strong>
            <small>{description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
