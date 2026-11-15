import type { ComponentProps } from 'react';
import BusinessRecords from './BusinessRecords';
import type { RecordEditor } from './RecordEditors';
import type { RecordRowOf } from './record-rows';
import type { RecordLists } from './useRecordLists';

/** 订单、客户、产品三种列表：订单页、客户页、产品页和归档页里这三类用 */
export type ListKind = 'orders' | 'customers' | 'products';

/** 每种列表的行（客户、产品按搜索词和范围筛过） */
const rowsOf: { [K in ListKind]: (lists: RecordLists) => RecordRowOf[K][] } = {
  orders: (lists) => lists.orders,
  customers: (lists) => lists.customerRows,
  products: (lists) => lists.productRows,
};
/** 点“编辑”打开哪个编辑窗 */
const editorOf: { [K in ListKind]: (value: RecordRowOf[K]) => RecordEditor } = {
  orders: (value) => ({ kind: 'orders', value }),
  customers: (value) => ({ kind: 'customers', value }),
  products: (value) => ({ kind: 'products', value }),
};

type Props<K extends ListKind> = Omit<ComponentProps<typeof BusinessRecords<K>>, 'entity' | 'rows' | 'edit'> & {
  kind: K;
  lists: RecordLists;
  edit: (editor: RecordEditor) => void;
};

/** 订单、客户、产品的列表：行和编辑窗按种类对上 */
export default function KindRecords<K extends ListKind>({ kind, lists, edit, ...rest }: Props<K>) {
  return <BusinessRecords {...rest} entity={kind} rows={rowsOf[kind](lists)} edit={(value) => edit(editorOf[kind](value))} />;
}
