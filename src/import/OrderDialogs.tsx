import { useState } from 'react';
import { ManagementDialog } from '../ui/index';
import { EditorFooter, FormMessage } from '../ui/index';
import { Hint } from '../ui/index';
import { Agreement, FileNames } from './ImportDialog';
import type { ImportPreview } from '../../shared/import/index';
import ImportPlanView from './ImportPlanView';
import { ConfirmDialog } from '../ui/index';

/**
 * 归档或永久删除工作区文件。归档（permanent=false）：取消正在进行的识别，原件和识别结果保留，
 * 在“历史与归档”里能恢复；永久删除只给本机管理员，不能恢复。正式的客户、产品和订单都不受影响。
 */
export function DeleteFilesDialog({
  names,
  permanent,
  close,
  confirm,
}: {
  names: (string | undefined)[];
  permanent: boolean;
  close: () => void;
  confirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={(permanent ? '永久删除 ' : '归档 ') + names.length + ' 份文件？'}
      confirmLabel={permanent ? '永久删除' : '归档'}
      danger={permanent}
      close={close}
      onConfirm={confirm}
    >
      <div className="aii-stack">
        <FileNames names={names} />
        <Hint tone={permanent ? 'danger' : 'info'}>
          {permanent
            ? '原件、识别结果和修改历史都会删掉，不能恢复。正式的客户、产品和订单不受影响。'
            : '会取消正在进行的识别；原件和识别结果保留，在“更多 → 历史与归档”里能恢复。正式的客户、产品和订单不受影响。'}
        </Hint>
      </div>
    </ConfirmDialog>
  );
}

/** 正式导入前的预览：客户、订单、每行明细和产品档案怎么处理，金额由程序计算。 */
export function ImportPreviewDialog({
  preview,
  needsAgreement,
  busy,
  error,
  close,
  confirm,
}: {
  preview: ImportPreview;
  needsAgreement: boolean;
  busy: boolean;
  error: string;
  close: () => void;
  confirm: (distinctProducts: string[]) => void;
}) {
  const [agreed, setAgreed] = useState(false),
    [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const plan = preview.plan,
    pending = plan.confirmations.filter((c) => !confirmed.has(c.lineId)).length;
  const toggle = (lineId: string) =>
    setConfirmed((v) => {
      const next = new Set(v);
      if (!next.delete(lineId)) next.add(lineId);
      return next;
    });
  return (
    <ManagementDialog
      title="导入为正式订单"
      subtitle={plan.source.fileName + ' · 第 ' + plan.source.revision + ' 次修改'}
      size="lg"
      busy={busy}
      close={close}
      footer={
        <EditorFooter note={'按明细算出合计 ' + plan.total + ' 元'}>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={(needsAgreement && !agreed) || pending > 0 || busy}
            title={pending ? '还有 ' + pending + ' 行同名产品没确认' : undefined}
            onClick={() => confirm([...confirmed])}
          >
            {busy ? '正在导入…' : '导入订单'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <ImportPlanView plan={plan} confirmed={confirmed} toggle={toggle} />
      {needsAgreement && (
        <div className="aii-dialog-agree">
          <Agreement checked={agreed} onChange={setAgreed} disabled={busy}>
            我已核对明细、客户和产品（含要新建的）、金额和税费，确认按上面导入。
          </Agreement>
        </div>
      )}
    </ManagementDialog>
  );
}
