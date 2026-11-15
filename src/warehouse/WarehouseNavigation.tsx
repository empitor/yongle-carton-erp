import { Segmented } from '../ui/index';
/**
 * 库存页里的一个分段：原材料 / 成品。到货、送货、流水是侧栏里各自的页面，这里不再重复放大卡片。
 */
const options = [
  ['raw', '原材料'],
  ['finished', '成品'],
] as const;
type WarehouseView = (typeof options)[number][0];
type Props = { view: WarehouseView; onChange: (view: WarehouseView) => void };
export default function WarehouseNavigation({ view, onChange }: Props) {
  return (
    <Segmented
      tabs
      className="warehouse-kind-tabs"
      label="库存分类"
      value={view}
      onChange={(v) => {
        const picked = options.find(([key]) => key === v);
        if (picked) onChange(picked[0]);
      }}
      options={options}
    />
  );
}
