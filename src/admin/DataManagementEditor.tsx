import { useEffect, useState } from 'react';
import { errorMessage, pageHref } from '../../shared/core/index';
import { FormMessage, ManagementDialog } from '../ui/index';
import { RecordInputError, editableInput, submittedInput, valueAt } from './record-input';
import type { RecordRefs } from './record-refs';
import { type BusinessRecord, type DataAction, type JsonObject, type ListedRecord } from './record-types';
import DataResetPanel from './DataResetPanel';
import DataManagementRecordDialog from './DataManagementRecordDialog';
import RecordTable from './RecordTable';
import BulkBar from './BulkBar';
import DataManagementToolbar from './DataManagementToolbar';
import { BatchUpdateDialog, RemoveWorkspacesDialog } from './ConfirmActions';
import LinkedDialogs, { editable, linkedDelete, linkedEdit, linkedExtra, type Linked } from './LinkedDialogs';
import { useRecordList } from './useRecordList';
import { useDataManagementActions } from './useDataManagementActions';

/**
 * 本机数据管理：上面选模块和搜索，中间是记录列表（编辑最常用，其余收进每行的“更多”），
 * 选中多条时出现批量操作。编辑在单独的窗口里做；最下面是初始化业务数据。办事在 useDataManagementActions。
 */
