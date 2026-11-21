import type { Dispatch, SetStateAction } from 'react';
import { ManagementDialog, Loading } from '../ui/index';
import { type FlowKind } from '../../shared/business/index';
import { EditorFooter, FormMessage } from '../ui/index';
import { FlowEditor } from './FlowEditor';
import type { FlowEditing } from './flow-prefill';
import type { CatalogLists } from '../recordkit/catalog-api';

type SetEditor = Dispatch<SetStateAction<FlowEditing | null>>;

/** 标题下面说这张生产任务关联了哪几张订单（订单档案里查单号，查不到写“订单”） */
function orderNumbers(editor: FlowEditing, orders: CatalogLists['orders']) {
  const orderIds = editor.kind === 'task' ? editor.orderIds : undefined;
  if (!orderIds?.length) return undefined;
  return '关联订单 ' + orderIds.map((id) => orders.find((o) => o.id === id)?.number || '订单').join('、');
}

/** 按编辑内容的种类给表单：表单改了的几项并进编辑窗里同一种的单据（窗口关了就不再改） */
function EditingForm({ editor, setEditor, data }: { editor: FlowEditing; setEditor: SetEditor; data: CatalogLists }) {
  switch (editor.kind) {
    case 'delivery':
      return (
        <FlowEditor
          kind="delivery"
          value={editor}
          data={data}
          change={(patch) => setEditor((v) => (v?.kind === 'delivery' ? { ...v, ...patch } : v))}
        />
      );
    case 'task':
      return (
        <FlowEditor
          kind="task"
          value={editor}
          data={data}
          change={(patch) => setEditor((v) => (v?.kind === 'task' ? { ...v, ...patch } : v))}
        />
      );
    case 'production':
      return (
        <FlowEditor
          kind="production"
          value={editor}
          data={data}
          change={(patch) => setEditor((v) => (v?.kind === 'production' ? { ...v, ...patch } : v))}
        />
      );
    case 'arrival':
      return (
        <FlowEditor
          kind="arrival"
          value={editor}
          data={data}
          change={(patch) => setEditor((v) => (v?.kind === 'arrival' ? { ...v, ...patch } : v))}
        />
      );
  }
}

/**
 * 新建、编辑单据的弹窗外壳：标题说清楚是在安排、登记还是编辑，底部说清楚保存后会不会动库存。
 * 生产任务“安排生产”就是正式任务（直接下达）。
 */
export default function FlowEditorDialog({
  kind,
  editor,
  setEditor,
  data,
  ready,
  busy,
  error,
  save,
}: {
  kind: FlowKind;
  editor: FlowEditing;
  setEditor: SetEditor;
  /** 对照的档案：标题用订单单号，其余交给表单 */
  data: CatalogLists;
  ready: boolean;
  busy: boolean;
  error: string;
  save: () => void;
}) {
  const close = () => setEditor(null);
  const disabled = busy || !ready;
  return (
    <ManagementDialog
      title={
        editor.id
          ? {
              delivery: '编辑送货单',
              arrival: '编辑到货单',
              production: '编辑完工单',
              task: '编辑生产任务',
            }[kind]
          : // 新建只剩没有采购单的到货；安排生产、登记完工、安排送货各有自己的窗口
            '登记没有采购单的到货'
      }
      subtitle={orderNumbers(editor, data.orders)}
      size={kind === 'task' ? 'md' : 'xl'}
      close={close}
      busy={busy}
      footer={
        <EditorFooter
          note={
            kind === 'task'
              ? '生产任务不动库存，改好就生效，在排产板上待生产。'
              : kind === 'delivery'
                ? '安排后在送货里待送货，导出送货单时出库。'
                : '登记后待入库，核对入库时才加库存。'
          }
        >
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={disabled} onClick={save}>
            {busy ? '正在保存…' : editor.id ? '保存修改' : '登记到货'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      {!ready ? (
        <Loading what="客户、产品、订单等档案" />
      ) : (
        <EditingForm editor={editor} setEditor={setEditor} data={data} />
      )}
    </ManagementDialog>
  );
}
