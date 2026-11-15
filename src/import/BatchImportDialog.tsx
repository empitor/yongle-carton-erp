import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../shared/core/index';
import type { ImportPreview } from '../../shared/import/index';
import ImportPlanView from './ImportPlanView';
import { executeImport, previewImport, readWorkspace } from './workspace-api';
import { ManagementDialog, notify, useAction } from '../ui/index';
import { useAuthState } from '../ui/index';
import { EditorFooter, FormMessage } from '../ui/index';
import { StatusChip } from '../ui/index';

/** 一份文件：预览（还没生成是 null）、没办成的原因、导入好的订单号（导入过的也记成导入好的） */
type Row = {
  id: string;
  fileName: string;
  preview: ImportPreview | null;
  error: string;
  receipt: { orderNumber: string } | null;
};

/** 一份文件到了哪一步；settled：同名产品都确认过了 */
function RowState({ row, settled }: { row: Row; settled: boolean }) {
  if (row.receipt) return <StatusChip tone="success">已导入</StatusChip>;
  if (row.error) return <StatusChip tone="danger">没导入</StatusChip>;
  if (row.preview && !settled) return <StatusChip tone="warning">同名产品待确认</StatusChip>;
  if (row.preview) return <StatusChip tone="accent">待导入</StatusChip>;
  return <StatusChip>正在预览</StatusChip>;
}

/**
 * 批量导入客户订单：每份文件一张卡片，显示完整预览；正式提交仍由原导入服务校验。
 * 全部成功就关窗并在底部提示；有失败的留在窗口里，失败原因写在那份文件上。
 */
export default function BatchImportDialog({
  files,
  token,
  close,
  done,
}: {
  files: { id: string; fileName: string }[];
  /** 工作区凭证 */
  token: () => string;
  close: () => void;
  done: () => void;
}) {
  const auth = useAuthState(),
    { busy, run } = useAction(),
    [rows, setRows] = useState<Row[]>(files.map((f) => ({ ...f, preview: null, error: '', receipt: null }))),
    [agreed, setAgreed] = useState(false);
  const local = !!auth?.actor?.localAdministrator;
  /** 一份份读最新版本生成预览；已经导入过的直接记成已导入 */
  const prepareOne = async (file: { id: string }): Promise<Partial<Row>> => {
    try {
      const w = await readWorkspace(file.id);
      if (w.imported && !w.imported.historical)
        return { receipt: { orderNumber: w.imported.orderNumber }, error: '' };
      return { preview: await previewImport(token(), file.id, w.revision), error: '' };
    } catch (e) {
      return { error: errorMessage(e), preview: null };
    }
  };
  const prepare = () =>
    run(async () => {
      setAgreed(false);
      for (const file of files) {
        const row = await prepareOne(file);
        setRows((v) => v.map((r) => (r.id === file.id && !r.receipt ? { ...r, ...row } : r)));
      }
    });
  // 打开窗口时预览一次（“重新预览没成功的”再点）；prepare 每次渲染都是新函数，放进 ref 取最新的
  const latestPrepare = useRef(prepare);
  useEffect(() => {
    latestPrepare.current = prepare;
  });
  useEffect(() => {
    void latestPrepare.current();
  }, []);
  // 每份文件里勾了“是另一个产品”的行；同名产品没确认完的那份先不导
  const [confirmed, setConfirmed] = useState<Record<string, Set<string>>>({});
  const toggle = (fileId: string) => (lineId: string) =>
    setConfirmed((all) => {
      const next = new Set(all[fileId]);
      if (!next.delete(lineId)) next.add(lineId);
      return { ...all, [fileId]: next };
    });
  const settled = (r: Row) => !!r.preview?.plan.confirmations.every((c) => confirmed[r.id]?.has(c.lineId));
  const ready = rows.flatMap((r) => (r.preview && !r.receipt && !r.error && settled(r) ? [{ ...r, preview: r.preview }] : []));
  const execute = async () => {
    let latest = rows;
    await run(async () => {
      for (const row of ready) {
        try {
          const receipt = await executeImport(token(), row.id, row.preview, [...(confirmed[row.id] || [])]);
          latest = latest.map((r) => (r.id === row.id ? { ...r, receipt, error: '' } : r));
        } catch (e) {
          latest = latest.map((r) => (r.id === row.id ? { ...r, error: errorMessage(e) } : r));
        }
        setRows(latest);
      }
    });
    done();
    const numbers = latest.flatMap((r) => (r.receipt ? [r.receipt.orderNumber] : []));
    if (numbers.length === latest.length) {
      close();
      notify('已正式导入 ' + latest.length + ' 份订单：' + numbers.filter(Boolean).join('、'));
    }
  };
  const state = (r: Row) => <RowState row={r} settled={settled(r)} />;
  return (
    <ManagementDialog
      title="批量导入订单"
      subtitle={'共 ' + files.length + ' 份文件，可导入 ' + ready.length + ' 份'}
      size="xl"
      busy={busy}
      close={close}
      footer={
        <EditorFooter
          note={
            !local && (
              <label className="sales-check">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                已核对上面的明细和客户、产品
              </label>
            )
          }
        >
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void prepare()}
          >
            重新预览没成功的
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || (!local && !agreed) || !ready.length}
            onClick={() => void execute()}
          >
            {busy ? '正在导入…' : '导入 ' + ready.length + ' 份订单'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage tone="info">
        已导入的文件不会重复导入；没导入的留在 AI 导入里，改好客户和产品后可以再试。
      </FormMessage>
      {rows.map((r) => (
        <article className="line-card sales-batch-card" key={r.id}>
          <header>
            <strong title={r.fileName}>{r.fileName}</strong>
            {state(r)}
          </header>
          {r.error && <FormMessage>{r.error}</FormMessage>}
          {r.receipt ? (
            <p className="sales-muted">已正式导入 {r.receipt.orderNumber}</p>
          ) : (
            r.preview && <ImportPlanView plan={r.preview.plan} confirmed={confirmed[r.id]} toggle={toggle(r.id)} />
          )}
        </article>
      ))}
    </ManagementDialog>
  );
}
