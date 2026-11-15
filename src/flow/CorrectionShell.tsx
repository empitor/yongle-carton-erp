import type { ReactNode } from 'react';
import { EditorFooter, FormField, FormMessage, FormSection, Hint, ManagementDialog } from '../ui/index';
import { flowDocNames } from '../../shared/business/index';
import CorrectionImpact from './CorrectionImpact';
import { correctLabel, type CorrectableKind } from './flow-words';
import type { Correction } from './useCorrection';

/**
 * 更正窗的外壳：标题、单据是哪张、“整张没发生用撤销”的提示、各种单据自己的几栏（children）、
 * 更正原因、核验出来的影响、底栏（取消 / 提交更正）。原因、核验和提交在 useCorrection（correction）。
 */
export default function CorrectionShell(o: {
  kind: CorrectableKind;
  subtitle: string;
  hint: string;
  placeholder: string;
  correction: Correction;
  /** 窗口要对照的档案没读到时的那句 */
  loadError: string;
  close: () => void;
  children: ReactNode;
}) {
  const c = o.correction;
  return (
    <ManagementDialog
      title={correctLabel(o.kind)}
      subtitle={o.subtitle}
      size="lg"
      close={o.close}
      busy={c.busy}
      footer={
        <EditorFooter
          note={
            <span role="status">
              {c.previewing
                ? '正在核验更正影响…'
                : c.plan
                  ? '核对下面的影响，无误后提交。'
                  : '改好、写明原因后自动核验影响；提交后撤销原单，另出一张更正后的' + flowDocNames[o.kind] + '。'}
            </span>
          }
        >
          <button type="button" className="secondary" disabled={c.busy} onClick={o.close}>
            取消
          </button>
          <button type="button" className="primary" disabled={c.busy || c.previewing || !c.plan} onClick={() => void c.submit()}>
            {c.busy ? '正在更正…' : '提交更正'}
          </button>
        </EditorFooter>
      }
    >
      <div className="wh-correction">
        <Hint tone="info">{o.hint}</Hint>
        <FormMessage>{c.error || o.loadError}</FormMessage>
        {/* 单据刚被改过、已按最新的重新核验时的那句 */}
        <FormMessage tone="warning">{c.notice}</FormMessage>
        {o.children}
        <FormSection title="为什么改" columns={1}>
          <FormField label="更正原因" required>
            <textarea
              aria-label="更正原因"
              value={c.reason}
              disabled={c.busy}
              maxLength={1000}
              onChange={(e) => c.setReason(e.currentTarget.value)}
              placeholder={o.placeholder}
            />
          </FormField>
        </FormSection>
        {c.plan && <CorrectionImpact plan={c.plan} />}
      </div>
    </ManagementDialog>
  );
}