export default function DataManagementEditor({
  close,
  initialModule = 'orders',
}: {
  close: () => void;
  initialModule?: string;
}) {
  const [module, setModule] = useState(initialModule),
    [selected, setSelected] = useState<(number | string)[]>([]),
    [editing, setEditing] = useState<BusinessRecord | null>(null),
    [input, setInput] = useState<JsonObject | null>(null),
    [q, setQ] = useState(''),
    [ask, setAsk] = useState<{ rows: ListedRecord[]; patch: Record<string, string> } | null>(null),
    // 要删的 AI 识别文件：先弹确认窗说清删了就没了
    [removing, setRemoving] = useState<ListedRecord[] | null>(null),
    [batch, setBatch] = useState(false),
    [linked, setLinked] = useState<Linked | null>(null);
  // 读列表失败的原因和办事的原因写在同一处（actions 在下面建，读列表的回调是渲染以后才调的）
  const { loaded, template, records, refs, load } = useRecordList(module, !!input, (text) => actions.setError(text));
  // 办成一件事以后：收起编辑窗、选择、确认窗和批量修改那一行
  const settle = () => {
    setInput(null);
    setEditing(null);
    setAsk(null);
    setRemoving(null);
    setSelected([]);
    setBatch(false);
  };
  const actions = useDataManagementActions(module, records, load, settle, close);
  const { busy, error, setError, setMessage } = actions;
  // 换模块：收起选择、编辑窗、搜索和提示（setError、setMessage 是状态的设置函数，不会变，只在换模块时跑）
  useEffect(() => {
    setSelected([]);
    setInput(null);
    setEditing(null);
    setQ('');
    setAsk(null);
    setError('');
    setMessage('');
  }, [module, setError, setMessage]);
  const filtered = records.filter((r) =>
    JSON.stringify([r.record.name, r.record.number, r.record.customerName, r.record.supplierName, r.record.id])
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  const chosen = records.filter((r) => selected.includes(r.record.id));
  const act = (action: DataAction, rows: ListedRecord[]) => void actions.act(action, rows);
  // 删除：业务记录打开业务页面同一个删除窗（先看影响清单），AI 识别文件先确认（删了就没了）
  const remove = (rows: ListedRecord[]) => {
    const deletion = linkedDelete(module, rows);
    if (deletion) setLinked(deletion);
    else setRemoving(rows);
  };
  // 编辑、删除、更正、批量修改这些窗口打开时只显示它，不叠在“业务数据管理”上面；关掉回到列表
  const sub =
    linked ? (
      <LinkedDialogs linked={linked} close={() => setLinked(null)} finished={actions.finished} />
    ) : input ? (
      <EditWindow
        module={module}
        editing={editing}
        input={input}
        setInput={setInput}
        busy={busy}
        error={error}
        setError={actions.setError}
        refs={refs}
        close={() => {
          setInput(null);
          setEditing(null);
          actions.setError('');
        }}
        submit={(patch) => void actions.act(editing ? 'update' : 'create', editing ? [editing] : [], patch)}
      />
    ) : removing ? (
      <RemoveWorkspacesDialog
        rows={removing}
        busy={busy}
        error={error}
        close={() => setRemoving(null)}
        confirm={() => void actions.act('delete', removing)}
      />
    ) : ask ? (
      <BatchUpdateDialog
        module={module}
        rows={ask.rows}
        patch={ask.patch}
        busy={busy}
        error={error}
        close={() => setAsk(null)}
        confirm={() => void actions.act('update', ask.rows, ask.patch)}
      />
    ) : null;
  if (sub) return sub;
  return (
    <ManagementDialog title="业务数据管理" size="xl" close={close} busy={busy}>
      <div className="adm-data">
        <FormMessage>{error}</FormMessage>
        <FormMessage tone="info">{actions.message}</FormMessage>
        <DataManagementToolbar
          module={module}
          setModule={setModule}
          q={q}
          setQ={setQ}
          count={loaded ? { shown: filtered.length, total: records.length } : null}
          busy={busy}
          reload={() => void load()}
          create={
            template &&
            (() => {
              setInput(editableInput(module, template));
              setEditing(null);
            })
          }
        />
        <BulkBar
          module={module}
          chosen={chosen}
          busy={busy}
          act={act}
          remove={remove}
          clear={() => setSelected([])}
          batch={batch}
          setBatch={setBatch}
          confirmBatch={(patch) => setAsk({ rows: chosen, patch })}
        />
        <RecordTable
          module={module}
          loaded={loaded}
          rows={filtered}
          selected={selected}
          setSelected={setSelected}
          busy={busy}
          act={act}
          edit={(r) => {
            const other = linkedEdit(module, r);
            if (other) return setLinked(other);
            // 识别文件没有编辑窗（它的“编辑”是去识别页打开），只有业务记录带编辑窗用的内容
            if (!r.input) return;
            setEditing(r);
            setInput(editableInput(module, r.input));
          }}
          editable={(r) => editable(module, r)}
          remove={(r) => remove([r])}
          extra={(r) => linkedExtra(module, r).map((x) => ({ label: x.label, run: () => setLinked(x.linked) }))}
          openWorkspace={(id) => {
            location.hash = pageHref('ai-import', { workspace: id });
            close();
          }}
        />
        <DataResetPanel />
      </div>
    </ManagementDialog>
  );
}

/**
 * 新建、编辑一条记录的窗口。填得不对的那几格（按字段路径）原因写在那一格下面（编辑窗把光标放过去），顶上不再重复一遍；
 * 改过的那一格不再标错，别的格照旧。都填对了才交给 submit。
 */
function EditWindow({
  module,
  editing,
  input,
  setInput,
  error,
  setError,
  submit,
  ...rest
}: {
  module: string;
  editing: BusinessRecord | null;
  input: JsonObject;
  setInput: (input: JsonObject) => void;
  busy: boolean;
  error: string;
  setError: (message: string) => void;
  refs: RecordRefs | null;
  close: () => void;
  submit: (patch: JsonObject) => void;
}) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  function save() {
    let patch;
    try {
      patch = submittedInput(module, input, editing?.input);
    } catch (e) {
      if (e instanceof RecordInputError) {
        setError('');
        setFieldErrors(e.fields);
      } else setError(errorMessage(e));
      return;
    }
    setFieldErrors({});
    submit(patch);
  }
  return (
    <DataManagementRecordDialog
      {...rest}
      module={module}
      editing={editing}
      input={input}
      setInput={(next: JsonObject) => {
        setInput(next);
        setFieldErrors((errors) => {
          const kept = Object.fromEntries(
            Object.entries(errors).filter(([path]) => valueAt(next, path) === valueAt(input, path)),
          );
          return Object.keys(kept).length === Object.keys(errors).length ? errors : kept;
        });
      }}
      error={error}
      fieldErrors={fieldErrors}
      save={save}
    />
  );
}