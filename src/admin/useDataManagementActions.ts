import { useRef, useState } from 'react';
import { errorMessage, pageHref, type ApiJson } from '../../shared/core/index';
import { emit, useSlots } from '../ui/index';
import { dataManagementCommand, executeCommand, forkWorkspaces } from './data-api';
import { recordLabel } from './record-refs';
import {
  businessRows,
  isJsonObject,
  isWorkspaceOnly,
  managedModule,
  textOf,
  type DataAction,
  type ListedRecord,
} from './record-types';

/** 操作做完的提示：按动作说，不说“服务器实际结果”这种开发口径的话 */
const doneVerb: Partial<Record<DataAction, string>> = {
  create: '已新建',
  update: '已保存',
  archive: '已归档',
  restore: '已恢复',
  confirm: '已确认',
  delete: '已删除',
  fork: '已复制为新识别任务',
};

const missingWorkspaceFiles = {
  change: () => Promise.reject(new Error('识别文件入口没有装上，请刷新页面后重试。')),
};
/** 识别文件的归档、恢复、删除和 AI 导入页走同一个地址 */
const workspaceChanges = ['archive', 'restore', 'delete'] as const;
const isWorkspaceChange = (action: DataAction) => workspaceChanges.find((a) => a === action);
/** 办完的结果：办了几条（服务端给了就按它）、逐条的结果 */
type Outcome = { count?: number; results: readonly ApiJson[] };
/** 逐条结果里没办成的那条：哪条、为什么 */
const failureOf = (x: ApiJson): { id: ApiJson | undefined; message: string }[] =>
  isJsonObject(x) && x.success === false ? [{ id: x.id, message: textOf(x.message) }] : [];
/** 复制成功时新识别任务的编号（第一条的结果） */
const forkedId = (first: ApiJson | undefined) =>
  isJsonObject(first) && first.success && isJsonObject(first.result) ? textOf(first.result.id) : '';

/**
 * 数据管理里办一件事：新建、保存、归档、恢复、确认、删除识别文件、复制识别文件。
 * 同一件事重试时用同一个 requestId（服务端不会办两遍）；部分没办成的逐条说原因。
 * 办成后 settle 收起编辑窗、选择和确认窗，再重读列表；复制识别文件成功就关窗、打开新任务。
 */
export function useDataManagementActions(
  module: string,
  records: ListedRecord[],
  load: () => Promise<void>,
  settle: () => void,
  close: () => void,
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const submission = useRef<{ key: string; id: string } | null>(null);
  const workspaceFiles = useSlots().workspaceFiles ?? missingWorkspaceFiles;
  const labelOf = (id: ApiJson | undefined) =>
    recordLabel(records.find((r) => String(r.record.id) === String(id))?.record);
  function send(action: DataAction, rows: ListedRecord[], patch: Record<string, unknown>): Promise<Outcome> {
    const items = rows.map((x) => ({ id: x.record.id, version: x.record.version }));
    const key = JSON.stringify({ module, action, rows: items, patch });
    if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
    const requestId = submission.current.id;
    const change = isWorkspaceChange(action);
    if (module === 'workspaces' && change)
      return workspaceFiles.change(change, items.map((i) => ({ id: String(i.id), version: i.version })));
    if (module === 'workspaces')
      return forkWorkspaces(
        items.map((i) => ({ id: String(i.id), revision: i.version })),
        requestId,
      );
    // 业务记录的删除打开删除窗（DataManagementEditor 的 remove），不经这里
    if (isWorkspaceOnly(action)) throw new Error('只有识别文件能在这里复制或删除，请刷新后重试。');
    const records = businessRows(rows).map(({ record }) => ({ id: record.id, version: record.version }));
    return executeCommand(dataManagementCommand({ requestId, module: managedModule(module), action, items: records, patch }));
  }
  async function act(action: DataAction, rows: ListedRecord[], patch: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await send(action, rows, patch);
      const failed = result.results.flatMap(failureOf);
      if (failed.length) setError(failed.map((x) => labelOf(x.id) + '：' + x.message).join('；'));
      setMessage(
        failed.length
          ? '部分记录没办成，原因见上面。'
          : (doneVerb[action] || '已办好') + ' ' + (result.count ?? result.results.length) + ' 条。',
      );
      const forked = module === 'workspaces' && action === 'fork' ? forkedId(result.results[0]) : '';
      if (forked) {
        location.hash = pageHref('ai-import', { workspace: forked });
        close();
      }
      emit('erp-business-changed');
      settle();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  /** 别的窗口（到货单编辑、更正、出入库、删除）办完：提示、重读列表；删除的（settled）还要收起选择 */
  const finished = (text: string, settled = false) => {
    if (settled) settle();
    setMessage(text);
    emit('erp-business-changed');
    void load();
  };
  return { busy, error, setError, message, setMessage, act, finished };
}
