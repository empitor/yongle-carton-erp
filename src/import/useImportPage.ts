import { useEffect, useState } from 'react';
import { errorMessage, pageParams } from '../../shared/core/index';
import { NO_KEY } from './ImportDialog';
import { fileMode, modeLabels, type FileItem, type FileMode } from './fileStatus';
import { recognizableOrders } from './page-state';
import type { useOrderWorkspace } from './useOrderWorkspace';

type Api = ReturnType<typeof useOrderWorkspace>;
/** 要先问一句的事：确认窗点了才办 */
export type Ask = { title: string; body: string; confirmLabel: string; run: () => void };
const PREVIEW_KEY = 'erp-import-preview';

/** 地址里带 mode=arrival（从到货页跳过来）：新上传的文件按到货单识别。 */
function hashUploadMode(): FileMode {
  return pageParams('ai-import', location.hash).mode === 'arrival' ? 'arrival' : 'order';
}
function readPreviewShown() {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

/** 新上传的文件按哪种类型识别。已经在本页时再点到货页的“AI 识别送货单”只改地址、不重新加载页面：跟着地址换 */
export function useUploadMode() {
  const [uploadMode, setUploadMode] = useState(hashUploadMode);
  useEffect(() => {
    const follow = () => setUploadMode(hashUploadMode());
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);
  return uploadMode;
}

/** 原件预览开不开，记在这台电脑上 */
export function usePreviewShown() {
  const [showPreview, setShowPreview] = useState(readPreviewShown);
  const togglePreview = () =>
    setShowPreview((v) => {
      try {
        localStorage.setItem(PREVIEW_KEY, v ? 'hidden' : 'shown');
      } catch {
        // 这台电脑不让记（隐私模式、存储被禁）：开关照样切，只是下次打开不记得
      }
      return !v;
    });
  return { showPreview, togglePreview };
}

/** 文件列表上勾选的文件：列表变了就去掉不在的；算出能批量识别、批量导入的 */
export function useChecked(files: FileItem[]) {
  const [checked, setChecked] = useState<string[]>([]);
  // 列表里有哪些文件（编号是 UUID，不含逗号）：只在这串变了时去掉勾了但已经不在的
  const listed = files.map((f) => f.id).join(',');
  useEffect(() => {
    const present = new Set(listed.split(','));
    setChecked((c) => c.filter((id) => present.has(id)));
  }, [listed]);
  const pending = recognizableOrders(files);
  return {
    checked,
    setChecked,
    batchTargets: checked.filter((id) => pending.some((f) => f.id === id)),
    importTargets: files.filter(
      (f) => checked.includes(f.id) && fileMode(f) === 'order' && f.hasDraft && !f.imported,
    ),
  };
}

/**
 * 识别、重新识别、改识别类型。没配好模型的先说清楚；会覆盖结果的先问一句（ask）。
 * 到货单交给到货面板：recognizeSignal 加一，面板看到变化就开始。
 */
export function useRecognize(api: Api) {
  const [ask, setAsk] = useState<Ask | null>(null),
    [recognizeSignal, setRecognizeSignal] = useState(0);
  const aiReady = () => {
    if (api.status?.ai.ready) return true;
    api.setFatal(api.status?.ai.message || NO_KEY);
    return false;
  };
  const recognize = (ids: string[]) => {
    if (aiReady()) void api.recognize(ids);
  };
  /** 开始识别 / 重新识别：到货交给到货面板；订单没识别过直接识别，识别过先问一句会覆盖。 */
  const reanalyzeFile = (f: FileItem) => {
    if (!aiReady() || f.imported) return;
    if (fileMode(f) !== 'order') {
      if (f.id !== api.selected) void api.choose(f.id);
      else setRecognizeSignal((n) => n + 1);
      return;
    }
    if (!f.hasDraft) return recognize([f.id]);
    setAsk({
      title: '重新识别这份订单？',
      body: '会覆盖当前识别结果和人工修改，并重新请求 AI。',
      confirmLabel: '重新识别',
      run: () => void api.reanalyze(f.id),
    });
  };
  const switchFilingMode = (f: FileItem, mode: FileMode) => {
    if (fileMode(f) === mode) return;
    setAsk({
      title: '改为按' + modeLabels[mode] + '识别？',
      body: '已保存的识别结果和关联会保留，没保存的内容会丢弃。',
      confirmLabel: '改为' + modeLabels[mode],
      run: () =>
        void api.setMode(f.id, mode).catch((e: unknown) => {
          api.setFatal(errorMessage(e));
        }),
    });
  };
  return { ask, closeAsk: () => setAsk(null), recognizeSignal, recognize, reanalyzeFile, switchFilingMode };
}
