import { isFlowKind } from '../../shared/core/index';
import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { dataManagementFieldName } from '../../shared/business/index';
import type { DataAction, ListedRecord } from './record-types';

/**
 * 批量修改能改的几项：备注都能改，订单、采购单还有日期和状态；单据的业务日期只对还没核对的
 * （已生效的改日期走“更正××单”，服务端也会拒）
 */
const batchFields = (module: string, chosen: ListedRecord[]) => [
  'notes',
  ...(module === 'orders'
    ? ['orderDate', 'deliveryDate', 'status']
    : module === 'purchases'
      ? ['orderDate', 'expectedDate', 'status']
      : isFlowKind(module) && chosen.every((r) => r.record.status === 'draft')
        ? ['date']
        : []),
];

/**
 * 选中几条以后出现的一排操作：归档、恢复、批量修改、删除、取消选择；
 * 点了“批量修改”下面再出一行：选字段、填新值，“核对并批量保存”先弹确认窗（由数据管理窗口弹）。
 */
export default function BulkBar({
  module,
  chosen,
  busy,
  act,
  remove,
  clear,
  batch,
  setBatch,
  confirmBatch,
}: {
  module: string;
  chosen: ListedRecord[];
  busy: boolean;
  act: (action: DataAction, rows: ListedRecord[]) => void;
  /** 删除选中的：业务记录先看影响清单，AI 识别文件先确认 */
  remove: (rows: ListedRecord[]) => void;
  clear: () => void;
  /** “批量修改”那一行开没开：办完一件事由数据管理窗口收起 */
  batch: boolean;
  setBatch: (open: boolean) => void;
  confirmBatch: (patch: Record<string, string>) => void;
}) {
  // 选的字段和填的值：没选中记录时这一排不显示，但留着上次填的
  const [batchKey, setBatchKey] = useState('notes'),
    [batchValue, setBatchValue] = useState('');
  if (!chosen.length) return null;
  return (
    <>
      <div className="adm-data-bulk">
        <strong>已选 {chosen.length} 条</strong>
        <button className="secondary" disabled={busy} onClick={() => act('archive', chosen)}>
          归档
        </button>
        <button className="secondary" disabled={busy} onClick={() => act('restore', chosen)}>
          <RotateCcw size={14} aria-hidden="true" />
          恢复
        </button>
        {module !== 'workspaces' && (
          <button className="secondary" aria-pressed={batch} onClick={() => setBatch(!batch)}>
            批量修改
          </button>
        )}
        <button className="danger" disabled={busy} onClick={() => remove(chosen)}>
          <Trash2 size={14} aria-hidden="true" />
          删除
        </button>
        <button className="adm-data-clear" onClick={clear}>
          取消选择
        </button>
      </div>
      {batch && (
        <div className="adm-data-batch">
          <span>把选中的记录的</span>
          <select
            aria-label="批量修改字段"
            value={batchKey}
            onChange={(e) => setBatchKey(e.target.value)}
          >
            {batchFields(module, chosen).map((k) => (
              <option key={k} value={k}>
                {dataManagementFieldName(k, '', module)}
              </option>
            ))}
          </select>
          <span>改为</span>
          <input
            aria-label="批量修改值"
            value={batchValue}
            onChange={(e) => setBatchValue(e.target.value)}
          />
          <button className="primary" onClick={() => confirmBatch({ [batchKey]: batchValue })}>
            核对并批量保存
          </button>
        </div>
      )}
    </>
  );
}
