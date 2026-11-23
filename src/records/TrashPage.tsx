import { isFlowKind, type FlowKind } from '../../shared/core/index';
import { lazy } from 'react';
import { recordEntities, type RecordEntity } from '../../shared/business/index';
import KindRecords from './KindRecords';
import type { RecordEditor } from './RecordEditors';
import type { RecordLists } from './useRecordLists';

const FlowPage = lazy(() => import('../flow/FlowPage'));
const OperationsPage = lazy(() => import('./OperationsPage'));

export type FlowTrash = null | FlowKind;
const isRecordEntity = (value: string): value is RecordEntity => (recordEntities as readonly string[]).includes(value);

/** 选的这一类交给谁列：采购库存的几类交给它们自己的页面，订单、客户、产品用这里的列表 */
type TrashView = { operations: 'warehouse' | 'suppliers' | 'purchases' } | { records: 'orders' | 'customers' | 'products' };
function trashView(entity: RecordEntity): TrashView {
  switch (entity) {
    case 'stock_items':
      return { operations: 'warehouse' };
    case 'suppliers':
    case 'purchases':
      return { operations: entity };
    case 'orders':
    case 'customers':
    case 'products':
      return { records: entity };
  }
}

/**
 * 归档页：一个下拉选看哪一类已归档的记录（档案和订单、单据），已归档的可以恢复、编辑或删除。
 * 订单、客户、产品用这里的列表；采购库存的几类和单据交给它们自己的页面（recycle）。
 */
export default function TrashPage({
  lists,
  trashEntity,
  setTrashEntity,
  flowTrash,
  setFlowTrash,
  edit,
  changed,
}: {
  lists: RecordLists;
  trashEntity: RecordEntity;
  setTrashEntity: (entity: RecordEntity) => void;
  flowTrash: FlowTrash;
  setFlowTrash: (kind: FlowTrash) => void;
  edit: (editor: RecordEditor) => void;
  /** 归档、恢复、删除办完：提示一句，列表重读 */
  changed: (message?: string) => void;
}) {
  const view = trashView(trashEntity);
  return (
    <>
      <div className="recycle-heading">
        <p>已归档的记录可以恢复、编辑或删除。</p>
        {/* 10 类对象用一个下拉选，不再摆两排页签 */}
        <label className="recycle-picker">
          <span>查看</span>
          <select
            aria-label="查看哪一类已归档记录"
            value={flowTrash ? 'flow:' + flowTrash : trashEntity}
            onChange={(e) => {
              const v = e.target.value;
              const flowKind = v.slice('flow:'.length);
              if (v.startsWith('flow:') && isFlowKind(flowKind)) setFlowTrash(flowKind);
              else if (isRecordEntity(v)) {
                setTrashEntity(v);
                setFlowTrash(null);
                lists.setSearch('');
              }
            }}
          >
            <optgroup label="档案和订单">
              <option value="orders">订单</option>
              <option value="customers">客户</option>
              <option value="products">产品</option>
              <option value="suppliers">供应商</option>
              <option value="purchases">采购单</option>
              <option value="stock_items">库存品</option>
            </optgroup>
            <optgroup label="单据">
              <option value="flow:arrival">到货</option>
              <option value="flow:task">生产任务</option>
              <option value="flow:production">完工记录</option>
              <option value="flow:delivery">送货</option>
            </optgroup>
          </select>
        </label>
      </div>
      {flowTrash ? (
        <FlowPage key={flowTrash} mode={flowTrash} recycle />
      ) : 'operations' in view ? (
        <OperationsPage key={trashEntity} mode={view.operations} recycle />
      ) : (
        <KindRecords
          key={trashEntity}
          kind={view.records}
          lists={lists}
          archived
          recycle
          edit={edit}
          changed={changed}
        />
      )}
    </>
  );
}
