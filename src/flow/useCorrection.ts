import { useEffect, useEffectEvent, useState } from 'react';
import type { FlowApi, FlowDocView } from '../../shared/business/index';
import { errorMessage } from '../../shared/core/index';
import { emit, useAction } from '../ui/index';
import { keepRows, recoverCorrection } from './correction-recover';
import { commitCorrection, previewCorrection } from './flow-api';
import type { CorrectableKind } from './flow-words';

/** 改完多久没再动就去核验（毫秒） */
const PREVIEW_DELAY = 250;

/** 交给服务端的更正输入：到货、送货、完工各一种（各自的 *-correction.ts 整理） */
type CorrectionBody = FlowApi['POST /flow/:id/correction-preview']['body'];
/** 核验出来的更正影响：按原单的种类各一种（shared/business/flow/flow-correction-views.ts） */
export type CorrectionPreview = FlowApi['POST /flow/:id/correction-preview']['response'];
/** 提交更正的结果（summary 是给页面提示的一句话） */
export type CorrectionResult = FlowApi['POST /flow/:id/correct']['response'];

/** 各种单据的更正内容（ArrivalCorrection 等）拿到的：最新的单据、关窗、办完 */
export type CorrectionPartProps<K extends CorrectableKind> = {
  doc: FlowDocView<K>;
  close: () => void;
  done: (result: CorrectionResult) => void;
  /** 读回这张单据最新的内容（被别人改过时更正窗用它重新核验） */
  refresh: () => Promise<{ version: number }>;
};

/**
 * 更正窗的每一行（到货、送货的明细，完工的领料），patch 改第几行。读回最新的单据以后（lines 换了），
 * 那上面还在的行留着人填的数（keepRows）。
 */
export function useCorrectionRows<R extends { index?: number }>(initial: () => R[], lines: unknown[]) {
  const [rows, setRows] = useState(initial);
  useEffect(() => setRows((l) => keepRows(l, lines)), [lines]);
  const patch = (i: number, value: Partial<R>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...value } : r)));
  return { rows, setRows, patch };
}

/**
 * 更正窗共用的原因、核验和提交：build 按更正原因整理出这次的输入和有没有改东西（各自的 *-correction.ts）。
 * 改好、写了原因（changed 为真、input.reason 不空）就自动核验影响，内容一变就重新核验、换新的请求号。
 * 核验、提交被拒是因为这张单刚被别人改过（版本变了）或核验以后数据变了：读回最新的单据
 * （refresh，输入带上新版本）、重新核验，窗口里说一句（notice），提交按钮等新的核验出来就能点，不卡住。
 * 办完通知业务数据变了，交给 done（结果里的 summary 是给页面提示的一句话）。
 */
export function useCorrection(
  part: Pick<CorrectionPartProps<CorrectableKind>, 'done' | 'refresh'> & { doc: { id: number } },
  build: (reason: string) => { input: CorrectionBody; changed: boolean },
) {
  const [reason, setReason] = useState('');
  const { input, changed } = build(reason);
  const id = part.doc.id,
    inputKey = JSON.stringify(input);
  const [plan, setPlan] = useState<{ preview: CorrectionPreview; inputKey: string } | null>(null),
    [previewing, setPreviewing] = useState(false),
    [problem, setProblem] = useState(''),
    [notice, setNotice] = useState(''),
    // 版本没变、只是关联的数据变了（preview-changed）时，加一就按同样的内容再核验一次
    [round, setRound] = useState(0),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { busy, error, run, clear } = useAction();
  // 重新核验前清掉上一轮的，交出这一轮渲染的输入；clear、refresh 每次渲染都是新函数，所以放在 Effect Event 里，
  // 核验只按内容（inputKey）、单据、改没改、显式再核验（round）重来
  const restart = useEffectEvent(() => {
    setPlan(null);
    setProblem('');
    clear();
    setPreviewing(false);
    setRequestId(crypto.randomUUID());
    return input;
  });
  const recover = useEffectEvent((e: unknown, version: number) => recoverCorrection(e, version, part.refresh));
  useEffect(() => {
    let active = true;
    const body = restart();
    if (!body.reason || !changed) return;
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      previewCorrection(id, body)
        .then((preview) => active && setPlan({ preview, inputKey }))
        .catch(async (e: unknown) => {
          // 打开以后别人改过这张单：读回最新的，输入换了版本自己会再核验
          const recovered = await recover(e, body.expectedVersion).catch(() => null);
          if (recovered) setNotice(recovered.notice);
          else if (active) setProblem(errorMessage(e));
        })
        .finally(() => active && setPreviewing(false));
    }, PREVIEW_DELAY);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [inputKey, id, changed, round]);
  const ready = plan && plan.inputKey === inputKey ? plan.preview : null;
  const submit = () =>
    run(async () => {
      // 提交按钮在核验出来之前点不了
      if (!ready) return;
      setNotice('');
      try {
        const result = await commitCorrection(id, { ...input, previewDigest: ready.previewDigest, requestId });
        emit('erp-business-changed');
        part.done(result);
      } catch (e) {
        const recovered = await recoverCorrection(e, input.expectedVersion, part.refresh);
        if (!recovered) throw e;
        setNotice(recovered.notice);
        setRequestId(crypto.randomUUID());
        if (recovered.repreview) setRound((n) => n + 1);
      }
    });
  return { reason, setReason, plan: ready, previewing, busy, error: error || problem, notice, submit };
}
/** 一个更正窗的原因、核验和提交（交给 CorrectionShell） */
export type Correction = ReturnType<typeof useCorrection>;
