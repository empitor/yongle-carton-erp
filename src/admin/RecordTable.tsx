import { MoreMenu, SelectAll, SelectRow, StatusChip } from '../ui/index';
import { isFlowKind } from '../../shared/business/index';
import { recordLabel, recordStatus } from './record-refs';
import { textOf, type DataAction, type ListedRecord } from './record-types';


/**
 * 数据管理的记录列表：每行勾选框、单号或名称（下面小字是客户或供应商）、状态，最常用的“编辑”放在外面，
 * 其余收进“更多”。AI 识别工作区的“编辑”是去识别页打开它，另有复制和删除。
 * 行不能点开（操作都在行尾按钮上），是窗口里的方框小表，不套列表的 DataTable；勾选框用它同一套（SelectAll、SelectRow）。
 */
export default function RecordTable({
  module,
  loaded,
  rows,
  selected,
  setSelected,
  busy,
  act,
  edit,
  editable,
  remove,
  extra,
  openWorkspace,
}: {
  module: string;
  /** 列表读到了没有：读到了还没有匹配的才说“没有匹配的记录” */
  loaded: boolean;
  /** 按搜索筛过的那些 */
  rows: ListedRecord[];
  selected: (number | string)[];
  setSelected: (next: (number | string)[]) => void;
  busy: boolean;
  /** 直接办的动作（归档、恢复、确认单据、复制为新识别任务） */
  act: (action: DataAction, rows: ListedRecord[]) => void;
  /** 打开编辑窗 */
  edit: (row: ListedRecord) => void;
  /** 这一行能不能编辑（已撤销、已取消、已被更正替代的单据不能） */
  editable: (row: ListedRecord) => boolean;
  /** 删除：业务记录先看影响清单，AI 识别文件先确认 */
  remove: (row: ListedRecord) => void;
  /** 这一行“更多”里另有的动作（库存品的出入库 / 盘点、已入库到货单的更正），和业务页面同一个窗口 */
  extra: (row: ListedRecord) => { label: string; run: () => void }[];
  openWorkspace: (id: string) => void;
}) {
  const status = (r: ListedRecord) =>
    r.record.archived ? (
      <StatusChip>已归档</StatusChip>
    ) : (
      <span>{recordStatus(module, r.record)}</span>
    );
  const archiveItem = (r: ListedRecord) => (
    <button
      role="menuitem"
      disabled={busy}
      onClick={() => act(r.record.archived ? 'restore' : 'archive', [r])}
    >
      {r.record.archived ? '恢复' : '归档'}
    </button>
  );
  const removeItem = (r: ListedRecord) => (
    <button role="menuitem" className="danger-text" disabled={busy} onClick={() => remove(r)}>
      删除
    </button>
  );
  return (
    <div className="adm-data-table">
      <table>
        <thead>
          <tr>
            <th>
              <SelectAll
                keys={rows.map((x) => x.record.id)}
                selected={selected}
                set={setSelected}
                label="全选数据管理筛选结果"
              />
            </th>
            <th>记录</th>
            <th>状态</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.record.id} className={selected.includes(r.record.id) ? 'selected' : ''}>
              <td>
                <SelectRow
                  value={r.record.id}
                  selected={selected}
                  set={setSelected}
                  label={'选择 ' + recordLabel(r.record)}
                />
              </td>
              <td>
                {/* 单号或名称，下面小字是客户或供应商；内部编号不摆在每行，排查问题时在编辑窗最下面看 */}
                <strong>{recordLabel(r.record)}</strong>
                {(textOf(r.record.customerName) || textOf(r.record.supplierName)) && (
                  <small>{textOf(r.record.customerName) || textOf(r.record.supplierName)}</small>
                )}
              </td>
              <td>{status(r)}</td>
              <td>
                <div className="adm-data-actions">
                  {module === 'workspaces' ? (
                    <>
                      <button className="secondary" onClick={() => openWorkspace(String(r.record.id))}>
                        编辑
                      </button>
                      <MoreMenu label={'更多操作 ' + recordLabel(r.record)}>
                        {archiveItem(r)}
                        <button
                          role="menuitem"
                          disabled={busy || !!r.record.archived}
                          onClick={() => act('fork', [r])}
                        >
                          复制为新识别任务
                        </button>
                        {removeItem(r)}
                      </MoreMenu>
                    </>
                  ) : (
                    <>
                      {isFlowKind(module) && r.record.status === 'draft' && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => act('confirm', [r])}
                        >
                          确认单据
                        </button>
                      )}
                      {editable(r) && (
                        <button className="secondary" disabled={busy} onClick={() => edit(r)}>
                          编辑
                        </button>
                      )}
                      <MoreMenu label={'更多操作 ' + recordLabel(r.record)}>
                        {extra(r).map((a) => (
                          <button key={a.label} role="menuitem" disabled={busy} onClick={a.run}>
                            {a.label}
                          </button>
                        ))}
                        {archiveItem(r)}
                        {removeItem(r)}
                      </MoreMenu>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loaded && !rows.length && <p className="adm-data-empty">没有匹配的记录</p>}
    </div>
  );
}
