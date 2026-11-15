import type { FlowKind } from '../../shared/business/index';
import { FormField, FormSection } from '../ui/index';
import TaskForm, { type TaskEditing, type TaskFormData } from './TaskForm';
import ProductionForm, { type ProductionEditing, type ProductionFormData } from './ProductionForm';
import ArrivalForm, { type ArrivalFormData } from './ArrivalForm';
import DeliveryForm from './DeliveryForm';
import type { DeliveryEditing, DeliveryFormData } from './delivery-stock';
import type { ArrivalEditing } from './flow-prefill';

/** 一种单据的表单要的：编辑内容、改了的那几项交给谁、对照的档案（客户、产品、订单、库存品……） */
type FormProps<K extends FlowKind, V, D> = { kind: K; value: V; change: (patch: Partial<V>) => void; data: D };
/** 按单据种类给各自的表单：编辑内容和要对照的档案各表单自己定 */
type EditorProps =
  | FormProps<'delivery', DeliveryEditing, DeliveryFormData>
  | FormProps<'task', TaskEditing, TaskFormData>
  | FormProps<'production', ProductionEditing, ProductionFormData>
  | FormProps<'arrival', ArrivalEditing, ArrivalFormData>;

/** 按单据种类用各自的表单 */
function KindForm(p: EditorProps) {
  switch (p.kind) {
    case 'task':
      return <TaskForm value={p.value} change={p.change} data={p.data} />;
    case 'production':
      return <ProductionForm value={p.value} change={p.change} data={p.data} />;
    case 'arrival':
      return <ArrivalForm value={p.value} change={p.change} data={p.data} />;
    case 'delivery':
      return <DeliveryForm value={p.value} change={p.change} data={p.data} />;
  }
}

/** 单据编辑窗的正文：按单据类型用各自的表单，最后是备注。 */
export function FlowEditor(p: EditorProps) {
  const { kind } = p;
  return (
    <div className="flow-editor">
      <KindForm {...p} />
      <FormSection columns={1}>
        <FormField
          label={kind === 'production' ? '批次备注' : '备注'}
          span="full"
          hint={kind === 'production' ? '会显示在成品库存的批次里' : undefined}
        >
          <textarea
            aria-label={kind === 'production' ? '批次备注' : '整单备注'}
            placeholder={kind === 'production' ? '这批用的什么料、质量怎样' : undefined}
            value={p.value.notes}
            maxLength={2000}
            onChange={(e) => p.change({ notes: e.target.value })}
          />
        </FormField>
      </FormSection>
    </div>
  );
}
